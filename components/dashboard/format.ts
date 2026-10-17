import type { AudioFormat, InputEngineStatus, PeerLink, RouteState } from "@/lib/protocol";

export function formatAudio(f: AudioFormat | null): string | null {
  if (!f) return null;
  const rate = `${f.sampleRate % 1000 === 0 ? f.sampleRate / 1000 : (f.sampleRate / 1000).toFixed(1)} kHz`;
  const ch = f.channels === 1 ? "mono" : f.channels === 2 ? "stereo" : `${f.channels} ch`;
  const depth = f.sample === "f32" ? "32-bit float" : `${f.bitDepth}-bit`;
  return `${rate}, ${ch}, ${depth}`;
}

export function routeStatusText(r: RouteState, now: number): string {
  switch (r.status) {
    case "off":
      return "Off";
    case "starting":
      return "Starting, waiting for audio to arrive";
    case "streaming":
      return r.muted ? "Streaming, muted" : "Streaming";
    case "reconnecting": {
      if (!r.retry) return "Reconnecting";
      const secs = Math.max(0, Math.ceil((r.retry.nextAt - now) / 1000));
      return `Reconnecting, try ${r.retry.attempt} of 5${secs > 0 ? ` in ${secs} s` : ""}`;
    }
    case "error":
      return "Stopped by an error";
  }
}

export const ENGINE_TEXT: Record<InputEngineStatus, string> = {
  stopped: "Not running",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  error: "Error",
};

export const LINK_TEXT: Record<PeerLink, string> = {
  unpaired: "Not paired",
  offline: "Unreachable",
  connecting: "Connecting",
  online: "Reachable",
};

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function ago(at: number | undefined, now: number): string {
  if (!at) return "never";
  const s = Math.round((now - at) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : clock(at);
}

/** Maps dBFS to a 0..1 meter position over a 60 dB window. */
export function meterFraction(db: number | null): number {
  if (db === null) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}
