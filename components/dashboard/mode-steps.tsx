"use client";

import type { DisplayTopology, ModeState, ModeStepId, ModeStepStatus } from "@/lib/protocol";
import { ErrorNote, Fact, Status, type Tone } from "./bits";

const STEP_NAME: Record<ModeStepId, string> = {
  "laptop-display": "Laptop display",
  monitor: "Monitor input",
  input: "Keyboard and mouse",
  "laptop-audio": "Laptop audio to Gaming PC",
  microphone: "Microphone to laptop",
};

const STATUS: Record<ModeStepStatus, { tone: Tone; text: string }> = {
  waiting: { tone: "idle", text: "Waiting" },
  running: { tone: "warn", text: "Working" },
  done: { tone: "live", text: "Done" },
  unconfirmed: { tone: "warn", text: "Sent, not confirmed" },
  failed: { tone: "danger", text: "Failed" },
  skipped: { tone: "idle", text: "Skipped" },
};

const TOPOLOGY: Record<DisplayTopology, string> = {
  extend: "Extend",
  internal: "PC screen only",
  clone: "Duplicate",
  external: "Second screen only",
  unknown: "Unknown",
};

/** Each part of the last (or current) mode switch, with what actually happened. */
export function ModeSteps({ mode }: { mode: ModeState }) {
  if (!mode.target || mode.steps.length === 0) return null;
  const name = mode.target === "laptop" ? "Laptop mode" : "Gaming PC mode";
  return (
    <div className="mt-2 bg-surface-1 px-5 py-5 sm:px-6">
      <p className="font-semibold">
        {mode.pending ? `Switching to ${name}` : `Last switch: ${name}`}
        {!mode.pending && mode.current === null ? " (stopped part way)" : ""}
      </p>
      <ol className="mt-3 grid gap-2">
        {mode.steps.map((s) => (
          <li key={s.id} className="grid gap-x-6 gap-y-0.5 sm:grid-cols-[14rem_11rem_minmax(0,1fr)]">
            <span>{STEP_NAME[s.id]}</span>
            <Status tone={STATUS[s.status].tone} busy={s.status === "running"}>
              {STATUS[s.status].text}
            </Status>
            <span className="text-ink-2">{s.detail ?? ""}</span>
          </li>
        ))}
      </ol>
      {mode.error && !mode.pending ? <ErrorNote error={mode.error} className="mt-3" /> : null}
    </div>
  );
}

/** What the monitor and the laptop's display last reported. */
export function DisplayFacts({ mode }: { mode: ModeState }) {
  const input = mode.monitor?.input;
  return (
    <>
      <Fact term="Monitor input">
        {mode.monitor ? (
          <Status tone={input ? "live" : "warn"}>
            {input === "hdmi1" ? "HDMI 1 (gaming PC)" : input === "hdmi2" ? "HDMI 2 (laptop)" : "Not reported"}
            {mode.monitor.via ? ` · via ${mode.monitor.via.toUpperCase()}` : ""}
          </Status>
        ) : (
          <Status tone="idle">{mode.monitorControl ? "Unknown" : "Not controllable from the gaming PC"}</Status>
        )}
      </Fact>
      <Fact term="Laptop display">
        <Status tone={mode.laptopDisplay ? "live" : "idle"}>{mode.laptopDisplay ? TOPOLOGY[mode.laptopDisplay] : "Unknown"}</Status>
      </Fact>
    </>
  );
}
