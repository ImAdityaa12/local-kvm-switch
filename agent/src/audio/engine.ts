// Audio through the native helper.
//
// Laptop audio → gaming PC: the gaming PC runs `kvm-audio play` on a loopback
// port reachable only through the peer link's "audio" tunnel; the laptop runs
// `kvm-audio send`, which captures the laptop's mix (WASAPI loopback) and
// connects to its local end of that tunnel. Samples are sent as captured.
//
// The microphone direction is Phase 3.

import type { AgentError, AudioFormat, RouteId, VirtualEndpointState } from "../../../lib/protocol/index.ts";
import { EngineError, type AudioEngine, type RouteInfo } from "../engines.ts";
import { HelperProcess, type HelperEvent } from "./helper.ts";

/** Loopback port of the player on the gaming PC (tunnel target "audio"). */
export const AUDIO_PLAY_PORT = 24820;
/** Loopback port on the laptop that tunnels to AUDIO_PLAY_PORT. */
export const AUDIO_TUNNEL_PORT = 24821;
const START_TIMEOUT_MS = 8_000;

export interface AudioPeer {
  request(req: { op: "audio.start"; route: "laptopToPc" } | { op: "audio.stop"; route: "laptopToPc" }): Promise<void>;
}

function errorFrom(e: HelperEvent): AgentError {
  const code = e.code as AgentError["code"];
  const message = String(e.message ?? "Audio helper error");
  switch (code) {
    case "device-missing":
      return { code, message: "The playback device is not available.", hint: "Reconnect it or choose another device." };
    case "format-unsupported":
      return { code, message: `The audio format is not supported: ${message}` };
    case "engine-missing":
      return { code, message, hint: "Build it with npm run build:audio." };
    default:
      return { code: "internal", message };
  }
}

function waitEvent(h: HelperProcess, event: string, ms: number): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new EngineError({ code: "engine-timeout", message: `Audio did not arrive within ${ms / 1000}s` })), ms);
    h.on(event, (e) => {
      clearTimeout(t);
      resolve(e);
    });
    h.on("error", (e) => {
      clearTimeout(t);
      reject(new EngineError(errorFrom(e)));
    });
    void h.exited.then(() => {
      clearTimeout(t);
      reject(new EngineError({ code: "engine-crashed", message: "The audio helper stopped" }));
    });
  });
}

/** Gaming PC side. */
export class HelperAudio implements AudioEngine {
  readonly kind = "wasapi" as const;
  #exe: string;
  #peer: AudioPeer;
  #player: HelperProcess | null = null;
  #volume = 0.8;
  #muted = false;
  #levelCb: (r: RouteId, db: number) => void = () => {};
  #faultCb: (r: RouteId, e: AgentError) => void = () => {};
  #statsCb: (r: RouteId, info: RouteInfo) => void = () => {};

  constructor(exe: string, peer: AudioPeer) {
    this.#exe = exe;
    this.#peer = peer;
  }

