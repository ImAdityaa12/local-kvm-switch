// The authenticated link between the two agents.
//
// TLS 1.2 with a pre-shared key from pairing (ECDHE-PSK-CHACHA20-POLY1305):
// mutual authentication and forward secrecy from a reviewed protocol, with no
// certificates. The gaming PC listens; the laptop dials, and finds the gaming
// PC again on the LAN when its address changed (discovery.ts).
//
// Besides control messages, either machine can open streams to a named target
// on the other: each one is its own PSK-authenticated TLS connection, after
// which bytes are piped to a loopback port (a tunnel) or handed to the agent.
// The laptop dials them with a first frame naming the target; the gaming PC,
// which the laptop never listens for, asks over the control session and the
// laptop dials back. Deskflow runs over tunnels, so its port is never exposed
// to the network.

import { randomBytes } from "node:crypto";
import type dgram from "node:dgram";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { AgentError, AudioFormat, DisplayTopology, InputEngineStatus, Machine, ModeState, ModeStepId, ModeStepStatus, RouteId } from "../../../lib/protocol/index.ts";
import { EngineError } from "../engines.ts";
import { makeRateLimiter } from "../rate-limit.ts";
import { answerDiscovery, findGamingPc, isLanPeer, lookupName } from "./discovery.ts";
import { frameChannel, type FrameChannel } from "./frames.ts";
import type { TrustedPeer } from "./trust.ts";

