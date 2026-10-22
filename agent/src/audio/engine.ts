// Audio through the native helper. Both directions run inside the peer link's
// TLS tunnels, and each helper only touches loopback addresses.
//
// Laptop audio → gaming PC
//   laptop:    kvm-audio send  --connect 127.0.0.1:24821  (loopback capture)  ──tunnel "audio"──►
//   gaming PC: kvm-audio play  --listen  127.0.0.1:24820  --device <chosen output>
//
// Gaming PC microphone → laptop
//   gaming PC: kvm-audio send  --listen  127.0.0.1:24830  --capture <chosen mic>  (mute applied here)
//   laptop:    kvm-audio play  --connect 127.0.0.1:24831  --device <CABLE Input>   ──tunnel "mic"──►
//   Apps on the laptop record from "CABLE Output".

import type { AgentError, AudioDevice, AudioFormat, RouteId, VirtualEndpointState } from "../../../lib/protocol/index.ts";
import { EngineError, type AudioEngine, type RouteInfo } from "../engines.ts";
import type { PeerEvent, PeerRequest } from "../peer/link.ts";
import { HelperProcess, type HelperEvent } from "./helper.ts";

/** Loopback port of the laptop-audio player on the gaming PC (tunnel target "audio"). */
export const AUDIO_PLAY_PORT = 24820;
/** Loopback port on the laptop that tunnels to AUDIO_PLAY_PORT. */
export const AUDIO_TUNNEL_PORT = 24821;
/** Loopback port of the mic sender on the gaming PC (tunnel target "mic"). */
export const MIC_SEND_PORT = 24830;
/** Loopback port on the laptop that tunnels to MIC_SEND_PORT. */
export const MIC_TUNNEL_PORT = 24831;

const START_TIMEOUT_MS = 8_000;
const VB_PLAYBACK = /^CABLE Input\b/i;
const VB_RECORDING = /^CABLE Output\b/i;
/** The device part of the name, which stays when the endpoint itself is renamed (e.g. "Speakers (VB-Audio Virtual Cable)"). */
const VB_DEVICE = /\(VB-Audio Virtual Cable\)\s*$/i;
const SIXTEEN_CH = /\b16\s*Ch\b/i;
/** Windows' AUDCLNT_E_DEVICE_IN_USE. */
const DEVICE_IN_USE = /0x8889000A/i;

/**
 * Any input of the virtual cable: "CABLE Input", and "CABLE In 16ch" that newer
 * VB-CABLE versions add. Only one of them can be used at a time, so sound sent
 * to "CABLE In 16ch" also blocks the mic from opening CABLE Input.
 */
export function isCablePlayback(name: string): boolean {
  return /^CABLE In(put\b|\s)/i.test(name) || (VB_DEVICE.test(name) && !VB_RECORDING.test(name));
}

/** The cable's playback side the mic is played into, and its recording side apps use, by name or else by device. */
export function findCable<T extends { name: string }>(d: { playback: T[]; capture: T[] }): { input?: T; output?: T } {
  const input = d.playback.find((x) => VB_PLAYBACK.test(x.name)) ?? d.playback.find((x) => VB_DEVICE.test(x.name) && !SIXTEEN_CH.test(x.name));
  const output = d.capture.find((x) => VB_RECORDING.test(x.name)) ?? d.capture.find((x) => VB_DEVICE.test(x.name));
  return { input, output };
}

/**
 * A virtual output other than the mic's cable: Voicemeeter's "Voicemeeter Input"
 * (free; the Voicemeeter app must not be running, or it plays the sound on
 * the speakers) or VB-CABLE A+B's "CABLE-A Input". Laptop sound set to one of
 * them reaches the IEM without the laptop's speakers playing it, and leaves
 * the mic's cable alone.
 */
export function isSecondCable(name: string): boolean {
  return /^Voicemeeter\b.*\bIn(put\b|\s)/i.test(name) || /^CABLE-[AB] In(put\b|\s)/i.test(name);
}

/** The laptop's output is the mic's cable: say what to choose instead. */
export function cableIsDefaultError(name: string, what: string, playback: { name: string }[]): EngineError {
  const second = playback.find((x) => isSecondCable(x.name));
  return new EngineError({
    code: "device-missing",
    message: `The laptop's sound output is "${name}", the microphone's cable. ${what}`,
    hint: second
      ? `On the laptop: Settings → System → Sound → Output → "${second.name}". Laptop sound then goes only to your IEM.`
      : "To hear laptop sound only in your IEM, install Voicemeeter (free, vb-audio.com/Voicemeeter) on the laptop and set Sound → Output to \"Voicemeeter Input\". Or choose your speakers or headphones.",
  });
}

export interface AudioPeer {
  request(req: PeerRequest): Promise<void>;
}

