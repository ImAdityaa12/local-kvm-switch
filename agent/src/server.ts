// Local control channel for the dashboard. Loopback only, origin-checked,
// token-authenticated, size-capped and rate-limited.

import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "../../lib/protocol/index.ts";
import { EngineError } from "./engines.ts";
import type { Controller } from "./controller.ts";
import { makeRateLimiter } from "./rate-limit.ts";
import { remoteLog } from "./remote-log.ts";

export { makeRateLimiter };
import type { Store } from "./store.ts";

export const CONTROL_PATH = "/control";
const HELLO_TIMEOUT_MS = 3_000;
const RATE_BURST = 20;
const RATE_PER_SEC = 10;
const STATE_MIN_INTERVAL_MS = 50;

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  allowedOrigins: string[];
  store: Store;
  controller: Controller;
  /** Deskflow's enter/exit commands report here (see agent/notify.mjs). */
  notify?: { token: string; onEvent(event: "enter" | "leave"): void };
  /** The built dashboard (next build → out/), served at / so no Next.js server has to run. */
  staticDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Files only, never outside `dir`; "/" is index.html and "/x" may be x.html. The page holds no secrets: the token arrives in the URL fragment. */
async function serveStatic(dir: string, pathname: string, res: ServerResponse, head: boolean): Promise<void> {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  } catch {
    return void res.writeHead(400).end();
  }
  if (rel.split(sep).includes("..")) return void res.writeHead(404).end();
  for (const candidate of rel === "" || rel === "." ? ["index.html"] : [rel, `${rel}.html`]) {
    const file = join(dir, candidate);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        // Hashed build assets never change; pages are re-read so a new build shows at once.
        "Cache-Control": candidate.startsWith(`_next${sep}static`) ? "public, max-age=31536000, immutable" : "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      return void res.end(head ? undefined : body);
    } catch {
      // try the next candidate
    }
  }
  res.writeHead(404).end();
}

function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startControlServer(opts: ServerOptions): Promise<Server> {
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const n = opts.notify;
    // Browsers always send Origin on cross-site POSTs; the notifier never does.
    if (n && req.method === "POST" && url.pathname === "/notify" && !req.headers.origin) {
      const given = String(req.headers["x-lan-kvm-notify"] ?? "");
      if (!tokensMatch(given, n.token)) return void res.writeHead(403).end();
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        body += c;
        if (body.length > 16) req.destroy();
      });
      req.on("end", () => {
        if (body === "enter" || body === "leave") {
          n.onEvent(body);
          res.writeHead(204).end();
        } else res.writeHead(400).end();
      });
      return;
    }
    if (opts.staticDir && (req.method === "GET" || req.method === "HEAD") && url.pathname !== CONTROL_PATH) {
      return void serveStatic(opts.staticDir, url.pathname, res, req.method === "HEAD");
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });

  http.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin ?? "";
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CONTROL_PATH || !opts.allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, opts));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      http.off("error", reject);
      resolve(http);
    });
  });
}

function serve(ws: WebSocket, opts: ServerOptions): void {
  const { store, controller } = opts;
  const allow = makeRateLimiter(RATE_BURST, RATE_PER_SEC);
  let authed = false;
  let unsubscribe: (() => void) | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = 0;

  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const close = (reason: string) => {
    send({ type: "goodbye", reason });
    ws.close(1008, reason);
  };

  const pushState = () => {
    flushTimer = null;
    lastSent = Date.now();
    send({ type: "state", seq: store.seq, state: store.state });
  };
  // Coalesce bursts (level meters update often) into at most one push per interval.
  const scheduleState = () => {
    if (flushTimer) return;
    const wait = Math.max(0, STATE_MIN_INTERVAL_MS - (Date.now() - lastSent));
    flushTimer = setTimeout(pushState, wait);
  };

  const helloTimer = setTimeout(() => close("hello timeout"), HELLO_TIMEOUT_MS);

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return close("binary not accepted");
    if (!allow()) return close("rate limit");
    const parsed = parseClientMessage(data.toString());
    if (!parsed.ok) {
      if (!authed) return close("bad hello");
      return send({ type: "ack", id: "?", ok: false, error: { code: "bad-request", message: parsed.reason } });
    }
    const msg = parsed.value;

    if (!authed) {
      if (msg.type !== "hello" || !tokensMatch(msg.token, opts.token)) return close("unauthorized");
      if (msg.protocol !== PROTOCOL_VERSION) return close(`protocol ${PROTOCOL_VERSION} required`);
      clearTimeout(helloTimer);
      authed = true;
      send({ type: "welcome", protocol: PROTOCOL_VERSION });
      pushState();
      unsubscribe = store.subscribe(scheduleState);
      return;
    }

    if (msg.type !== "command") return;
    try {
      await controller.handle(msg.command);
      send({ type: "ack", id: msg.id, ok: true });
    } catch (e) {
      const error =
        e instanceof EngineError ? e.detail : { code: "internal" as const, message: "Unexpected agent error" };
      if (!(e instanceof EngineError)) {
        console.error("[agent] command failed", e);
        remoteLog.write("crash", "error", `Command ${msg.command.type} failed: ${(e as Error)?.stack ?? String(e)}`);
      }
      send({ type: "ack", id: msg.id, ok: false, error });
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribe?.();
  });
}
