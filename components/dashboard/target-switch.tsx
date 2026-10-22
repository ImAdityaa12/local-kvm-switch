"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentState, Command, Hotkeys, Machine, ModeStepId, SwitchStep } from "@/lib/protocol";
import { ENGINE_TEXT } from "./format";
import { ErrorNote, Fact, Status } from "./bits";
import { DisplayFacts, ModeSteps } from "./mode-steps";

type Send = (c: Command) => Promise<unknown>;

/**
 * The two positions of a hardware KVM selector. A half lights up only when the
 * input engine has confirmed it, never when it is merely requested. Choosing one
 * switches the whole mode: monitor input, laptop display, input and audio.
 */
export function TargetSwitch({ state, send }: { state: AgentState; send: Send }) {
  const { input, peer, mode } = state;
  const [asked, setAsked] = useState<Machine | null>(null);
  const pendingTarget = mode?.pending?.target ?? input.pending?.target ?? asked;
  const laptopReady = peer.link === "online";

  const choose = async (target: Machine) => {
    setAsked(target);
    try {
      // Agents older than mode switching only switch the input.
      await send(mode ? { type: "mode.set", mode: target } : { type: "input.setTarget", target });
    } finally {
      setAsked(null);
    }
  };

  const laptopName = peer.name ?? "Laptop";

  return (
    <section aria-labelledby="target-heading" className="rise" style={{ "--i": 1 } as React.CSSProperties}>
      <h1 id="target-heading" className="sr-only">
        Which computer has the keyboard and mouse
      </h1>
      <div className="grid gap-2 md:grid-cols-2">
        {/* Same order as the desks: laptop on the left, gaming PC on the right. */}
        <Half
          machine="laptop"
          name="Laptop"
          line={
            laptopReady
              ? `Monitor on HDMI 2, keyboard and mouse control ${laptopName}, audio both ways.`
              : peer.link === "unpaired"
                ? "Pair a laptop below before switching."
                : `${laptopName} is unreachable right now.`
          }
          active={input.target === "laptop"}
          pending={pendingTarget === "laptop" && input.target !== "laptop"}
          pendingText={stepText(input.pending?.step, input.hotkeys, mode?.steps.find((s) => s.status === "running")?.id)}
          disabled={pendingTarget !== null || (!laptopReady && input.target !== "laptop")}
          onChoose={choose}
        />
        <Half
          machine="gaming-pc"
          name="Gaming PC"
          line="Monitor on HDMI 1, local input. Nothing is intercepted or forwarded."
          active={input.target === "gaming-pc"}
          pending={pendingTarget === "gaming-pc" && input.target !== "gaming-pc"}
          pendingText={stepText(input.pending?.step, input.hotkeys, mode?.steps.find((s) => s.status === "running")?.id)}
          disabled={pendingTarget !== null}
          onChoose={choose}
        />
      </div>

      {input.pending?.step === "press-hotkey" && input.hotkeys ? (
        <div role="status" className="mt-2 flex flex-wrap items-center justify-between gap-4 bg-live-soft px-5 py-5 sm:px-6">
          <p className="text-2xl font-semibold tracking-[-0.02em]">
            Press <kbd>{input.hotkeys.toLaptop}</kbd> to move to the laptop
          </p>
          <p className="max-w-[48ch] text-ink-2">
            Deskflow is running and the laptop is connected, but pressing the hotkey for you did not move the cursor (Windows blocks this while a window that runs as admin has focus). Press it on this keyboard.
          </p>
        </div>
      ) : null}

      {mode ? <ModeSteps mode={mode} /> : null}
      {input.error && !mode?.error ? <ErrorNote error={input.error} className="mt-2" /> : null}

      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-5 bg-surface-1 px-5 py-5 sm:px-6 lg:grid-cols-4">
        {mode ? <DisplayFacts mode={mode} /> : null}
        <Fact term="Input engine">
          <Status tone={input.engine === "running" ? "live" : input.engine === "error" ? "danger" : input.engine === "stopped" ? "idle" : "warn"} busy={input.engine === "starting" || input.engine === "stopping"}>
            {ENGINE_TEXT[input.engine]}
            {state.agent.engines.input === "simulated" ? " (simulated)" : ""}
          </Status>
        </Fact>
        <Fact term="Global input hooks">
          <Status tone={input.hooksActive ? "warn" : "live"}>{input.hooksActive ? "Installed by the engine" : "None installed"}</Status>
        </Fact>
        <Fact term="Laptop input client">
          <Status tone={input.clientConnected ? "live" : "idle"}>{input.clientConnected ? "Connected" : "Not connected"}</Status>
        </Fact>
        <Fact term="Hotkeys while on the laptop">
          {input.hotkeys ? (
            <span>
              <kbd>{input.hotkeys.toGamingPc}</kbd> comes back
            </span>
          ) : (
            "None set"
          )}
        </Fact>
      </dl>

      <p className="mt-3 max-w-[70ch] text-ink-2">
        Switch back to Gaming PC before launching a game with anti-cheat. In Gaming PC mode the input engine is not running at all.
      </p>
    </section>
  );
}

const STEP_TEXT: Record<SwitchStep, string> = {
  "waiting-for-laptop": "Asking the laptop to get ready",
  "starting-engine": "Starting Deskflow",
  "moving-cursor": "Moving the cursor to the laptop",
  "press-hotkey": "Waiting for the hotkey",
  "stopping-engine": "Stopping Deskflow",
};

const MODE_STEP_TEXT: Record<ModeStepId, string> = {
  "laptop-display": "Setting the laptop's display",
  monitor: "Switching the monitor",
  input: "Switching the keyboard and mouse",
  "laptop-audio": "Starting laptop audio",
  microphone: "Starting the microphone",
};

function stepText(step: SwitchStep | undefined, hotkeys: Hotkeys | undefined, modeStep?: ModeStepId): string {
  if (step === "press-hotkey" && hotkeys) return `Press ${hotkeys.toLaptop}`;
  if (step) return STEP_TEXT[step];
  return modeStep ? MODE_STEP_TEXT[modeStep] : "Switching, waiting for the engine to confirm";
}

function Half({
  machine,
  name,
  line,
  active,
  pending,
  pendingText,
  disabled,
  onChoose,
}: {
  machine: Machine;
  name: string;
  line: string;
  active: boolean;
  pending: boolean;
  pendingText: string;
  disabled: boolean;
  onChoose: (m: Machine) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-active={active}
      disabled={disabled && !active}
      onClick={() => !active && onChoose(machine)}
      className={cn(
        "press group flex min-h-[19rem] flex-col justify-between p-6 text-left sm:p-8 md:min-h-[24rem] lg:min-h-[44vh]",
        active ? "cursor-default bg-live text-live-ink" : "bg-surface-1 text-ink hover:bg-surface-2",
        pending && "bg-live-soft hover:bg-live-soft",
        disabled && !active && !pending && "cursor-not-allowed text-ink-2 hover:bg-surface-1",
      )}
    >
      <span className="text-lg font-medium">
        {active ? (
          <Status tone="idle" className="[&>span:first-child]:bg-current">Has the keyboard and mouse</Status>
        ) : pending ? (
          <Status tone="live" busy>
            {pendingText}
          </Status>
        ) : (
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{disabled ? "Unavailable" : "Switch here"}</span>
        )}
      </span>
      <span className="block">
        <span className="target-name block text-target leading-[0.9] font-semibold tracking-[-0.045em]">{name}</span>
        <span className={cn("mt-4 block max-w-[34ch] text-lg leading-snug", active ? "opacity-90" : "text-ink-2")}>{line}</span>
      </span>
    </button>
  );
}