type Listed = AudioDevice & { mix: AudioFormat | null };

function errorFrom(e: HelperEvent, what: "playback" | "microphone" = "playback"): AgentError {
  const code = e.code as AgentError["code"];
  const message = String(e.message ?? "Audio helper error");
  switch (code) {
    case "device-missing":
      return { code, message: `The ${what} device is not available.`, hint: "Reconnect it or choose another device." };
    case "format-unsupported":
      return { code, message: `The audio format is not supported: ${message}` };
    case "engine-missing":
      return { code, message, hint: "Build it with npm run build:audio." };
    case "peer-unreachable":
      return { code, message: "The other machine's audio stream is not reachable" };
    default:
      if (DEVICE_IN_USE.test(message)) {
        return {
          code: "device-missing",
          message: `The ${what} device is in use by something else (Windows error 0x8889000A).`,
          hint: "On the laptop, set Sound → Output to your speakers or headphones, not a CABLE device. Otherwise close the app holding the device, or untick \"Allow applications to take exclusive control\" in its Sound properties → Advanced.",
        };
      }
      return { code: "internal", message };
  }
}

function waitEvent(h: HelperProcess, event: string, ms: number, what: "playback" | "microphone" = "playback"): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new EngineError({ code: "engine-timeout", message: `Audio did not arrive within ${ms / 1000}s` })), ms);
    h.on(event, (e) => {
      clearTimeout(t);
      resolve(e);
    });
    h.on("error", (e) => {
      clearTimeout(t);
      reject(new EngineError(errorFrom(e, what)));
    });
    void h.exited.then(() => {
      clearTimeout(t);
      reject(new EngineError({ code: "engine-crashed", message: "The audio helper stopped" }));
    });
  });
}

async function stopHelper(h: HelperProcess | null): Promise<void> {
  if (!h || !h.running) return;
  h.stop(); // fades out over 10 ms, then exits
  const timer = setTimeout(() => h.child.kill(), 2_000);
  await h.exited;
  clearTimeout(timer);
}

/** Gaming PC side: owns both routes. */
export class HelperAudio implements AudioEngine {
  readonly kind = "wasapi" as const;
  #exe: string;
  #peer: AudioPeer;
  #helpers: Partial<Record<RouteId, HelperProcess>> = {};
  #live: Partial<Record<RouteId, boolean>> = {};
  #volume: Record<RouteId, number> = { laptopToPc: 0.8, micToLaptop: 1 };
  #muted: Record<RouteId, boolean> = { laptopToPc: false, micToLaptop: false };
  #endpoint: VirtualEndpointState = { present: false, isDefault: null };
  #levelCb: (r: RouteId, db: number) => void = () => {};
  #faultCb: (r: RouteId, e: AgentError) => void = () => {};
  #statsCb: (r: RouteId, info: RouteInfo) => void = () => {};

  constructor(exe: string, peer: AudioPeer) {
    this.#exe = exe;
    this.#peer = peer;
  }

  async listDevices() {
    const d = await HelperProcess.list(this.#exe);
    const map = (x: Listed) => ({ id: x.id, name: x.name, isDefault: x.isDefault, mix: x.mix });
    return { playback: d.playback.map(map), capture: d.capture.map(map) };
  }

  async virtualEndpoint(): Promise<VirtualEndpointState> {
    return this.#endpoint;
  }

  /** What the laptop last reported about its virtual microphone. */
  setEndpoint(ep: VirtualEndpointState): void {
    this.#endpoint = ep;
  }

  /** Mic-player health reported by the laptop. */
  remoteStatus(evt: PeerEvent & { op: "audio.status" }): void {
    if (evt.conversion !== undefined || evt.stats) this.#statsCb("micToLaptop", { conversion: evt.conversion, stats: evt.stats });
    if (evt.error) this.#fault("micToLaptop", evt.error);
  }

  #fault(route: RouteId, err: AgentError): void {
    if (this.#live[route]) {
      this.#live[route] = false;
      this.#faultCb(route, err);
    }
  }

  async start(route: RouteId, deviceId: string | null): Promise<AudioFormat> {
    if (!deviceId) {
      throw new EngineError({ code: "device-missing", message: route === "laptopToPc" ? "Choose a playback device first." : "Choose a microphone first." });
    }
    await this.#stopHelper(route);
    return route === "laptopToPc" ? this.#startPlayback(deviceId) : this.#startMic(deviceId);
  }

