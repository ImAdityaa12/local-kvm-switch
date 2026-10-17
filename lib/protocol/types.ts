// Wire contract between the dashboard and a local agent.
// The dashboard only renders what the agent reports; it never infers that a
// route works. Every status here is agent-confirmed unless marked "requested".

export const PROTOCOL_VERSION = 1;

/** Max bytes accepted for one control message, in either direction from a client. */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

export type Machine = "gaming-pc" | "laptop";

export type EngineKind = "simulated" | "deskflow" | "wasapi" | "none";

export interface AgentError {
  code: ErrorCode;
  message: string;
  /** What the user can do next, in plain words. */
  hint?: string;
}

export type ErrorCode =
  | "peer-unreachable"
  | "peer-unpaired"
  | "firewall-blocked"
  | "engine-missing"
  | "engine-crashed"
  | "engine-timeout"
  | "device-missing"
  | "format-unsupported"
  | "endpoint-missing"
  | "not-supported"
  | "bad-request"
  | "internal";

export type PeerLink = "unpaired" | "offline" | "connecting" | "online";

export interface PeerState {
  link: PeerLink;
  name?: string;
  address?: string;
  /** Epoch ms of the last authenticated message from the peer. */
  lastSeenAt?: number;
  error?: AgentError;
  pairing?: { code: string; expiresAt: number } | null;
}

export type InputEngineStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface InputState {
  /** The target the engine has confirmed. Never set optimistically. */
  target: Machine;
  /** A switch the user asked for that the engine has not confirmed yet. */
  pending: { target: Machine; since: number } | null;
  engine: InputEngineStatus;
  /**
   * True only while an input-sharing process that installs global keyboard or
   * mouse hooks is running. Must be false in Gaming PC mode.
   */
  hooksActive: boolean;
  /** The laptop's input client is connected to the engine. */
  clientConnected: boolean;
  hotkey?: string;
  error?: AgentError;
}

export type RouteId = "laptopToPc" | "micToLaptop";

export type RouteStatus = "off" | "starting" | "streaming" | "reconnecting" | "error";

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  sample: "f32" | "s16" | "s24" | "s32";
}

export interface RouteState {
  /** Requested by the user; the stream may still be starting or failing. */
  enabled: boolean;
  status: RouteStatus;
  /** Device on the gaming PC: playback for laptopToPc, capture for micToLaptop. */
  deviceId: string | null;
  format: AudioFormat | null;
  volume: number;
  muted: boolean;
  /** Peak level in dBFS from the last metering window, when streaming. */
  levelDb: number | null;
  error?: AgentError;
  retry?: { attempt: number; nextAt: number } | null;
}

export interface VirtualEndpointState {
  /** A Windows capture endpoint the agent can feed exists on the laptop. */
  present: boolean;
  name?: string;
  /** The endpoint is the laptop's default recording device. Unknown when null. */
  isDefault: boolean | null;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AgentEvent {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AgentState {
  agent: {
    name: string;
    machine: Machine;
    version: string;
    protocol: number;
    simulated: boolean;
    engines: { input: EngineKind; audio: EngineKind };
  };
  peer: PeerState;
  input: InputState;
  audio: {
    laptopToPc: RouteState;
    micToLaptop: RouteState & { virtualEndpoint: VirtualEndpointState };
  };
  devices: { playback: AudioDevice[]; capture: AudioDevice[] };
  events: AgentEvent[];
}

// ---- Client → agent ----

export type Command =
  | { type: "input.setTarget"; target: Machine }
  | { type: "input.returnLocal" }
  | { type: "audio.setEnabled"; route: RouteId; enabled: boolean }
  | { type: "audio.setDevice"; route: RouteId; deviceId: string }
  | { type: "audio.setVolume"; route: RouteId; volume: number }
  | { type: "audio.setMuted"; route: RouteId; muted: boolean }
  | { type: "pairing.begin" }
  | { type: "pairing.cancel" }
  | { type: "peer.forget" }
  | { type: "sim.setPeerReachable"; reachable: boolean }
  | { type: "sim.setEndpointPresent"; present: boolean };

export type CommandType = Command["type"];

export type ClientMessage =
  | { type: "hello"; token: string; protocol: number }
  | { type: "command"; id: string; command: Command };

// ---- Agent → client ----

export type ServerMessage =
  | { type: "welcome"; protocol: number }
  | { type: "state"; seq: number; state: AgentState }
  | { type: "ack"; id: string; ok: true }
  | { type: "ack"; id: string; ok: false; error: AgentError }
  | { type: "goodbye"; reason: string };