export const LINK_PORT = 47821;
const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";
const TLS_OPTS = { ciphers: CIPHERS, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
const HEARTBEAT_MS = 2_000;
const DEAD_AFTER_MS = 6_500;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 10_000;
/** How long the gaming PC waits for the laptop to dial back a stream it asked for. */
const OPEN_TIMEOUT_MS = 10_000;
const MAX_OPENS = 32;
/** Laptop: how often to look for the gaming PC on the LAN while its saved address does not answer. */
const FIND_EVERY_MS = 10_000;

export type PeerRequest =
  | { op: "input.prepare" }
  | { op: "input.release" }
  /** Laptop → gaming PC: switch the keyboard and mouse to the laptop, or give them back. */
  | { op: "input.take" }
  | { op: "input.return" }
  /** Laptop → gaming PC: turn switching at the screen edges on or off (the gaming PC keeps the setting). */
  | { op: "input.setEdge"; enabled: boolean }
  /** Laptop → gaming PC: switch to Laptop or Gaming PC mode (mode.ts). */
  | { op: "mode.set"; mode: Machine }
  /** Gaming PC → laptop: set the laptop's display layout; answered once Windows reports it. */
  | { op: "display.setTopology"; topology: "extend" | "internal" }
  | { op: "audio.start"; route: RouteId; volume?: number }
  | { op: "audio.stop"; route: RouteId }
  | { op: "audio.volume"; route: "micToLaptop"; volume: number };

export type PeerEvent =
  | { op: "input.status"; engine: InputEngineStatus; connected: boolean; entered: boolean }
  /** Gaming PC → laptop: the mode switch state, so the laptop's dashboard shows the same steps. */
  | { op: "mode.status"; mode: ModeState }
  /** Gaming PC → laptop: whether switching at the screen edges is on. */
  | { op: "edge.status"; enabled: boolean }
  /** Laptop → gaming PC: the laptop's current display layout. */
  | { op: "display.status"; topology: DisplayTopology }
  /** Either way: the drives this machine offers the other (sharing/files.ts); null for none. */
  | { op: "files.status"; serving: string[] | null }
  /** Laptop → gaming PC: the virtual microphone the laptop can feed. */
  | { op: "audio.endpoint"; present: boolean; name: string | null; isDefault: boolean | null }
  /** Laptop → gaming PC: health of the mic player on the laptop. */
  | {
      op: "audio.status";
      route: "micToLaptop";
      conversion?: { from: AudioFormat; to: AudioFormat } | null;
      stats?: { bufferMs: number; underruns: number; droppedFrames: number };
      error?: AgentError;
    };

export interface LinkOptions {
  machine: Machine;
  name: string;
  version: string;
  trust: () => TrustedPeer | null;
  /** Gaming PC: address to listen on; 0.0.0.0 for every adapter. Only LAN peers are accepted either way. */
  bind?: string;
  /**
   * Finding the gaming PC after its address changed (discovery.ts). The gaming PC answers on
   * this port; the laptop asks there when its saved address stops answering. Off when absent.
   */
  discovery?: { port?: number; targets?: string[] };
  /** Laptop: the gaming PC answered at a new address and the link is up there; save it. */
  onMoved?(address: string): void;
  port?: number;
  /** What the other machine may open streams to, by name: a loopback port, or a handler in this agent. */
  tunnelTargets?: Record<string, number | ((sock: Duplex) => void)>;
  /** Local loopback listeners whose connections are tunnelled to a named target on the other machine. */
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
  if (body.op === "input.prepare" || body.op === "input.release" || body.op === "input.take" || body.op === "input.return") return { op: body.op };
  if (body.op === "input.setEdge" && typeof body.enabled === "boolean") return { op: "input.setEdge", enabled: body.enabled };
  if (body.op === "mode.set" && (body.mode === "laptop" || body.mode === "gaming-pc")) return { op: "mode.set", mode: body.mode };
  if (body.op === "display.setTopology" && (body.topology === "extend" || body.topology === "internal")) return { op: "display.setTopology", topology: body.topology };
  const route = body.route === "laptopToPc" || body.route === "micToLaptop" ? body.route : null;
  const volume = typeof body.volume === "number" && body.volume >= 0 && body.volume <= 1 ? body.volume : undefined;
  if (body.op === "audio.start" && route) return { op: "audio.start", route, volume };
  if (body.op === "audio.stop" && route) return { op: "audio.stop", route };
  if (body.op === "audio.volume" && route === "micToLaptop" && volume !== undefined) return { op: "audio.volume", route, volume };
  return null;
}

function isFormat(v: unknown): v is AudioFormat {
  const f = v as AudioFormat | null;
  return (
    !!f &&
    typeof f.sampleRate === "number" &&
    typeof f.channels === "number" &&
    typeof f.bitDepth === "number" &&
    ["f32", "s16", "s24", "s32"].includes(f.sample as string)
  );
}

function shortText(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

const TOPOLOGIES: DisplayTopology[] = ["extend", "internal", "clone", "external", "unknown"];
const STEP_IDS: ModeStepId[] = ["laptop-display", "monitor", "input", "laptop-audio", "microphone"];
const STEP_STATUSES: ModeStepStatus[] = ["waiting", "running", "done", "unconfirmed", "failed", "skipped"];

function machineOrNull(v: unknown): Machine | null | undefined {
  return v === null ? null : v === "laptop" || v === "gaming-pc" ? v : undefined;
}

/** Rebuilds a mode state from the wire, keeping only known fields and values. */
export function parseModeState(v: unknown): ModeState | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const current = machineOrNull(o.current);
  const target = machineOrNull(o.target);
  if (current === undefined || target === undefined || !Array.isArray(o.steps) || o.steps.length > 8) return null;
  const steps = o.steps.flatMap((s: Record<string, unknown>) =>
    s && STEP_IDS.includes(s.id as ModeStepId) && STEP_STATUSES.includes(s.status as ModeStepStatus)
      ? [{ id: s.id as ModeStepId, status: s.status as ModeStepStatus, detail: shortText(s.detail, 300) ?? undefined }]
      : [],
  );
  const p = o.pending as Record<string, unknown> | null;
  const pendingTarget = machineOrNull(p?.target);
  const pending = p && pendingTarget && typeof p.since === "number" ? { target: pendingTarget, since: p.since } : null;
  const mon = o.monitor as Record<string, unknown> | null;
  const monitor: ModeState["monitor"] =
    mon && typeof mon.at === "number"
      ? {
          input: mon.input === "hdmi1" || mon.input === "hdmi2" ? mon.input : null,
          at: mon.at,
          via: mon.via === "usb" || mon.via === "hdmi" ? mon.via : undefined,
        }
      : null;
  const e = o.error as Record<string, unknown> | undefined;
  return {
    current,
    pending,
    target,
    steps,
    monitor,
    monitorControl: o.monitorControl === true,
    laptopDisplay: TOPOLOGIES.includes(o.laptopDisplay as DisplayTopology) ? (o.laptopDisplay as DisplayTopology) : null,
    error: e && typeof e.message === "string" ? { code: "internal", message: e.message.slice(0, 300), hint: shortText(e.hint, 300) ?? undefined } : undefined,
  };
}

function parseEvent(m: Record<string, unknown>): PeerEvent | null {
  const b = m.body as Record<string, unknown> | undefined;
  if (b?.op === "mode.status") {
    const mode = parseModeState(b.mode);
    return mode ? { op: "mode.status", mode } : null;
  }
  if (b?.op === "edge.status") return typeof b.enabled === "boolean" ? { op: "edge.status", enabled: b.enabled } : null;
  if (b?.op === "files.status") {
    if (b.serving === null) return { op: "files.status", serving: null };
    const drives = Array.isArray(b.serving) && b.serving.length <= 26 && b.serving.every((d) => typeof d === "string" && /^[A-Z]$/.test(d)) ? (b.serving as string[]) : null;
    return drives ? { op: "files.status", serving: [...new Set(drives)] } : null;
  }
  if (b?.op === "display.status") {
    return TOPOLOGIES.includes(b.topology as DisplayTopology) ? { op: "display.status", topology: b.topology as DisplayTopology } : null;
  }
  if (b?.op === "audio.endpoint") {
    if (typeof b.present !== "boolean") return null;
    return {
      op: "audio.endpoint",
      present: b.present,
      name: shortText(b.name, 120),
      isDefault: typeof b.isDefault === "boolean" ? b.isDefault : null,
    };
  }
  if (b?.op === "audio.status" && b.route === "micToLaptop") {
    const evt: PeerEvent & { op: "audio.status" } = { op: "audio.status", route: "micToLaptop" };
    const c = b.conversion as { from?: unknown; to?: unknown } | null | undefined;
    if (c === null) evt.conversion = null;
    else if (c && isFormat(c.from) && isFormat(c.to)) evt.conversion = { from: c.from, to: c.to };
    const st = b.stats as Record<string, unknown> | undefined;
    if (st && typeof st.bufferMs === "number" && typeof st.underruns === "number" && typeof st.droppedFrames === "number") {
      evt.stats = { bufferMs: st.bufferMs, underruns: st.underruns, droppedFrames: st.droppedFrames };
    }
    const e = b.error as Record<string, unknown> | undefined;
    if (e && typeof e.message === "string") {
      evt.error = { code: e.code === "device-missing" ? "device-missing" : "internal", message: e.message.slice(0, 200), hint: shortText(e.hint, 300) ?? undefined };
    }
    return evt;
  }
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
  /** Gaming PC: streams it asked the laptop to dial back, by id. */
  #opens = new Map<string, { resolve: (sock: tls.TLSSocket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #seq = 0;
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #discovery: dgram.Socket | null = null;
  /** Laptop: where discovery last found the gaming PC, tried before the saved address until a link is up. */
  #candidate: string | null = null;
  #finding = false;
  #lastFind = 0;

  constructor(opts: LinkOptions) {
    this.#o = opts;
  }

  get online(): boolean {
    return this.#session?.peerName != null;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    if (this.#o.machine === "gaming-pc") {
      await this.#listen();
      const d = this.#o.discovery;
      // Without it the laptop can still dial a saved address, so a busy port is not fatal.
      if (d) this.#discovery = await answerDiscovery({ trust: this.#o.trust, port: d.port }).catch(() => null);
    }
    for (const t of this.#o.tunnelListeners ?? []) await this.#listenTunnel(t.name, t.localPort);
    if (this.#o.machine === "laptop") this.#dial();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#dropSession();
    this.#discovery?.close();
    this.#discovery = null;
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

  request(req: PeerRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    const s = this.#session;
    if (!s || !s.peerName) return Promise.reject(new EngineError(UNREACHABLE));
    const id = String(++this.#seq);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EngineError({ ...UNREACHABLE, message: "The other agent did not answer in time" }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      s.ch.send({ t: "req", id, body: req });
    });
  }

  emit(evt: PeerEvent): void {
    this.#session?.ch.send({ t: "evt", body: evt });
  }

  /** A stream to a named target on the other machine (its tunnelTargets). It starts paused: pipe it, or resume() once listening. */
  openStream(target: string): Promise<tls.TLSSocket> {
    return this.#o.machine === "laptop" ? this.#dialStream({ t: "tunnel", target }) : this.#askStream(target);
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
    // Before TLS: nothing outside the LAN gets as far as a handshake.
    server.on("connection", (sock: net.Socket) => {
      if (!isLanPeer(sock.remoteAddress)) sock.destroy();
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
      if (m.t === "tunnel" && typeof m.target === "string") return this.#serveTarget(sock, ch.detach(), m.target);
      if (m.t === "back" && typeof m.id === "string") return this.#takeBack(sock, ch.detach(), m.id);
      if (m.t === "hello") {
        const s = this.#adopt(sock, ch);
        this.#onMessage(s, m);
        return;
      }
      sock.destroy();
    });
    sock.on("error", () => {});
  }

  /** Gaming PC: asks the laptop to dial back a stream to `target`. */
  #askStream(target: string): Promise<tls.TLSSocket> {
    const s = this.#session;
    if (!s || !s.peerName) return Promise.reject(new EngineError(UNREACHABLE));
    if (this.#opens.size >= MAX_OPENS) return Promise.reject(new EngineError({ ...UNREACHABLE, message: "Too many streams are opening at once" }));
    const id = randomBytes(9).toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#opens.delete(id);
        reject(new EngineError({ ...UNREACHABLE, message: "The other agent did not open the stream in time" }));
      }, OPEN_TIMEOUT_MS);
      this.#opens.set(id, { resolve, reject, timer });
      s.ch.send({ t: "open", id, target });
    });
  }

  /** Gaming PC: the laptop dialed back a stream it was asked for. */
  #takeBack(sock: tls.TLSSocket, rest: Buffer, id: string): void {
    const open = this.#opens.get(id);
    if (!open) return void sock.destroy();
    this.#opens.delete(id);
    clearTimeout(open.timer);
    if (rest.length) sock.unshift(rest);
    open.resolve(sock);
  }

  /** Bytes from the other machine for `target`: piped to its loopback port, or handed to its handler. */
  #serveTarget(sock: tls.TLSSocket, rest: Buffer, target: string): void {
    const targets = this.#o.tunnelTargets ?? {};
    const to = Object.hasOwn(targets, target) ? targets[target] : undefined;
    if (to === undefined) return void sock.destroy();
    sock.on("error", () => {});
    if (typeof to === "function") {
      if (rest.length) sock.unshift(rest);
      to(sock);
      sock.resume();
      return;
    }
    const port = to;
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
    const host = this.#candidate ?? peer?.address;
    if (!peer || !host) return;
    const sock = tls.connect({
      ...TLS_OPTS,
      host,
      port: this.#o.port ?? LINK_PORT,
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: peer.psk, identity: peer.id }),
    });
    sock.setNoDelay(true);
    let adopted = false;
    sock.once("secureConnect", () => {
      adopted = true;
      this.#attempt = 0;
      // The key proved it is the gaming PC: from now on dial it here.
      if (this.#candidate) {
        this.#candidate = null;
        if (host !== peer.address) this.#o.onMoved?.(host);
      }
      const ch = frameChannel(sock, () => sock.destroy());
      const s = this.#adopt(sock, ch);
      ch.send({ t: "hello", name: this.#o.name, machine: this.#o.machine, version: this.#o.version });
      void s;
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (adopted) return;
      if (host === this.#candidate) this.#candidate = null;
      this.#scheduleDial();
      this.#find(peer);
    });
  }

  /** Laptop: the saved address keeps failing, so ask the LAN where the gaming PC is now. */
  #find(peer: TrustedPeer): void {
    const d = this.#o.discovery;
    if (!d || this.#finding || this.#stopped || this.#attempt < 2 || Date.now() - this.#lastFind < FIND_EVERY_MS) return;
    this.#finding = true;
    this.#lastFind = Date.now();
    void (async () => {
      const found = (await findGamingPc(peer, d)) ?? (await lookupName(peer.name));
      this.#finding = false;
      if (!found || found === peer.address || this.#session || this.#stopped) return;
      this.#candidate = found;
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      this.#dial();
    })();
  }

  #scheduleDial(delay?: number): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const wait = delay ?? Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.#attempt++);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#dial();
    }, wait);
  }

  /** Laptop: a new PSK-authenticated connection to the gaming PC whose first frame is `first`. */
  #dialStream(first: object): Promise<tls.TLSSocket> {
    const peer = this.#o.trust();
    const host = peer?.address;
    if (!peer || !host) return Promise.reject(new EngineError(UNREACHABLE));
    return new Promise((resolve, reject) => {
      const remote = tls.connect({
        ...TLS_OPTS,
        host,
        port: this.#o.port ?? LINK_PORT,
        checkServerIdentity: () => undefined,
        pskCallback: () => ({ psk: peer.psk, identity: peer.id }),
      });
      remote.setNoDelay(true);
      const fail = () => reject(new EngineError(UNREACHABLE));
      remote.once("error", fail);
      remote.once("close", fail);
      remote.once("secureConnect", () => {
        remote.off("error", fail);
        remote.off("close", fail);
        remote.on("error", () => {});
        remote.write(JSON.stringify(first) + "\n");
        remote.pause();
        resolve(remote);
      });
    });
  }

  /** Laptop: the gaming PC asked for a stream to one of this laptop's targets; dial it back. */
  #dialBack(id: string, target: string): void {
    if (!Object.hasOwn(this.#o.tunnelTargets ?? {}, target)) return;
    this.#dialStream({ t: "back", id }).then(
      (sock) => this.#serveTarget(sock, Buffer.alloc(0), target),
      () => {},
    );
  }

  #listenTunnel(name: string, localPort: number): Promise<void> {
    const server = net.createServer((local) => {
      local.setNoDelay(true);
      local.pause();
      local.on("error", () => {});
      this.openStream(name).then(
        (remote) => {
          if (local.destroyed) return void remote.destroy();
          local.pipe(remote);
          remote.pipe(local);
          local.resume();
          remote.on("error", () => local.destroy());
          local.on("error", () => remote.destroy());
          remote.on("close", () => local.destroy());
          local.on("close", () => remote.destroy());
        },
        () => local.destroy(),
      );
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
      case "open":
        // Only the gaming PC asks; the laptop dials back to one of its own targets.
        if (this.#o.machine === "laptop" && s.peerName && typeof m.id === "string" && m.id.length <= 16 && typeof m.target === "string") this.#dialBack(m.id, m.target);
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
      for (const [id, p] of [...this.#pending, ...this.#opens]) {
        clearTimeout(p.timer);
        p.reject(new EngineError(UNREACHABLE));
        this.#pending.delete(id);
        this.#opens.delete(id);
      }
    }
  }
}
