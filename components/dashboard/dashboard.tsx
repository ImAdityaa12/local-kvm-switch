"use client";

import { useEffect, useState } from "react";
import { useAgent, type ConnectionStatus } from "@/lib/use-agent";
import type { AgentState, Command } from "@/lib/protocol";
import { TargetSwitch } from "./target-switch";
import { AudioSection } from "./audio-route";
import { Activity, PeerPanel } from "./peer-panel";
import { ErrorNote, Fact, Status } from "./bits";
import { ENGINE_TEXT } from "./format";

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

export function Dashboard() {
  const { status, state, send, lastError, clearError } = useAgent();
  const now = useNow();

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-16 sm:px-6 lg:px-8">
      <TopBar status={status} state={state} send={send} />
      {state ? (
        <Connected state={state} send={send} now={now} lastError={lastError} clearError={clearError} />
      ) : (
        <NotConnected status={status} />
      )}
    </div>
  );
}

function TopBar({ status, state, send }: { status: ConnectionStatus; state: AgentState | null; send: (c: Command) => Promise<unknown> }) {
  const remote = state && (state.input.target === "laptop" || state.input.hooksActive || state.input.pending?.target === "laptop");
  const onLaptop = state?.agent.machine === "laptop";
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-5">
      <p className="text-xl font-semibold tracking-[-0.02em]">LAN KVM</p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="text-ink-2">
          {status === "connected" && state ? (
            <Status tone="live">Agent on {state.agent.name}</Status>
          ) : status === "connecting" || status === "starting" ? (
            <Status tone="warn" busy>
              Looking for the agent
            </Status>
          ) : (
            <Status tone="danger">No agent</Status>
          )}
        </span>
        {state ? (
          <button
            type="button"
            onClick={() => send({ type: "input.returnLocal" })}
            className={
              remote
                ? "press h-11 bg-danger px-5 font-semibold text-ground hover:opacity-90"
                : "press h-11 bg-surface-1 px-5 font-medium hover:bg-surface-2"
            }
          >
            {onLaptop ? "Give input back to Gaming PC" : "Return to Gaming PC"}
          </button>
        ) : null}
      </div>
    </header>
  );
}

function Connected({
  state,
  send,
  now,
  lastError,
  clearError,
}: {
  state: AgentState;
  send: (c: Command) => Promise<unknown>;
  now: number;
  lastError: ReturnType<typeof useAgent>["lastError"];
  clearError: () => void;
}) {
  return (
    <main>
      {state.agent.simulated ? <SimBar state={state} send={send} /> : null}

      {lastError && lastError.message !== state.input.error?.message && lastError.message !== state.peer.error?.message ? (
        <div className="mb-2 flex items-start gap-2">
          <ErrorNote error={lastError} className="flex-1" />
          <button type="button" onClick={clearError} className="press h-full shrink-0 bg-danger-field px-4 py-3 font-medium hover:opacity-80">
            Dismiss
          </button>
        </div>
      ) : null}

      {state.agent.machine === "laptop" ? <LaptopInput state={state} /> : <TargetSwitch state={state} send={send} />}
      {state.agent.machine === "laptop" ? <LaptopAudio /> : state.agent.engines.audio === "none" ? <AudioLater /> : <AudioSection state={state} send={send} now={now} />}

      <div className="mt-28 grid gap-2 md:mt-40 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <PeerPanel state={state} send={send} now={now} />
        <Activity state={state} />
      </div>

      <footer className="mt-28 flex flex-wrap items-end justify-between gap-6 bg-surface-1 px-6 py-10 sm:px-8">
        <p className="text-target leading-[0.9] font-semibold tracking-[-0.045em]">LAN KVM</p>
        <p className="text-ink-2">
          Agent {state.agent.version}, protocol {state.agent.protocol}. Input engine: {state.agent.engines.input}. Audio engine: {state.agent.engines.audio}. Local network only.
        </p>
      </footer>
    </main>
  );
}