  async #startPlayback(deviceId: string): Promise<AudioFormat> {
    const route = "laptopToPc";
    const args = ["play", "--listen", `127.0.0.1:${AUDIO_PLAY_PORT}`, "--device", deviceId, "--volume", String(this.#volume[route])];
    if (this.#muted[route]) args.push("--muted");
    const player = HelperProcess.spawn(this.#exe, args);
    this.#helpers[route] = player;
    let format: AudioFormat | null = null;

    player.on("format", (e) => {
      format = e.format as AudioFormat;
      this.#statsCb(route, { conversion: e.conversion ? { from: format, to: e.device as AudioFormat } : null });
    });
    player.on("stats", (e) => {
      if (typeof e.peakDb === "number") this.#levelCb(route, e.peakDb);
      this.#statsCb(route, { stats: { bufferMs: Number(e.bufferMs), underruns: Number(e.underruns), droppedFrames: Number(e.droppedFrames) } });
    });
    player.on("disconnected", () => this.#fault(route, { code: "peer-unreachable", message: "The laptop stopped sending audio" }));
    player.on("error", (e) => this.#fault(route, errorFrom(e)));
    void player.exited.then(() => this.#fault(route, { code: "engine-crashed", message: "The audio player stopped" }));

    try {
      await waitEvent(player, "listening", START_TIMEOUT_MS);
      await this.#peer.request({ op: "audio.start", route });
      await waitEvent(player, "streaming", START_TIMEOUT_MS);
    } catch (e) {
      await this.#stopHelper(route);
      this.#peer.request({ op: "audio.stop", route }).catch(() => {});
      throw e;
    }
    if (!format) throw new EngineError({ code: "internal", message: "The audio player did not report its format" });
    this.#live[route] = true;
    return format;
  }

  async #startMic(deviceId: string): Promise<AudioFormat> {
    const route = "micToLaptop";
    if (!this.#endpoint.present) {
      throw new EngineError({ code: "endpoint-missing", message: "The laptop has no virtual microphone.", hint: "Install VB-CABLE on the laptop and restart its agent." });
    }
    const args = ["send", "--listen", `127.0.0.1:${MIC_SEND_PORT}`, "--capture", deviceId];
    if (this.#muted[route]) args.push("--muted");
    const sender = HelperProcess.spawn(this.#exe, args);
    this.#helpers[route] = sender;

    sender.on("stats", (e) => {
      if (typeof e.peakDb === "number") this.#levelCb(route, e.peakDb);
    });
    sender.on("error", (e) => this.#fault(route, errorFrom(e, "microphone")));
    void sender.exited.then(() => this.#fault(route, { code: "peer-unreachable", message: "The microphone stream to the laptop ended" }));

    let started: HelperEvent;
    try {
      await waitEvent(sender, "listening", START_TIMEOUT_MS, "microphone");
      const streaming = waitEvent(sender, "streaming", START_TIMEOUT_MS, "microphone");
      // Awaited below. If the laptop refuses first, stopping the sender fails this
      // one, and that must not crash the agent.
      streaming.catch(() => {});
      await this.#peer.request({ op: "audio.start", route, volume: this.#volume[route] });
      started = await streaming;
    } catch (e) {
      await this.#stopHelper(route);
      this.#peer.request({ op: "audio.stop", route }).catch(() => {});
      throw e;
    }
    this.#live[route] = true;
    return started.format as AudioFormat;
  }

  async stop(route: RouteId): Promise<void> {
    await this.#stopHelper(route);
    await this.#peer.request({ op: "audio.stop", route }).catch(() => {});
  }

  async #stopHelper(route: RouteId): Promise<void> {
    this.#live[route] = false;
    const h = this.#helpers[route] ?? null;
    delete this.#helpers[route];
    await stopHelper(h);
  }

  setVolume(route: RouteId, volume: number): void {
    this.#volume[route] = volume;
    if (route === "laptopToPc") this.#helpers[route]?.command({ cmd: "volume", value: volume });
    else if (this.#live[route]) this.#peer.request({ op: "audio.volume", route, volume }).catch(() => {});
  }

  setMuted(route: RouteId, muted: boolean): void {
    // For the mic this mutes at the source: nothing audible leaves the gaming PC.
    this.#muted[route] = muted;
    this.#helpers[route]?.command({ cmd: "mute", value: muted });
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

/** Laptop side: sends its audio and plays the gaming PC's mic into the virtual cable, when asked. */
export class LaptopAudio {
  #exe: string;
  #log: (level: "info" | "warn" | "error", msg: string) => void;
  #emit: (evt: PeerEvent) => void;
  #sender: HelperProcess | null = null;
  #micPlayer: HelperProcess | null = null;

  constructor(exe: string, log: (level: "info" | "warn" | "error", msg: string) => void, emit: (evt: PeerEvent) => void) {
    this.#exe = exe;
    this.#log = log;
    this.#emit = emit;
  }

  /** The virtual microphone apps can record from, if VB-CABLE is installed. */
  async endpoint(): Promise<VirtualEndpointState & { playbackId: string | null; playbackName?: string }> {
    const d = await HelperProcess.list(this.#exe);
    const { input, output } = findCable(d);
    if (!input || !output) return { present: false, isDefault: null, playbackId: null };
    return { present: true, name: output.name, isDefault: output.isDefault, playbackId: input.id, playbackName: input.name };
  }

  async announceEndpoint(): Promise<void> {
    const ep = await this.endpoint().catch(() => null);
    if (ep) this.#emit({ op: "audio.endpoint", present: ep.present, name: ep.name ?? null, isDefault: ep.isDefault });
  }

  async start(route: RouteId, volume?: number): Promise<void> {
    if (route === "laptopToPc") return this.#startSend();
    return this.#startMic(volume ?? 1);
  }

  async stop(route: RouteId): Promise<void> {
    if (route === "laptopToPc") {
      const s = this.#sender;
      this.#sender = null;
      await stopHelper(s);
    } else {
      const p = this.#micPlayer;
      this.#micPlayer = null;
      if (p?.running) this.#log("info", "Stopped playing the gaming PC microphone");
      await stopHelper(p);
    }
  }

  setMicVolume(volume: number): void {
    this.#micPlayer?.command({ cmd: "volume", value: volume });
  }

  async #startSend(): Promise<void> {
    await this.stop("laptopToPc");
    // Never loop the virtual cable back to the gaming PC: it carries the mic,
    // so this would send your own voice back into your ears.
    const d = await HelperProcess.list(this.#exe);
    const def = d.playback.find((x) => x.isDefault);
    if (def && isCablePlayback(def.name)) throw cableIsDefaultError(def.name, "Sending it would put your own voice back into your ears.", d.playback);
    const s = HelperProcess.spawn(this.#exe, ["send", "--connect", `127.0.0.1:${AUDIO_TUNNEL_PORT}`]);
    this.#sender = s;
    const started = await waitEvent(s, "streaming", START_TIMEOUT_MS).catch(async (e) => {
      await this.stop("laptopToPc");
      throw e;
    });
    const f = started.format as AudioFormat;
    this.#log("info", `Sending this laptop's audio${def ? ` from ${def.name}` : ""} at ${f.sampleRate / 1000} kHz, ${f.channels} ch, ${f.bitDepth}-bit`);
    void s.exited.then(() => {
      if (this.#sender === s) {
        this.#sender = null;
        this.#log("warn", "Stopped sending audio");
      }
    });
  }

  async #startMic(volume: number): Promise<void> {
    await this.stop("micToLaptop");
    const ep = await this.endpoint();
    if (!ep.present || !ep.playbackId) {
      throw new EngineError({ code: "endpoint-missing", message: "VB-CABLE is not installed on the laptop.", hint: "Install it, reboot, and restart the agent." });
    }
    // Laptop sound going into the cable blocks CABLE Input and mixes into the mic.
    const playback = (await HelperProcess.list(this.#exe)).playback;
    const def = playback.find((x) => x.isDefault);
    if (def && isCablePlayback(def.name)) throw cableIsDefaultError(def.name, "It blocks the microphone and would mix laptop sounds into it.", playback);
    const p = HelperProcess.spawn(this.#exe, ["play", "--connect", `127.0.0.1:${MIC_TUNNEL_PORT}`, "--device", ep.playbackId, "--volume", String(volume)]);
    this.#micPlayer = p;
    let live = false;
    p.on("format", (e) => {
      const from = e.format as AudioFormat;
      this.#emit({ op: "audio.status", route: "micToLaptop", conversion: e.conversion ? { from, to: e.device as AudioFormat } : null });
    });
    p.on("stats", (e) =>
      this.#emit({
        op: "audio.status",
        route: "micToLaptop",
        stats: { bufferMs: Number(e.bufferMs), underruns: Number(e.underruns), droppedFrames: Number(e.droppedFrames) },
      }),
    );
    const fail = (error: AgentError) => {
      if (live && this.#micPlayer === p) {
        live = false;
        this.#emit({ op: "audio.status", route: "micToLaptop", error });
      }
    };
    p.on("error", (e) => fail(e.code === "device-missing" ? { code: "device-missing", message: "The virtual cable on the laptop is not available." } : errorFrom(e)));
    void p.exited.then(() => fail({ code: "engine-crashed", message: "The microphone player on the laptop stopped" }));

    await waitEvent(p, "streaming", START_TIMEOUT_MS).catch(async (e) => {
      await this.stop("micToLaptop");
      throw e;
    });
    live = true;
    this.#log("info", `Playing the gaming PC microphone into ${ep.playbackName ?? "CABLE Input"}; apps record it from ${ep.name ?? "CABLE Output"}`);
  }
}
