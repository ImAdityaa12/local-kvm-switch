// The laptop's dashboard shows and controls the gaming PC's audio routes. The gaming PC owns them:
// it sends its audio state over the peer link (audio.state, a few times a second at most), and the
// laptop sends the dashboard's audio commands back (audio.command), which the gaming PC runs as if
// they came from its own dashboard.

import {
  parseCommand,
  type AgentError,
  type AgentState,
  type AudioDevice,
  type AudioFormat,
  type Command,
  type RouteState,
  type VirtualEndpointState,
} from "../../../lib/protocol/index.ts";

export type AudioMirror = { audio: AgentState["audio"]; devices: AgentState["devices"] };

export type AudioCommand = Extract<Command, { type: "audio.setEnabled" | "audio.setDevice" | "audio.setVolume" | "audio.setMuted" }>;

const AUDIO_COMMANDS: readonly string[] = ["audio.setEnabled", "audio.setDevice", "audio.setVolume", "audio.setMuted"];

export function isAudioCommand(c: Command): c is AudioCommand {
  return AUDIO_COMMANDS.includes(c.type);
}

/** An audio command from the laptop, checked as strictly as the gaming PC's own dashboard's. */
export function parseAudioCommand(v: unknown): AudioCommand | null {
  const parsed = parseCommand(v);
  return parsed.ok && isAudioCommand(parsed.value) ? parsed.value : null;
}

/** How often, at most, the gaming PC sends its audio state (level meters change constantly). */
export const MIRROR_EVERY_MS = 250;
const MAX_DEVICES = 64;
const STATUSES: readonly RouteState["status"][] = ["off", "starting", "streaming", "reconnecting", "error"];
const SAMPLES: readonly AudioFormat["sample"][] = ["f32", "s16", "s24", "s32"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function format(v: unknown): AudioFormat | null {
  if (!isObj(v) || !num(v.sampleRate) || !num(v.channels) || !num(v.bitDepth) || !SAMPLES.includes(v.sample as AudioFormat["sample"])) return null;
  return { sampleRate: v.sampleRate, channels: v.channels, bitDepth: v.bitDepth, sample: v.sample as AudioFormat["sample"] };
}

function error(v: unknown): AgentError | undefined {
  if (!isObj(v) || typeof v.message !== "string") return undefined;
  return { code: "internal", message: v.message.slice(0, 300), hint: text(v.hint, 300) ?? undefined };
}

function route(v: unknown): RouteState | null {
  if (!isObj(v) || typeof v.enabled !== "boolean" || !STATUSES.includes(v.status as RouteState["status"]) || typeof v.muted !== "boolean") return null;
  if (!num(v.volume) || v.volume < 0 || v.volume > 1) return null;
  const r: RouteState = {
    enabled: v.enabled,
    status: v.status as RouteState["status"],
    deviceId: text(v.deviceId, 512),
    format: format(v.format),
    volume: v.volume,
    muted: v.muted,
    levelDb: num(v.levelDb) ? v.levelDb : null,
  };
  const c = v.conversion;
  if (c === null) r.conversion = null;
  else if (isObj(c) && format(c.from) && format(c.to)) r.conversion = { from: format(c.from)!, to: format(c.to)! };
  const st = v.stats;
  if (st === null) r.stats = null;
  else if (isObj(st) && num(st.bufferMs) && num(st.underruns) && num(st.droppedFrames)) r.stats = { bufferMs: st.bufferMs, underruns: st.underruns, droppedFrames: st.droppedFrames };
  const e = error(v.error);
  if (e) r.error = e;
  const rt = v.retry;
  if (rt === null) r.retry = null;
  else if (isObj(rt) && num(rt.attempt) && num(rt.nextAt)) r.retry = { attempt: rt.attempt, nextAt: rt.nextAt };
  return r;
}

function endpoint(v: unknown): VirtualEndpointState {
  if (!isObj(v) || typeof v.present !== "boolean") return { present: false, isDefault: null };
  return { present: v.present, name: text(v.name, 120) ?? undefined, isDefault: typeof v.isDefault === "boolean" ? v.isDefault : null };
}

function devices(v: unknown): AudioDevice[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_DEVICES).flatMap((d) =>
    isObj(d) && typeof d.id === "string" && typeof d.name === "string" && typeof d.isDefault === "boolean"
      ? [{ id: d.id.slice(0, 512), name: d.name.slice(0, 200), isDefault: d.isDefault, mix: format(d.mix) }]
      : [],
  );
}

/** Rebuilds the gaming PC's audio state from the wire, keeping only known fields and values. */
export function parseAudioMirror(v: unknown): AudioMirror | null {
  if (!isObj(v) || !isObj(v.audio) || !isObj(v.devices)) return null;
  const laptopToPc = route(v.audio.laptopToPc);
  const mic = route(v.audio.micToLaptop);
  if (!laptopToPc || !mic) return null;
  // A gaming PC older than this route has none: show it off.
  const pcToLaptop = route(v.audio.pcToLaptop) ?? { enabled: false, status: "off", deviceId: null, format: null, volume: 1, muted: false, levelDb: null };
  return {
    audio: { laptopToPc, pcToLaptop, micToLaptop: { ...mic, virtualEndpoint: endpoint((v.audio.micToLaptop as Obj).virtualEndpoint) } },
    devices: { playback: devices(v.devices.playback), capture: devices(v.devices.capture) },
  };
}
