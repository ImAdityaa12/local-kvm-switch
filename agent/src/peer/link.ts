// The authenticated link between the two agents.
//
// TLS 1.2 with a pre-shared key from pairing (ECDHE-PSK-CHACHA20-POLY1305):
// mutual authentication and forward secrecy from a reviewed protocol, with no
// certificates. The gaming PC listens; the laptop dials.
//
// Besides control messages, the laptop can open tunnels: each one is its own
// PSK-authenticated TLS connection whose first frame names the target, after
// which bytes are piped to a loopback port on the gaming PC. Deskflow runs
// over these tunnels, so its port is never exposed to the network.

import net from "node:net";
import tls from "node:tls";
import type { AgentError, InputEngineStatus, Machine } from "../../../lib/protocol/index.ts";
import { EngineError } from "../engines.ts";
import { makeRateLimiter } from "../rate-limit.ts";
import { frameChannel, type FrameChannel } from "./frames.ts";
import type { TrustedPeer } from "./trust.ts";

export const LINK_PORT = 47821;
const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";
const TLS_OPTS = { ciphers: CIPHERS, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
const HEARTBEAT_MS = 2_000;
const DEAD_AFTER_MS = 6_500;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 10_000;

export type PeerRequest =
  | { op: "input.prepare" }
  | { op: "input.release" }
  | { op: "audio.start"; route: "laptopToPc" }
  | { op: "audio.stop"; route: "laptopToPc" };
export type PeerEvent = { op: "input.status"; engine: InputEngineStatus; connected: boolean; entered: boolean };

export interface LinkOptions {
  machine: Machine;
  name: string;
  version: string;
  trust: () => TrustedPeer | null;
  /** Gaming PC: address to listen on. */
  bind?: string;
  port?: number;
  /** Gaming PC: loopback ports reachable through tunnels, by name. */
  tunnelTargets?: Record<string, number>;
  /** Laptop: local loopback listeners that tunnel to a named target on the gaming PC. */
  tunnelListeners?: { name: string; localPort: number }[];
  onLink(online: boolean, info: { name?: string; address?: string; error?: AgentError }): void;
  /** Any authenticated message arrived (heartbeats included). */
  onHeard?(): void;
  onRequest(req: PeerRequest): Promise<void>;
  onEvent(evt: PeerEvent): void;
}

const UNREACHABLE: AgentError = {
  code: "peer-unreachable",
  message: "No reply from the other agent",
  hint: "Check that it is running and on the same network, and that Windows Firewall allows it on private networks.",
};

function parseRequest(m: Record<string, unknown>): PeerRequest | null {
  const body = m.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return null;
  if (body.op === "input.prepare" || body.op === "input.release") return { op: body.op };
  if ((body.op === "audio.start" || body.op === "audio.stop") && body.route === "laptopToPc") return { op: body.op, route: body.route };
  return null;
}

function parseEvent(m: Record<string, unknown>): PeerEvent | null {
  const b = m.body as Record<string, unknown> | undefined;
  if (!b || b.op !== "input.status") return null;
  const engines: InputEngineStatus[] = ["stopped", "starting", "running", "stopping", "error"];
  if (!engines.includes(b.engine as InputEngineStatus) || typeof b.connected !== "boolean" || typeof b.entered !== "boolean") return null;
  return { op: "input.status", engine: b.engine as InputEngineStatus, connected: b.connected, entered: b.entered };
}

class ControlSession {
  readonly ch: FrameChannel;
  readonly sock: tls.TLSSocket;
  peerName: string | null = null;
  #lastHeard = Date.now();
  #timer: ReturnType<typeof setInterval>;
  #n = 0;

  constructor(sock: tls.TLSSocket, ch: FrameChannel, onDead: () => void) {
    this.sock = sock;
    this.ch = ch;
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastHeard > DEAD_AFTER_MS) {
        onDead();
        return;
      }
      ch.send({ t: "ping", n: ++this.#n });
    }, HEARTBEAT_MS);
  }

  heard(): void {
    this.#lastHeard = Date.now();
  }

  close(): void {
    clearInterval(this.#timer);
    this.sock.destroy();
  }
}

export class PeerLink {
  #o: LinkOptions;
  #server: tls.Server | null = null;
  #tunnelServers: net.Server[] = [];
  #session: ControlSession | null = null;
  #pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #seq = 0;
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;

  constructor(opts: LinkOptions) {
    this.#o = opts;
  }

  get online(): boolean {
    return this.#session?.peerName != null;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    if (this.#o.machine === "gaming-pc") await this.#listen();
    else {
      for (const t of this.#o.tunnelListeners ?? []) await this.#listenTunnel(t.name, t.localPort);
      this.#dial();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#dropSession();
    await Promise.all([
      new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r())),
      ...this.#tunnelServers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    ]);
    this.#server = null;
    this.#tunnelServers = [];
  }

  /** Drop the current connection, e.g. after the peer was unpaired, and dial again if we are the laptop. */
  reset(): void {
    this.#dropSession();
    if (this.#o.machine === "laptop" && !this.#stopped) this.#scheduleDial(0);
  }

  request(req: PeerRequest): Promise<void> {
    const s = this.#session;
    if (!s || !s.peerName) return Promise.reject(new EngineError(UNREACHABLE));
    const id = String(++this.#seq);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EngineError({ ...UNREACHABLE, message: "The other agent did not answer in time" }));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      s.ch.send({ t: "req", id, body: req });
    });
  }

  emit(evt: PeerEvent): void {
    this.#session?.ch.send({ t: "evt", body: evt });
  }

  // ---- gaming PC ----

  #listen(): Promise<void> {
    const server = tls.createServer({
      ...TLS_OPTS,
      pskIdentityHint: "lan-kvm",
      pskCallback: (_socket, identity) => {
        const peer = this.#o.trust();
        return peer && identity === peer.id ? peer.psk : null;
      },
    });
    server.on("secureConnection", (sock) => this.#accept(sock));
    server.on("tlsClientError", () => {
      // Wrong or missing key: the handshake fails and nothing reaches us.
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#o.port ?? LINK_PORT, this.#o.bind ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  #accept(sock: tls.TLSSocket): void {
    sock.setNoDelay(true);
    const ch = frameChannel(sock, () => sock.destroy());
    const first = setTimeout(() => sock.destroy(), 3_000);
    ch.onMessage((m) => {
      clearTimeout(first);
      if (m.t === "tunnel" && typeof m.target === "string") return this.#serveTunnel(sock, ch, m.target);
      if (m.t === "hello") {
        const s = this.#adopt(sock, ch);
        this.#onMessage(s, m);
        return;
      }
      sock.destroy();
    });
    sock.on("error", () => {});
  }

  #serveTunnel(sock: tls.TLSSocket, ch: FrameChannel, target: string): void {
    const port = this.#o.tunnelTargets?.[target];
    if (port === undefined) return void sock.destroy();
    const rest = ch.detach();
    const local = net.connect({ host: "127.0.0.1", port }, () => {
      local.setNoDelay(true);
      if (rest.length) local.write(rest);
      sock.pipe(local);
      local.pipe(sock);
    });
    local.on("error", () => sock.destroy());
    sock.on("error", () => local.destroy());
    sock.on("close", () => local.destroy());
    local.on("close", () => sock.destroy());
  }

  // ---- laptop ----

  #dial(): void {
    if (this.#stopped || this.#session) return;
    const peer = this.#o.trust();
    if (!peer || !peer.address) return;
    const sock = tls.connect({
      ...TLS_OPTS,
      host: peer.address,
      port: this.#o.port ?? LINK_PORT,
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: peer.psk, identity: peer.id }),
    });
    sock.setNoDelay(true);
    let adopted = false;
    sock.once("secureConnect", () => {
      adopted = true;
      this.#attempt = 0;
      const ch = frameChannel(sock, () => sock.destroy());
      const s = this.#adopt(sock, ch);
      ch.send({ t: "hello", name: this.#o.name, machine: this.#o.machine, version: this.#o.version });
      void s;
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (!adopted) this.#scheduleDial();
    });
  }

  #scheduleDial(delay?: number): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = delay ?? Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.#attempt++);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#dial();
    }, wait);
  }

  #listenTunnel(name: string, localPort: number): Promise<void> {
    const server = net.createServer((local) => {
      local.setNoDelay(true);
      local.pause();
      const peer = this.#o.trust();
      if (!peer || !peer.address) return void local.destroy();
      const remote = tls.connect({
        ...TLS_OPTS,
        host: peer.address,
        port: this.#o.port ?? LINK_PORT,
        checkServerIdentity: () => undefined,
        pskCallback: () => ({ psk: peer.psk, identity: peer.id }),
      });
      remote.setNoDelay(true);
      remote.once("secureConnect", () => {
        remote.write(JSON.stringify({ t: "tunnel", target: name }) + "\n");
        local.pipe(remote);
        remote.pipe(local);
        local.resume();
      });
      remote.on("error", () => local.destroy());
      local.on("error", () => remote.destroy());
      remote.on("close", () => local.destroy());
      local.on("close", () => remote.destroy());
    });
    this.#tunnelServers.push(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  // ---- shared ----

  #adopt(sock: tls.TLSSocket, ch: FrameChannel): ControlSession {
    // A newer authenticated connection replaces an older one (e.g. after the laptop woke up).
    this.#dropSession(false);
    const s = new ControlSession(sock, ch, () => this.#lost(s, UNREACHABLE));
    this.#session = s;
    const allow = makeRateLimiter(100, 50);
    ch.onMessage((m) => {
      if (!allow()) return this.#lost(s, { code: "bad-request", message: "The other agent sent too many messages" });
      this.#onMessage(s, m);
    });
    sock.on("close", () => this.#lost(s, UNREACHABLE));
    sock.on("error", () => {});
    return s;
  }

  #onMessage(s: ControlSession, m: Record<string, unknown>): void {
    if (this.#session !== s) return;
    s.heard();
    this.#o.onHeard?.();
    switch (m.t) {
      case "hello": {
        const peer = this.#o.trust();
        if (typeof m.name !== "string" || !peer || m.machine !== peer.machine) {
          return this.#lost(s, { code: "peer-unpaired", message: "The other agent is not the paired device" });
        }
        const first = s.peerName === null;
        s.peerName = m.name.slice(0, 64);
        if (this.#o.machine === "gaming-pc" && first) {
          s.ch.send({ t: "hello", name: this.#o.name, machine: this.#o.machine, version: this.#o.version });
        }
        if (first) this.#o.onLink(true, { name: s.peerName, address: s.sock.remoteAddress });
        return;
      }
      case "ping":
        s.ch.send({ t: "pong", n: m.n });
        return;
      case "pong":
        return;
      case "req": {
        const id = typeof m.id === "string" ? m.id.slice(0, 16) : null;
        const req = parseRequest(m);
        if (!id || !req || !s.peerName) return;
        this.#o.onRequest(req).then(
          () => s.ch.send({ t: "res", id, ok: true }),
          (e: unknown) =>
            s.ch.send({
              t: "res",
              id,
              ok: false,
              error: e instanceof EngineError ? e.detail : { code: "internal", message: "The other agent hit an error" },
            }),
        );
        return;
      }
      case "res": {
        const p = typeof m.id === "string" ? this.#pending.get(m.id) : undefined;
        if (!p) return;
        this.#pending.delete(m.id as string);
        clearTimeout(p.timer);
        if (m.ok === true) p.resolve();
        else {
          const err = (m.error ?? {}) as Partial<AgentError>;
          const who = s.peerName ?? "The other machine";
          p.reject(
            new EngineError({
              code: "internal",
              message: `${who}: ${typeof err.message === "string" ? err.message.slice(0, 200) : "refused the request"}`,
              hint: typeof err.hint === "string" ? err.hint.slice(0, 300) : undefined,
            }),
          );
        }
        return;
      }
      case "evt": {
        const evt = parseEvent(m);
        if (evt && s.peerName) this.#o.onEvent(evt);
        return;
      }
      default:
        return;
    }
  }

  #lost(s: ControlSession, error: AgentError): void {
    if (this.#session !== s) return;
    const wasOnline = s.peerName !== null;
    this.#dropSession();
    if (wasOnline) this.#o.onLink(false, { error });
    if (this.#o.machine === "laptop") this.#scheduleDial();
  }

  #dropSession(failPending = true): void {
    const s = this.#session;
    this.#session = null;
    s?.close();
    if (failPending) {
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new EngineError(UNREACHABLE));
        this.#pending.delete(id);
      }
    }
  }
}
