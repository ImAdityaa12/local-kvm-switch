// Adapter contracts. Input and audio are separate so that an audio failure
// cannot touch the input path, and so audio never installs input hooks.

import type {
  AgentError,
  AudioDevice,
  AudioFormat,
  EngineKind,
  Hotkeys,
  InputState,
  RouteId,
  SwitchStep,
  VirtualEndpointState,
} from "../../lib/protocol/index.ts";

export class EngineError extends Error {
  readonly detail: AgentError;
  constructor(detail: AgentError) {
    super(detail.message);
    this.detail = detail;
  }
}

export type InputReport = Pick<InputState, "target" | "engine" | "hooksActive" | "clientConnected"> & {
  /** Progress of an in-flight switch, shown to the user. */
  step?: SwitchStep;
};

export interface InputEngine {
  readonly kind: EngineKind;
  readonly hotkeys?: Hotkeys;
  /** How long a switch to the laptop may take, including the user pressing a hotkey. */
  readonly switchTimeoutMs?: number;
  /**
   * Start sharing and move control to the laptop. Resolves only once the engine
   * confirms the laptop is the active screen.
   */
  activateRemote(): Promise<void>;
  /**
   * Stop sharing entirely: no forwarding, no global hooks. Resolves only once the
   * engine process has exited (or never started).
   */
  deactivate(): Promise<void>;
  /** Engine-observed state changes, including unexpected exits. */
  onReport(cb: (report: InputReport, error?: AgentError) => void): void;
  /**
   * Switching at the screen edges: start sharing with the cursor staying here, so moving it off
   * the edge reaches the laptop. Resolves once the laptop is connected. Gaming PC only.
   */
  standby?(): Promise<void>;
  /** Whether the laptop's edge leads back; applies from the next start. */
  setEdges?(on: boolean): void;
}

export interface PeerLinkEvents {
  onLink(cb: (online: boolean, error?: AgentError) => void): void;
}

export interface AudioEngine {
  readonly kind: EngineKind;
  listDevices(): Promise<{ playback: AudioDevice[]; capture: AudioDevice[] }>;
  virtualEndpoint(): Promise<VirtualEndpointState>;
  /** Resolves with the negotiated format once audio is confirmed flowing end to end. */
  start(route: RouteId, deviceId: string | null): Promise<AudioFormat>;
  /** Ramps to silence before stopping to avoid pops. */
  stop(route: RouteId): Promise<void>;
  setVolume(route: RouteId, volume: number): void;
  setMuted(route: RouteId, muted: boolean): void;
  /** Peak level per metering window, in dBFS. */
  onLevel(cb: (route: RouteId, levelDb: number) => void): void;
  /** A running stream failed (peer gone, device removed). */
  onFault(cb: (route: RouteId, error: AgentError) => void): void;
  /** Receiver health and whether Windows converts the format. */
  onStats?(cb: (route: RouteId, info: RouteInfo) => void): void;
}

export interface RouteInfo {
  stats?: { bufferMs: number; underruns: number; droppedFrames: number };
  conversion?: { from: AudioFormat; to: AudioFormat } | null;
}
