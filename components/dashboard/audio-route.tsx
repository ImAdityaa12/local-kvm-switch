"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentState, AudioDevice, Command, RouteId, RouteState, VirtualEndpointState } from "@/lib/protocol";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatAudio, meterFraction, routeStatusText } from "./format";
import { ErrorNote, Fact, Status, type Tone } from "./bits";

type Send = (c: Command) => Promise<unknown>;

const STATUS_TONE: Record<RouteState["status"], Tone> = {
  off: "idle",
  starting: "warn",
  streaming: "live",
  reconnecting: "warn",
  error: "danger",
};

export function AudioSection({ state, send, now }: { state: AgentState; send: Send; now: number }) {
  const peerName = state.peer.name ?? "the laptop";
  return (
    <section aria-labelledby="audio-heading" className="mt-28 md:mt-40">
      <div className="rise max-w-[60ch]" style={{ "--i": 0 } as React.CSSProperties}>
        <h2 id="audio-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
          Audio stays on your IEM
        </h2>
        <p className="mt-3 text-lg text-ink-2">
          Each direction runs on its own and never touches the keyboard and mouse path. A route shows Streaming only once the agent hears audio arriving.
        </p>
      </div>
      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Route
          id="laptopToPc"
          index={1}
          title="Laptop audio to Gaming PC"
          summary={`Plays everything ${peerName} plays through a device on this PC.`}
          route={state.audio.laptopToPc}
          devices={state.devices.playback}
          deviceLabel="Play on"
          levelLabel="Playback volume"
          simulated={state.agent.simulated}
          send={send}
          now={now}
        />
        <Route
          id="micToLaptop"
          index={2}
          title="Gaming PC microphone to Laptop"
          summary="Sends your IEM microphone to the laptop as a selectable microphone."
          route={state.audio.micToLaptop}
          devices={state.devices.capture}
          deviceLabel="Microphone on this PC"
          levelLabel="Microphone gain"
          simulated={state.agent.simulated}
          send={send}
          now={now}
          endpoint={state.audio.micToLaptop.virtualEndpoint}
        />
      </div>
    </section>
  );
}

function Route({
  id,
  index,
  title,
  summary,
  route,
  devices,
  deviceLabel,
  levelLabel,
  simulated,
  send,
  now,
  endpoint,
}: {
  id: RouteId;
  index: number;
  title: string;
  summary: string;
  route: RouteState;
  devices: AudioDevice[];
  deviceLabel: string;
  levelLabel: string;
  simulated: boolean;
  send: Send;
  now: number;
  endpoint?: VirtualEndpointState;
}) {
  // While dragging, show the local value; otherwise show what the agent reports.
  const [draft, setDraft] = useState<number | null>(null);
  const volume = draft ?? route.volume;

  const busy = route.status === "starting" || route.status === "reconnecting";
  const deviceMissing = route.deviceId !== null && !devices.some((d) => d.id === route.deviceId);
  const format = route.status === "streaming" ? formatAudio(route.format) : null;
  const switchId = `${id}-switch`;

  return (
    <article
      aria-labelledby={`${id}-title`}
      className={cn("rise flex min-w-0 flex-col p-6 sm:p-8", route.status === "streaming" ? "bg-surface-2" : "bg-surface-1")}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            {title}
          </h3>
          <p className="mt-2 text-ink-2">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <label htmlFor={switchId} className="sr-only">
            {title}
          </label>
          <Switch
            id={switchId}
            checked={route.enabled}
            onCheckedChange={(enabled) => send({ type: "audio.setEnabled", route: id, enabled })}
            className="data-checked:bg-live scale-125"
          />
        </div>
      </div>

      <p className="mt-6 text-lg font-medium" aria-live="polite">
        <Status tone={STATUS_TONE[route.status]} busy={busy}>
          {routeStatusText(route, now)}
        </Status>
      </p>

      <Meter levelDb={route.status === "streaming" ? route.levelDb : null} muted={route.muted} simulated={simulated} label={`${title} level`} />

      {route.error && route.status !== "streaming" ? <ErrorNote error={route.error} className="mt-4" /> : null}

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5">
        <div>
          <label className="text-sm text-ink-2" id={`${id}-device`}>
            {deviceLabel}
          </label>
          <Select value={deviceMissing ? undefined : (route.deviceId ?? undefined)} onValueChange={(deviceId) => send({ type: "audio.setDevice", route: id, deviceId })}>
            <SelectTrigger aria-labelledby={`${id}-device`} className="mt-1.5 h-11 w-full min-w-0 bg-ground text-base dark:bg-ground">
              <SelectValue placeholder={deviceMissing ? "Selected device is missing" : "Choose a device"} />
            </SelectTrigger>
            <SelectContent position="popper">
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                  {d.isDefault ? " (Windows default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-2" id={`${id}-vol`}>
              {levelLabel}
            </span>
            <span className="text-sm font-medium">{Math.round(volume * 100)}%</span>
          </div>
          <div className="mt-1.5 flex h-11 items-center gap-4">
            <Slider
              aria-labelledby={`${id}-vol`}
              value={[Math.round(volume * 100)]}
              max={100}
              step={1}
              onValueChange={([v]) => setDraft(v / 100)}
              onValueCommit={async ([v]) => {
                await send({ type: "audio.setVolume", route: id, volume: v / 100 });
                setDraft(null);
              }}
              className="[&_[data-slot=slider-range]]:bg-live [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-track]]:h-1.5"
            />
            <button
              type="button"
              aria-pressed={route.muted}
              onClick={() => send({ type: "audio.setMuted", route: id, muted: !route.muted })}
              className={cn("press h-11 shrink-0 px-4 font-medium", route.muted ? "bg-warn-field text-ink" : "bg-ground hover:bg-surface-2")}
            >
              {route.muted ? "Muted" : "Mute"}
            </button>
          </div>
        </div>
      </div>

      <dl className="mt-auto grid gap-5 pt-8 sm:grid-cols-2">
        <Fact term="Format">{format ?? "Known once streaming"}</Fact>
        {endpoint ? (
          <Fact term="Laptop microphone endpoint">
            {endpoint.present ? (
              <Status tone="live">{endpoint.name ?? "Present"}</Status>
            ) : (
              <Status tone="danger">Missing. Install a virtual audio cable on the laptop.</Status>
            )}
          </Fact>
        ) : (
          <Fact term="Path">Laptop loopback capture, network, this PC</Fact>
        )}
      </dl>
    </article>
  );
}

function Meter({ levelDb, muted, simulated, label }: { levelDb: number | null; muted: boolean; simulated: boolean; label: string }) {
  const f = meterFraction(muted ? null : levelDb);
  const hot = levelDb !== null && levelDb > -3;
  return (
    <div className="mt-4">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={levelDb ?? -60}
        aria-valuetext={levelDb === null ? "No signal" : `${levelDb.toFixed(0)} dBFS`}
        className="relative h-3 overflow-hidden bg-ground"
      >
        <div
          className={cn("meter-fill absolute inset-y-0 left-0 w-full origin-left", hot ? "bg-danger" : "bg-live")}
          style={{ transform: `scaleX(${f})` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-sm text-ink-2">
        <span>{levelDb === null || muted ? "No signal" : `Peak ${levelDb.toFixed(0)} dBFS`}</span>
        {simulated ? <span>Simulated level</span> : <span>0 dBFS</span>}
      </div>
    </div>
  );
}
