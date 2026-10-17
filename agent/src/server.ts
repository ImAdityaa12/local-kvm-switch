// Local control channel for the dashboard. Loopback only, origin-checked,
// token-authenticated, size-capped and rate-limited.

import { createServer, type Server } from "node:http";
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
}

function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token bucket: true when the message may proceed. */
export function makeRateLimiter(burst = RATE_BURST, perSec = RATE_PER_SEC, now: () => number = Date.now) {
  let tokens = burst;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function startControlServer(opts: ServerOptions): Promise<Server> {
  const http = createServer((_req, res) => {
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
  const allow = makeRateLimiter();
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
      if (!(e instanceof EngineError)) console.error("[agent] command failed", e);
      send({ type: "ack", id: msg.id, ok: false, error });
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribe?.();
  });
}
