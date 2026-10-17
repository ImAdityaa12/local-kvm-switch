// Simulated engines for developing the dashboard without two machines.
// They never touch real input or audio. The agent reports `simulated: true`
// and the dashboard says so on every screen.

import { randomInt } from "node:crypto";
import type { AgentError, AudioFormat, RouteId, VirtualEndpointState } from "../../../lib/protocol/index.ts";
import type { Pairing, Simulation } from "../controller.ts";
import { EngineError, type AudioEngine, type InputEngine, type InputReport } from "../engines.ts";

const UNREACHABLE: AgentError = {
  code: "peer-unreachable",
  message: "No reply from the laptop agent",
  hint: "Check the laptop is awake, on the same network, and that Windows Firewall allows the agent on private networks.",
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SimWorld implements Simulation {
  peerReachable = true;
  endpointPresent = true;
  latencyMs: number;
  #linkListeners: ((online: boolean, error?: AgentError) => void)[] = [];

  constructor(latencyMs = 450) {
    this.latencyMs = latencyMs;
  }

  setPeerReachable(reachable: boolean): void {
    if (this.peerReachable === reachable) return;
    this.peerReachable = reachable;
    for (const l of this.#linkListeners) l(reachable, reachable ? undefined : UNREACHABLE);
  }

  setEndpointPresent(present: boolean): void {
    this.endpointPresent = present;
  }

  readonly peer = {
    onLink: (cb: (online: boolean, error?: AgentError) => void) => {
      this.#linkListeners.push(cb);
    },
  };

  delay(): Promise<void> {
    return wait(this.latencyMs);
  }
}

export class SimInput implements InputEngine {
  readonly kind = "simulated" as const;
  readonly hotkey = "Scroll Lock";
  #world: SimWorld;
  #cb: (r: InputReport, e?: AgentError) => void = () => {};
  #running = false;

  constructor(world: SimWorld) {
    this.#world = world;
    world.peer.onLink((online) => {
      if (!online && this.#running) {
        // Mirrors an engine that drops its client and returns the cursor home.
        this.#running = false;
        this.#cb(
          { target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false },
          { code: "peer-unreachable", message: "Laptop client disconnected", hint: "Held keys were released." },
        );
      }
    });
  }

  onReport(cb: (r: InputReport, e?: AgentError) => void): void {
    this.#cb = cb;
  }

  async activateRemote(): Promise<void> {
    this.#cb({ target: "gaming-pc", engine: "starting", hooksActive: false, clientConnected: false });
    await this.#world.delay();
    this.#running = true;
    this.#cb({ target: "gaming-pc", engine: "running", hooksActive: true, clientConnected: false });
    await this.#world.delay();
    if (!this.#world.peerReachable) throw new EngineError({ ...UNREACHABLE, message: "Laptop client did not connect" });
    this.#cb({ target: "laptop", engine: "running", hooksActive: true, clientConnected: true });
  }

  async deactivate(): Promise<void> {
    if (!this.#running) {
      this.#cb({ target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false });
      return;
    }
    this.#cb({ target: "gaming-pc", engine: "stopping", hooksActive: true, clientConnected: false });
    await this.#world.delay();
    this.#running = false;
    this.#cb({ target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false });
  }
}

const FORMATS: Record<RouteId, AudioFormat> = {
  laptopToPc: { sampleRate: 48_000, channels: 2, bitDepth: 32, sample: "f32" },
  micToLaptop: { sampleRate: 48_000, channels: 1, bitDepth: 24, sample: "s24" },
};

export class SimAudio implements AudioEngine {
  readonly kind = "simulated" as const;
  #world: SimWorld;
  #running = new Set<RouteId>();
  #levelCb: (r: RouteId, db: number) => void = () => {};
  #faultCb: (r: RouteId, e: AgentError) => void = () => {};
  #meter: ReturnType<typeof setInterval> | null = null;
  #phase = 0;
  #muted: Record<RouteId, boolean> = { laptopToPc: false, micToLaptop: false };
  #volume: Record<RouteId, number> = { laptopToPc: 0.8, micToLaptop: 1 };

  constructor(world: SimWorld) {
    this.#world = world;
    world.peer.onLink((online) => {
      if (online) return;
      for (const r of [...this.#running]) {
        this.#running.delete(r);
        this.#faultCb(r, UNREACHABLE);
      }
      this.#syncMeter();
    });
  }

  async listDevices() {
    return {
      playback: [
        { id: "sim-out-iem", name: "Headphones (USB DAC) — simulated", isDefault: true },
        { id: "sim-out-monitor", name: "Monitor speakers (HDMI) — simulated", isDefault: false },
      ],
      capture: [
        { id: "sim-in-iem", name: "IEM microphone (USB DAC) — simulated", isDefault: true },
        { id: "sim-in-webcam", name: "Webcam microphone — simulated", isDefault: false },
      ],
    };
  }

  async virtualEndpoint(): Promise<VirtualEndpointState> {
    return this.#world.endpointPresent
      ? { present: true, name: "Virtual cable recording endpoint — simulated", isDefault: false }
      : { present: false, isDefault: null };
  }

  async start(route: RouteId, deviceId: string | null): Promise<AudioFormat> {
    if (!deviceId) throw new EngineError({ code: "device-missing", message: "No device selected." });
    await this.#world.delay();
    if (!this.#world.peerReachable) throw new EngineError(UNREACHABLE);
    if (route === "micToLaptop" && !this.#world.endpointPresent) {
      throw new EngineError({ code: "endpoint-missing", message: "The laptop's virtual microphone endpoint disappeared." });
    }
    this.#running.add(route);
    this.#syncMeter();
    return FORMATS[route];
  }

  async stop(route: RouteId): Promise<void> {
    if (!this.#running.delete(route)) return;
    this.#syncMeter();
    await wait(80); // stands in for the fade-out ramp
  }

  setVolume(route: RouteId, volume: number): void {
    this.#volume[route] = volume;
  }

  setMuted(route: RouteId, muted: boolean): void {
    this.#muted[route] = muted;
  }

  onLevel(cb: (r: RouteId, db: number) => void): void {
    this.#levelCb = cb;
  }

  onFault(cb: (r: RouteId, e: AgentError) => void): void {
    this.#faultCb = cb;
  }

  #syncMeter(): void {
    if (this.#running.size > 0 && !this.#meter) {
      this.#meter = setInterval(() => this.#tick(), 120);
    } else if (this.#running.size === 0 && this.#meter) {
      clearInterval(this.#meter);
      this.#meter = null;
    }
  }

  #tick(): void {
    this.#phase += 1;
    for (const r of this.#running) {
      if (this.#muted[r]) {
        this.#levelCb(r, -120);
        continue;
      }
      // Speech-like envelope for the mic, steadier programme level for system audio.
      const base = r === "micToLaptop" ? -30 + 14 * Math.max(0, Math.sin(this.#phase / 3.1)) : -18 + 4 * Math.sin(this.#phase / 5);
      const jitter = (Math.random() - 0.5) * 6;
      const gain = 20 * Math.log10(Math.max(this.#volume[r], 0.001));
      this.#levelCb(r, Math.min(0, Math.round((base + jitter + gain) * 10) / 10));
    }
  }

  dispose(): void {
    if (this.#meter) clearInterval(this.#meter);
  }
}

export class SimPairing implements Pairing {
  #world: SimWorld;
  #onPaired: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(world: SimWorld, onPaired: () => void) {
    this.#world = world;
    this.#onPaired = onPaired;
  }

  async begin() {
    this.cancel();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    // In simulation the "laptop" types the code a few seconds later.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#world.peerReachable) this.#onPaired();
    }, 4_000);
    return { code, expiresAt: Date.now() + 120_000 };
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async forget(): Promise<void> {
    this.cancel();
  }
}
