// Laptop mode and Gaming PC mode: the gaming PC switches the monitor input, the laptop's display
// layout, the keyboard and mouse, and both audio routes as one sequence (spec §14). Each step
// reports what actually happened; nothing is marked done that was not confirmed.
//
// Laptop mode:    laptop display → Extend, monitor → HDMI 2, input → laptop, audio routes on.
//   The laptop is put in Extend first because in PC screen only it sends no picture to HDMI 2.
//   A failed display, monitor or input step stops the switch; a failed input step also puts the
//   monitor back on HDMI 1, so the gaming PC is not left without its screen.
// Gaming PC mode: input → local, audio routes off, monitor → HDMI 1, laptop → PC screen only.
//   The laptop leaves Extend only once the monitor has confirmed HDMI 1; otherwise the monitor
//   would show nothing at all.
//
// With switching at the screen edges on, the controller starts Deskflow again after Gaming PC
// mode, waiting at the edges; crossing an edge then moves only the keyboard and mouse.

import type { AgentError, Command, Machine, ModeState, ModeStep, ModeStepId, ModeStepStatus, RouteId } from "../../lib/protocol/index.ts";
import { EngineError } from "./engines.ts";
import type { MonitorControl } from "./display/helper.ts";
import type { Store } from "./store.ts";

export interface LaptopDisplayControl {
  online(): boolean;
  /** Resolves once the laptop reports the new layout. */
  setLayout(topology: "extend" | "internal"): Promise<void>;
}

export interface ModeDeps {
  store: Store;
  /** The controller's own commands (input, audio). */
  run(cmd: Command): Promise<void>;
  /** Null when this PC cannot switch the monitor (helper not built). */
  monitor: MonitorControl | null;
  laptop: LaptopDisplayControl;
  now?: () => number;
}

export function idleMode(): ModeState {
  return { current: null, pending: null, target: null, steps: [], monitor: null, monitorControl: false, laptopDisplay: null };
}

const LAPTOP_STEPS: ModeStepId[] = ["laptop-display", "monitor", "input", "laptop-audio", "microphone"];
const GAMING_STEPS: ModeStepId[] = ["input", "laptop-audio", "microphone", "monitor", "laptop-display"];
const ROUTE_STEP: Record<RouteId, ModeStepId> = { laptopToPc: "laptop-audio", micToLaptop: "microphone" };

function message(e: unknown): string {
  return e instanceof EngineError ? e.detail.message : e instanceof Error ? e.message : String(e);
}

/** Thrown when a required step fails; carries the first failure for the dashboard. */
class Stop extends Error {}

export class ModeRunner {
  #d: ModeDeps;
  #now: () => number;
  #queue: Promise<void> = Promise.resolve();
  #running: { target: Machine; done: Promise<void> } | null = null;
  #cancel = false;

  constructor(deps: ModeDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    if (!deps.store.state.mode) {
      deps.store.update((s) => {
        s.mode = idleMode();
      });
    }
  }