/** On the laptop the target is chosen on the gaming PC; this shows what the laptop sees. */
function LaptopInput({ state }: { state: AgentState }) {
  const { input, peer } = state;
  const here = input.target === "laptop";
  return (
    <section aria-labelledby="laptop-heading" className="rise" style={{ "--i": 1 } as React.CSSProperties}>
      <div className={here ? "bg-live p-6 text-live-ink sm:p-10" : "bg-surface-1 p-6 sm:p-10"}>
        <h1 id="laptop-heading" className="text-target leading-[0.92] font-semibold tracking-[-0.045em]">
          {here ? "This laptop has the keyboard" : "Gaming PC has the keyboard"}
        </h1>
        <p className={here ? "mt-5 max-w-[52ch] text-lg opacity-90" : "mt-5 max-w-[52ch] text-lg text-ink-2"}>
          {here
            ? `Input from ${peer.name ?? "the gaming PC"} is controlling this laptop.`
            : "Switch to the laptop from the gaming PC's dashboard."}
          {input.hotkeys ? ` ${input.hotkeys.toGamingPc} sends it back.` : ""}
        </p>
      </div>
      {input.error ? <ErrorNote error={input.error} className="mt-2" /> : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-5 bg-surface-1 px-5 py-5 sm:px-6 lg:grid-cols-3">
        <Fact term="Deskflow client">
          <Status tone={input.engine === "running" ? "live" : input.engine === "error" ? "danger" : "idle"}>{ENGINE_TEXT[input.engine]}</Status>
        </Fact>
        <Fact term="Connected to the gaming PC">
          <Status tone={input.clientConnected ? "live" : "idle"}>{input.clientConnected ? "Yes" : "No"}</Status>
        </Fact>
        <Fact term="Network link">
          <Status tone={peer.link === "online" ? "live" : peer.link === "unpaired" ? "idle" : "danger"}>
            {peer.link === "online" ? "Reachable" : peer.link === "unpaired" ? "Not paired" : "Unreachable"}
          </Status>
        </Fact>
      </dl>
    </section>
  );
}

function LaptopAudio() {
  return (
    <section aria-labelledby="audio-heading" className="rise mt-28 grid gap-2 md:mt-40 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" style={{ "--i": 2 } as React.CSSProperties}>
      <h2 id="audio-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
        Sound goes to the gaming PC
      </h2>
      <p className="max-w-[60ch] text-lg text-ink-2">
        When the gaming PC turns on its laptop audio route, this laptop sends everything it plays, unchanged, at its own mix format. The route is controlled from the gaming PC&apos;s dashboard.
      </p>
    </section>
  );
}

function AudioLater() {
  return (
    <section aria-labelledby="audio-heading" className="rise mt-28 grid gap-2 md:mt-40 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" style={{ "--i": 2 } as React.CSSProperties}>
      <h2 id="audio-heading" className="text-title leading-tight font-semibold tracking-[-0.03em]">
        Audio is unavailable
      </h2>
      <p className="max-w-[60ch] text-lg text-ink-2">
        The native audio helper is not built on this PC, so no audio is routed. Build it with <code>npm run build:audio</code> and restart the agent.
      </p>
    </section>
  );
}

function SimBar({ state, send }: { state: AgentState; send: (c: Command) => Promise<unknown> }) {
  const reachable = state.peer.link === "online";
  const endpoint = state.audio.micToLaptop.virtualEndpoint.present;
  const paired = state.peer.link !== "unpaired";
  return (
    <div role="note" className="mb-2 flex flex-wrap items-center justify-between gap-4 bg-warn-field px-5 py-4 sm:px-6">
      <p className="max-w-[60ch]">
        <span className="font-semibold">Simulated agent.</span> No keyboard, mouse or audio is being routed. Use these to try the failure paths.
      </p>
      <div className="flex flex-wrap gap-2">
        {paired ? (
          <button type="button" onClick={() => send({ type: "sim.setPeerReachable", reachable: !reachable })} className="press h-10 bg-ground px-4 font-medium hover:bg-surface-1">
            {reachable ? "Drop the laptop" : "Bring the laptop back"}
          </button>
        ) : null}
        <button type="button" onClick={() => send({ type: "sim.setEndpointPresent", present: !endpoint })} className="press h-10 bg-ground px-4 font-medium hover:bg-surface-1">
          {endpoint ? "Remove virtual mic" : "Restore virtual mic"}
        </button>
      </div>
    </div>
  );
}

function NotConnected({ status }: { status: ConnectionStatus }) {
  const headline =
    status === "unauthorized"
      ? "The agent refused this page"
      : status === "no-credentials"
        ? "Connect to the agent"
        : status === "offline"
          ? "The agent is not answering"
          : "Looking for the agent";

  return (
    <main className="grid gap-2 pt-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <section className="rise flex min-h-[60vh] flex-col justify-end bg-surface-1 p-6 sm:p-10" style={{ "--i": 0 } as React.CSSProperties}>
        <h1 className="text-target leading-[0.92] font-semibold tracking-[-0.045em]">{headline}</h1>
        <p className="mt-6 max-w-[52ch] text-lg text-ink-2">
          {status === "unauthorized"
            ? "Its token did not match. Open the link the agent printed when it started; it carries a fresh token."
            : status === "offline"
              ? "Retrying in the background. If you closed the agent, start it again. Nothing is being routed while it is down."
              : "This dashboard only shows what the agent on this PC reports. Start it, then open the link it prints."}
        </p>
      </section>
      <section className="rise bg-surface-2 p-6 sm:p-10" style={{ "--i": 1 } as React.CSSProperties}>
        <h2 className="text-title leading-tight font-semibold tracking-[-0.03em]">Start it in simulated mode</h2>
        <p className="mt-3 text-ink-2">Real engines arrive after the two-machine tests. Simulation lets you try every state.</p>
        <pre className="mt-6 overflow-x-auto bg-ground p-4 text-base">
          <code>npm run agent:sim</code>
        </pre>
        <p className="mt-6">
          The agent prints a link like <span className="font-medium">localhost:3000/#agent=…&amp;token=…</span>. The token stays in this browser tab; it is never sent to a web server.
        </p>
      </section>
    </main>
  );
}