  async listDevices() {
    const d = await HelperProcess.list(this.#exe);
    const map = (x: { id: string; name: string; isDefault: boolean; mix: AudioFormat | null }) => ({ id: x.id, name: x.name, isDefault: x.isDefault, mix: x.mix });
    return { playback: d.playback.map(map), capture: d.capture.map(map) };
  }

  async virtualEndpoint(): Promise<VirtualEndpointState> {
    return { present: false, isDefault: null };
  }

  async start(route: RouteId, deviceId: string | null): Promise<AudioFormat> {
    if (route !== "laptopToPc") {
      throw new EngineError({ code: "not-supported", message: "Sending the microphone to the laptop is not built yet.", hint: "It arrives in Phase 3." });
    }
    if (!deviceId) throw new EngineError({ code: "device-missing", message: "Choose a playback device first." });
    await this.#stopPlayer();

    const args = ["play", "--listen", `127.0.0.1:${AUDIO_PLAY_PORT}`, "--device", deviceId, "--volume", String(this.#volume)];
    if (this.#muted) args.push("--muted");
    const player = HelperProcess.spawn(this.#exe, args);
    this.#player = player;
    let format: AudioFormat | null = null;
    let live = false;

    player.on("format", (e) => {
      format = e.format as AudioFormat;
      const device = e.device as AudioFormat;
      this.#statsCb(route, { conversion: e.conversion ? { from: format, to: device } : null });
    });
    player.on("stats", (e) => {
      if (typeof e.peakDb === "number") this.#levelCb(route, e.peakDb);
      this.#statsCb(route, { stats: { bufferMs: Number(e.bufferMs), underruns: Number(e.underruns), droppedFrames: Number(e.droppedFrames) } });
    });
    const fault = (err: AgentError) => {
      if (live && this.#player === player) {
        live = false;
        this.#faultCb(route, err);
      }
    };
    player.on("disconnected", () => fault({ code: "peer-unreachable", message: "The laptop stopped sending audio" }));
    player.on("error", (e) => fault(errorFrom(e)));
    void player.exited.then(() => fault({ code: "engine-crashed", message: "The audio player stopped" }));

    try {
      await waitEvent(player, "listening", START_TIMEOUT_MS);
      await this.#peer.request({ op: "audio.start", route });
      await waitEvent(player, "streaming", START_TIMEOUT_MS);
    } catch (e) {
      await this.#stopPlayer();
      this.#peer.request({ op: "audio.stop", route }).catch(() => {});
      throw e;
    }
    live = true;
    if (!format) throw new EngineError({ code: "internal", message: "The audio player did not report its format" });
    return format;
  }

  async stop(route: RouteId): Promise<void> {
    if (route !== "laptopToPc") return;
    await this.#stopPlayer();
    await this.#peer.request({ op: "audio.stop", route }).catch(() => {});
  }

  async #stopPlayer(): Promise<void> {
    const p = this.#player;
    this.#player = null;
    if (!p || !p.running) return;
    p.stop(); // fades out over 10 ms, then exits
    const timer = setTimeout(() => p.child.kill(), 2_000);
    await p.exited;
    clearTimeout(timer);
  }

  setVolume(route: RouteId, volume: number): void {
    if (route !== "laptopToPc") return;
    this.#volume = volume;
    this.#player?.command({ cmd: "volume", value: volume });
  }

  setMuted(route: RouteId, muted: boolean): void {
    if (route !== "laptopToPc") return;
    this.#muted = muted;
    this.#player?.command({ cmd: "mute", value: muted });
  }

  onLevel(cb: (r: RouteId, db: number) => void): void {
    this.#levelCb = cb;
  }

  onFault(cb: (r: RouteId, e: AgentError) => void): void {
    this.#faultCb = cb;
  }

  onStats(cb: (r: RouteId, info: RouteInfo) => void): void {
    this.#statsCb = cb;
  }
}

/** Laptop side: runs the loopback sender while the gaming PC asks for it. */
export class LaptopAudioSender {
  #exe: string;
  #sender: HelperProcess | null = null;
  #log: (level: "info" | "warn" | "error", msg: string) => void;

  constructor(exe: string, log: (level: "info" | "warn" | "error", msg: string) => void) {
    this.#exe = exe;
    this.#log = log;
  }

  async start(): Promise<void> {
    await this.stop();
    const s = HelperProcess.spawn(this.#exe, ["send", "--connect", `127.0.0.1:${AUDIO_TUNNEL_PORT}`]);
    this.#sender = s;
    const started = await waitEvent(s, "streaming", START_TIMEOUT_MS).catch(async (e) => {
      await this.stop();
      throw e;
    });
    const f = started.format as AudioFormat;
    this.#log("info", `Sending this laptop's audio at ${f.sampleRate / 1000} kHz, ${f.channels} ch, ${f.bitDepth}-bit`);
    void s.exited.then(() => {
      if (this.#sender === s) {
        this.#sender = null;
        this.#log("warn", "Stopped sending audio");
      }
    });
  }

  async stop(): Promise<void> {
    const s = this.#sender;
    this.#sender = null;
    if (!s || !s.running) return;
    s.stop();
    const timer = setTimeout(() => s.child.kill(), 2_000);
    await s.exited;
    clearTimeout(timer);
  }
}