  get #mode(): ModeState {
    return this.#d.store.state.mode!;
  }

  #update(fn: (m: ModeState) => void): void {
    this.#d.store.update((s) => fn(s.mode!));
  }

  /** Finds out whether the monitor can be switched from here, and its current input. */
  async refreshMonitor(): Promise<void> {
    const monitor = this.#d.monitor;
    if (!monitor || this.#mode.pending) return;
    const p = await monitor.probe();
    this.#update((m) => {
      m.monitorControl = p.available;
      if (p.available) m.monitor = { input: p.input, at: this.#now(), via: p.via };
      if (m.current === null && m.pending === null && p.input === "hdmi1" && this.#d.store.state.input.target === "gaming-pc") m.current = "gaming-pc";
    });
  }

  /** The laptop reported its display layout. */
  laptopDisplay(topology: ModeState["laptopDisplay"]): void {
    if (this.#mode.laptopDisplay !== topology) this.#update((m) => void (m.laptopDisplay = topology));
  }

  /**
   * Switches to a mode. Asking for the mode already in progress waits for it; asking for
   * Gaming PC mode during a switch to the laptop cancels that switch first.
   */
  set(target: Machine): Promise<void> {
    const running = this.#running;
    if (running?.target === target) return running.done;
    if (running && target === "gaming-pc") {
      this.#cancel = true;
      // Makes a switch to the laptop that is waiting on the input engine fail now.
      void this.#d.run({ type: "input.returnLocal" }).catch(() => {});
    }
    const done = this.#queue.then(() => this.#switch(target));
    this.#queue = done.catch(() => {});
    return done;
  }

  /** The cursor came back to the gaming PC by hotkey: finish the return. False when not in Laptop mode. */
  cursorHome(): boolean {
    if (this.#mode.current !== "laptop" || this.#running) return false;
    this.set("gaming-pc").catch(() => {});
    return true;
  }

  /** The laptop went away: bring the monitor and input home. */
  peerLost(): void {
    if (this.#mode.current === "laptop" || this.#running?.target === "laptop") this.set("gaming-pc").catch(() => {});
  }

  async #switch(target: Machine): Promise<void> {
    if (this.#mode.current === target && !this.#needsWork(target)) return;
    this.#cancel = false;
    const order = target === "laptop" ? LAPTOP_STEPS : GAMING_STEPS;
    this.#update((m) => {
      m.pending = { target, since: this.#now() };
      m.target = target;
      m.steps = order.map((id) => ({ id, status: "waiting" }));
      m.error = undefined;
    });
    const done = target === "laptop" ? this.#toLaptop() : this.#toGamingPc();
    this.#running = { target, done };
    try {
      await done;
    } catch (e) {
      const error: AgentError = e instanceof Stop ? (this.#mode.error ?? { code: "internal", message: e.message }) : { code: "internal", message: message(e) };
      this.#update((m) => {
        m.error = error;
        // Stopped part way: neither mode is fully in place.
        m.current = null;
        for (const s of m.steps) if (s.status === "waiting") s.status = "skipped";
      });
      throw new EngineError(error);
    } finally {
      this.#running = null;
      this.#update((m) => void (m.pending = null));
    }
  }

  /** Already in that mode, but something drifted (e.g. input came home by hotkey). */
  #needsWork(target: Machine): boolean {
    const s = this.#d.store.state;
    // With edge switching on, Deskflow waiting at the edges belongs to Gaming PC mode.
    return target === "laptop" ? s.input.target !== "laptop" : s.input.target !== "gaming-pc" || (s.input.hooksActive && !s.input.edgeSwitch);
  }

  #step(id: ModeStepId, status: ModeStepStatus, detail?: string): void {
    this.#update((m) => {
      const s = m.steps.find((x) => x.id === id);
      if (s) Object.assign(s, { status, detail } satisfies Partial<ModeStep>);
    });
  }

  /** Records a failure that stops the switch. */
  #fail(id: ModeStepId, detail: string, hint?: string): never {
    this.#step(id, "failed", detail);
    this.#update((m) => void (m.error = { code: "internal", message: detail, hint }));
    throw new Stop(detail);
  }

  #checkCancel(): void {
    if (this.#cancel) {
      this.#update((m) => void (m.error = { code: "internal", message: "Switch to Laptop mode cancelled" }));
      throw new Stop("cancelled");
    }
  }

  async #setMonitor(input: "hdmi1" | "hdmi2"): Promise<{ status: "done" | "unconfirmed" | "wrong"; detail: string }> {
    const r = await this.#d.monitor!.set(input);
    this.#update((m) => void (m.monitor = { input: r.readBack, at: this.#now(), via: r.via }));
    const name = input === "hdmi1" ? "HDMI 1" : "HDMI 2";
    if (r.readBack === input) return { status: "done", detail: `The monitor reports ${name} (over ${r.via.toUpperCase()}, ${(r.ms / 1000).toFixed(1)} s)` };
    if (r.readBack === null) return { status: "unconfirmed", detail: `Switch to ${name} sent over ${r.via.toUpperCase()}; the monitor did not report its input` };
    return { status: "wrong", detail: `The monitor still reports ${r.readBack === "hdmi1" ? "HDMI 1" : "HDMI 2"} after the switch to ${name}` };
  }

  async #route(route: RouteId, enabled: boolean): Promise<void> {
    const id = ROUTE_STEP[route];
    const r = this.#d.store.state.audio[route];
    if (enabled ? r.enabled && r.status === "streaming" : !r.enabled && r.status === "off") {
      this.#step(id, "done", enabled ? "Already streaming" : "Already off");
      return;
    }
    this.#step(id, "running");
    try {
      await this.#d.run({ type: "audio.setEnabled", route, enabled });
      const now = this.#d.store.state.audio[route];
      this.#step(id, enabled && now.status !== "streaming" ? "unconfirmed" : "done", enabled ? (now.status === "streaming" ? "Streaming" : "Starting") : "Off");
    } catch (e) {
      // Audio never blocks a mode: report it and carry on.
      this.#step(id, "failed", message(e));
    }
  }

  async #toLaptop(): Promise<void> {
    const { laptop, monitor } = this.#d;
    // 0. Edge switching keeps Deskflow running in Gaming PC mode, and the laptop's Deskflow
    //    only reads its desktop's size as it starts. Stop both, so they start again after
    //    Extend and the cursor reaches the monitor (main.ts, input.prepare).
    if (this.#d.store.state.input.edgeSwitch) await this.#d.run({ type: "input.returnLocal" }).catch(() => {});
    this.#checkCancel();

    // 1. Laptop display: Extend, so HDMI 2 carries a picture before the monitor shows it.
    if (!laptop.online()) this.#fail("laptop-display", "The laptop is not reachable", "Check that the laptop agent is running and on the same network.");
    this.#step("laptop-display", "running");
    try {
      await laptop.setLayout("extend");
      this.#step("laptop-display", "done", "Extend these displays");
    } catch (e) {
      this.#fail("laptop-display", `Could not set the laptop to Extend: ${message(e)}`, "The monitor and input were left as they were.");
    }
    this.#checkCancel();

    // 2. Monitor: HDMI 2.
    let monitorMoved = false;
    if (!monitor || !this.#mode.monitorControl) {
      this.#step("monitor", "skipped", "This PC cannot switch the monitor (no answer over its USB cable or DDC/CI). Use the monitor's Input button.");
    } else {
      this.#step("monitor", "running");
      try {
        const r = await this.#setMonitor("hdmi2");
        if (r.status === "wrong") this.#fail("monitor", r.detail, "The monitor may ignore input changes; switch it with its Input button.");
        this.#step("monitor", r.status, r.detail);
        monitorMoved = true;
      } catch (e) {
        if (e instanceof Stop) throw e;
        this.#fail("monitor", `Could not switch the monitor: ${message(e)}`, "Check that its USB cable is on this PC, or use the monitor's Input button.");
      }
    }
    this.#checkCancel();

    // 3. Keyboard and mouse.
    this.#step("input", "running");
    try {
      await this.#d.run({ type: "input.setTarget", target: "laptop" });
      this.#step("input", "done", "Keyboard and mouse control the laptop");
    } catch (e) {
      let detail = message(e);
      if (monitorMoved) {
        // Do not leave the gaming PC without its screen.
        const back = await this.#setMonitor("hdmi1").catch(() => null);
        this.#step("monitor", back?.status === "done" ? "done" : "failed", back?.status === "done" ? "Put back on HDMI 1 because the input switch failed" : "Could not put the monitor back on HDMI 1; use its Input button");
        detail += back?.status === "done" ? " (monitor put back on HDMI 1)" : "";
      }
      this.#fail("input", detail);
    }

    // 4–5. Audio both ways (failures are reported, not fatal).
    await this.#route("laptopToPc", true);
    await this.#route("micToLaptop", true);
    this.#update((m) => void (m.current = "laptop"));
  }

  async #toGamingPc(): Promise<void> {
    const { laptop, monitor } = this.#d;
    // 1. Keyboard and mouse back to local, first: it is the part that matters most.
    let inputError: string | null = null;
    this.#step("input", "running");
    try {
      await this.#d.run({ type: "input.returnLocal" });
      this.#step("input", "done", "Local input, no hooks installed");
    } catch (e) {
      inputError = message(e);
      this.#step("input", "failed", inputError);
    }

    // 2–3. Audio routes off.
    await this.#route("laptopToPc", false);
    await this.#route("micToLaptop", false);

    // 4. Monitor: HDMI 1.
    let monitorHome = false;
    if (!monitor || !this.#mode.monitorControl) {
      this.#step("monitor", "skipped", "This PC cannot switch the monitor. Use the monitor's Input button.");
    } else {
      this.#step("monitor", "running");
      try {
        const r = await this.#setMonitor("hdmi1");
        this.#step("monitor", r.status === "wrong" ? "failed" : r.status, r.detail);
        monitorHome = r.status === "done";
      } catch (e) {
        this.#step("monitor", "failed", `Could not switch the monitor: ${message(e)}. Use its Input button.`);
      }
    }

    // 5. Laptop: PC screen only, but only once the monitor is confirmed on HDMI 1.
    if (!monitorHome) {
      this.#step("laptop-display", "skipped", "Kept Extend, because the monitor did not confirm HDMI 1; it still shows the laptop.");
    } else if (!laptop.online()) {
      this.#step("laptop-display", "skipped", "The laptop is not reachable; it keeps its display layout.");
    } else {
      this.#step("laptop-display", "running");
      try {
        await laptop.setLayout("internal");
        this.#step("laptop-display", "done", "PC screen only");
      } catch (e) {
        this.#step("laptop-display", "failed", `${message(e)}. The laptop's own screen stays on either way.`);
      }
    }

    if (inputError) {
      this.#update((m) => {
        m.current = null;
        m.error = { code: "internal", message: `Could not confirm local input: ${inputError}`, hint: "Use Return to Gaming PC again. If it keeps failing, end deskflow-core.exe in Task Manager." };
      });
      throw new Stop(inputError);
    }
    this.#update((m) => void (m.current = "gaming-pc"));
  }
}
