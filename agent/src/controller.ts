// Turns validated commands into engine calls and keeps the reported state
// truthful: nothing is marked done until the engine confirms it.

import type { AgentError, Command, Machine, RouteId } from "../../lib/protocol/index.ts";
import { EngineError, type AudioEngine, type InputEngine } from "./engines.ts";
import type { Store } from "./store.ts";

export const SWITCH_TIMEOUT_MS = 10_000;
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface Pairing {
  /** Gaming PC: open a pairing window. Laptop: dial the gaming PC at `address`. */
  begin(address?: string): Promise<void>;
  confirm(accept: boolean): void;
  cancel(): void;
  forget(): Promise<void>;
}

export interface Simulation {
  setPeerReachable(reachable: boolean): void;
  setEndpointPresent(present: boolean): void;
}

export interface ControllerDeps {
  store: Store;
  input: InputEngine;
  audio: AudioEngine;
  peer: { onLink(cb: (online: boolean, error?: AgentError) => void): void };
  pairing: Pairing;
  sim?: Simulation;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const ROUTE_LABEL: Record<RouteId, string> = {
  laptopToPc: "Laptop audio",
  micToLaptop: "Microphone",
};

function asAgentError(e: unknown): AgentError {
  if (e instanceof EngineError) return e.detail;
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new EngineError({ code: "engine-timeout", message: `${what} was not confirmed within ${ms / 1000}s` })),
      ms,
    );
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export class Controller {
  #d: ControllerDeps;
  #now: () => number;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (h: unknown) => void;
  #retryTimers: Partial<Record<RouteId, unknown>> = {};
  #switching: Promise<void> = Promise.resolve();

  constructor(deps: ControllerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

    deps.input.onReport((report, error) => {
      const wasRemote = this.#d.store.state.input.target === "laptop";
      const { step, ...rest } = report;
      this.#d.store.update((s) => {
        Object.assign(s.input, rest);
        if (step && s.input.pending) s.input.pending.step = step;
        if (error) s.input.error = error;
      });
      if (wasRemote && report.target === "gaming-pc" && error) {
        this.#d.store.log("error", `Input engine stopped unexpectedly: ${error.message}. Local input confirmed.`);
      } else if (wasRemote && report.target === "gaming-pc") {
        this.#d.store.log("info", "Cursor came back to the Gaming PC");
      }
      // Gaming PC mode never keeps an engine with global hooks alive. If the
      // cursor came home by hotkey or screen edge, stop the engine.
      const s = this.#d.store.state.input;
      if (s.target === "gaming-pc" && s.hooksActive && s.pending === null && s.engine === "running") {
        this.#serialSwitch("gaming-pc").catch(() => {});
      }
    });

    deps.peer.onLink((online, error) => this.#onPeerLink(online, error));

    deps.audio.onLevel((route, levelDb) => {
      const r = this.#d.store.state.audio[route];
      if (r.status !== "streaming") return;
      this.#d.store.update((s) => {
        s.audio[route].levelDb = levelDb;
      });
    });

    deps.audio.onFault((route, error) => this.#onRouteFault(route, error));

    deps.audio.onStats?.((route, info) => {
      this.#d.store.update((s) => {
        if (info.stats !== undefined) s.audio[route].stats = info.stats;
        if (info.conversion !== undefined) s.audio[route].conversion = info.conversion;
      });
    });
  }

  async handle(cmd: Command): Promise<void> {
    const { store } = this.#d;
    switch (cmd.type) {
      case "input.setTarget":
        return this.#serialSwitch(cmd.target);
      case "input.returnLocal":
        // The emergency action never waits behind a switch in progress: stop the
        // engine now, which makes a pending switch to the laptop fail fast.
        if (store.state.input.pending?.target === "laptop") {
          store.log("warn", "Switch to laptop cancelled");
          await this.#d.input.deactivate().catch(() => {});
        }
        return this.#serialSwitch("gaming-pc");
      case "audio.setEnabled":
        return cmd.enabled ? this.#startRoute(cmd.route) : this.#stopRoute(cmd.route, "Turned off");
      case "audio.setDevice": {
        const list = cmd.route === "laptopToPc" ? store.state.devices.playback : store.state.devices.capture;
        const device = list.find((d) => d.id === cmd.deviceId);
        if (!device) throw new EngineError({ code: "device-missing", message: "That device is no longer present." });
        const wasOn = store.state.audio[cmd.route].enabled;
        if (wasOn) await this.#stopRoute(cmd.route, "Changing device");
        store.update((s) => {
          s.audio[cmd.route].deviceId = device.id;
        });
        store.log("info", `${ROUTE_LABEL[cmd.route]} device set to ${device.name}`);
        if (wasOn) await this.#startRoute(cmd.route);
        return;
      }
      case "audio.setVolume":
        this.#d.audio.setVolume(cmd.route, cmd.volume);
        store.update((s) => {
          s.audio[cmd.route].volume = cmd.volume;
        });
        return;
      case "audio.setMuted":
        this.#d.audio.setMuted(cmd.route, cmd.muted);
        store.update((s) => {
          s.audio[cmd.route].muted = cmd.muted;
        });
        return;
      case "pairing.begin":
        if (store.state.peer.link !== "unpaired") {
          throw new EngineError({ code: "bad-request", message: "Unpair the current device before pairing a new one." });
        }
        return this.#d.pairing.begin(cmd.address);
      case "pairing.confirm":
        return this.#d.pairing.confirm(cmd.accept);
      case "pairing.cancel":
        return this.#d.pairing.cancel();
      case "peer.forget":
        await this.#serialSwitch("gaming-pc");
        await Promise.all([this.#stopRoute("laptopToPc", "Peer removed"), this.#stopRoute("micToLaptop", "Peer removed")]);
        await this.#d.pairing.forget();
        store.update((s) => {
          s.peer = { link: "unpaired", pairing: null };
        });
        store.log("info", "Laptop unpaired");
        return;
      case "sim.setPeerReachable":
      case "sim.setEndpointPresent": {
        const sim = this.#d.sim;
        if (!sim) throw new EngineError({ code: "not-supported", message: "Simulation controls are only available in simulated mode." });
        if (cmd.type === "sim.setPeerReachable") sim.setPeerReachable(cmd.reachable);
        else {
          sim.setEndpointPresent(cmd.present);
          const ep = await this.#d.audio.virtualEndpoint();
          store.update((s) => {
            s.audio.micToLaptop.virtualEndpoint = ep;
          });
        }
        return;
      }
    }
  }

  /** Switches run one at a time; a return-to-local queued behind a remote switch still runs. */
  #serialSwitch(target: Machine): Promise<void> {
    const run = this.#switching.then(() => this.#switch(target));
    this.#switching = run.catch(() => {});
    return run;
  }

  async #switch(target: Machine): Promise<void> {
    const { store, input } = this.#d;
    const s = store.state;
    if (s.input.target === target && s.input.pending === null && !(target === "gaming-pc" && s.input.hooksActive)) {
      return;
    }
    if (target === "laptop" && s.peer.link !== "online") {
      const error: AgentError =
        s.peer.link === "unpaired"
          ? { code: "peer-unpaired", message: "No laptop is paired yet.", hint: "Pair the laptop first." }
          : { code: "peer-unreachable", message: "The laptop is not reachable.", hint: "Check that the laptop agent is running and on the same network." };
      throw new EngineError(error);
    }

    store.update((d) => {
      d.input.pending = { target, since: this.#now() };
      d.input.error = undefined;
    });

    try {
      if (target === "laptop") {
        await withTimeout(input.activateRemote(), input.switchTimeoutMs ?? SWITCH_TIMEOUT_MS, "Switch to laptop");
        store.log("info", "Keyboard and mouse now control the laptop");
      } else {
        await withTimeout(input.deactivate(), SWITCH_TIMEOUT_MS, "Return to Gaming PC");
        store.log("info", "Local input confirmed. Input sharing stopped, no hooks installed.");
      }
    } catch (e) {
      const error = asAgentError(e);
      store.update((d) => {
        d.input.error = error;
      });
      if (target === "laptop") {
        store.log("error", `Switch to laptop failed: ${error.message}`);
        // Leave nothing half-started.
        await withTimeout(input.deactivate(), SWITCH_TIMEOUT_MS, "Return to Gaming PC").catch((stopErr) => {
          const se = asAgentError(stopErr);
          store.update((d) => {
            d.input.error = { ...se, hint: "Use Return to Gaming PC again. If it keeps failing, end the input engine process in Task Manager." };
          });
          store.log("error", `Could not confirm local input: ${se.message}`);
        });
      } else {
        store.log("error", `Could not confirm local input: ${error.message}`);
      }
      throw e;
    } finally {
      store.update((d) => {
        d.input.pending = null;
      });
    }
  }

  #onPeerLink(online: boolean, error?: AgentError): void {
    const { store } = this.#d;
    const prev = store.state.peer.link;
    if (prev === "unpaired") return;
    store.update((s) => {
      s.peer.link = online ? "online" : "offline";
      s.peer.error = online ? undefined : error;
      if (online) s.peer.lastSeenAt = this.#now();
    });
    const who = store.state.peer.name ?? (store.state.agent.machine === "gaming-pc" ? "Laptop" : "Gaming PC");
    if (online && prev !== "online") {
      store.log("info", `${who} is reachable`);
      // Do not wait out the backoff: retry waiting routes now.
      for (const route of ["laptopToPc", "micToLaptop"] as const) {
        const r = store.state.audio[route];
        if (r.enabled && r.status === "reconnecting") {
          this.#startRoute(route, r.retry?.attempt ?? 1).catch(() => {});
        }
      }
    }
    if (!online && prev === "online") {
      store.log("warn", `${who} disconnected${error ? `: ${error.message}` : ""}`);
      if (store.state.input.target === "laptop" || store.state.input.pending?.target === "laptop") {
        store.log("warn", "Returning keyboard and mouse to the Gaming PC");
        this.#serialSwitch("gaming-pc").catch(() => {});
      }
    }
  }

  async #startRoute(route: RouteId, attempt = 0): Promise<void> {
    const { store, audio } = this.#d;
    this.#cancelRetry(route);
    const s = store.state;
    if (route === "micToLaptop" && !s.audio.micToLaptop.virtualEndpoint.present) {
      const error: AgentError = {
        code: "endpoint-missing",
        message: "The laptop has no virtual microphone endpoint.",
        hint: "Install a virtual audio cable on the laptop, then try again.",
      };
      store.update((d) => {
        d.audio[route].enabled = false;
        d.audio[route].status = "error";
        d.audio[route].error = error;
      });
      throw new EngineError(error);
    }
    store.update((d) => {
      d.audio[route].enabled = true;
      d.audio[route].status = attempt === 0 ? "starting" : "reconnecting";
      d.audio[route].error = undefined;
    });
    try {
      const format = await audio.start(route, s.audio[route].deviceId);
      if (!store.state.audio[route].enabled) {
        // Turned off while starting.
        await audio.stop(route);
        return;
      }
      store.update((d) => {
        d.audio[route].status = "streaming";
        d.audio[route].format = format;
        d.audio[route].retry = null;
      });
      store.log("info", `${ROUTE_LABEL[route]} streaming at ${format.sampleRate / 1000} kHz, ${format.channels} ch, ${format.bitDepth}-bit`);
    } catch (e) {
      const error = asAgentError(e);
      if (attempt === 0 && error.code !== "peer-unreachable") {
        store.update((d) => {
          d.audio[route].enabled = false;
          d.audio[route].status = "error";
          d.audio[route].error = error;
        });
        store.log("error", `${ROUTE_LABEL[route]} could not start: ${error.message}`);
        throw e;
      }
      this.#scheduleRetry(route, attempt, error);
    }
  }

  async #stopRoute(route: RouteId, reason: string): Promise<void> {
    const { store, audio } = this.#d;
    this.#cancelRetry(route);
    const was = store.state.audio[route];
    store.update((d) => {
      d.audio[route].enabled = false;
    });
    if (was.status === "off") return;
    await audio.stop(route);
    store.update((d) => {
      d.audio[route].status = "off";
      d.audio[route].levelDb = null;
      d.audio[route].retry = null;
      d.audio[route].stats = null;
      d.audio[route].conversion = null;
      d.audio[route].error = undefined;
    });
    store.log("info", `${ROUTE_LABEL[route]} stopped (${reason.toLowerCase()})`);
  }

  #onRouteFault(route: RouteId, error: AgentError): void {
    const { store } = this.#d;
    const r = store.state.audio[route];
    if (!r.enabled) return;
    store.log("warn", `${ROUTE_LABEL[route]} interrupted: ${error.message}`);
    if (error.code === "device-missing") {
      // Never fall back to a different device on our own.
      store.update((d) => {
        d.audio[route].enabled = false;
        d.audio[route].status = "error";
        d.audio[route].levelDb = null;
        d.audio[route].error = { ...error, hint: "Reconnect the device or choose another one, then turn the route on again." };
      });
      return;
    }
    this.#scheduleRetry(route, 0, error);
  }

  #scheduleRetry(route: RouteId, attempt: number, error: AgentError): void {
    const { store } = this.#d;
    if (attempt >= RETRY_DELAYS_MS.length) {
      store.update((d) => {
        d.audio[route].enabled = false;
        d.audio[route].status = "error";
        d.audio[route].retry = null;
        d.audio[route].levelDb = null;
        d.audio[route].error = { ...error, hint: "Gave up after several tries. Turn the route on again when the laptop is back." };
      });
      store.log("error", `${ROUTE_LABEL[route]} stopped after ${attempt} reconnect attempts`);
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    store.update((d) => {
      d.audio[route].status = "reconnecting";
      d.audio[route].levelDb = null;
      d.audio[route].error = error;
      d.audio[route].retry = { attempt: attempt + 1, nextAt: this.#now() + delay };
    });
    this.#retryTimers[route] = this.#setTimer(() => {
      delete this.#retryTimers[route];
      if (!store.state.audio[route].enabled) return;
      this.#startRoute(route, attempt + 1).catch(() => {});
    }, delay);
  }

  #cancelRetry(route: RouteId): void {
    const t = this.#retryTimers[route];
    if (t !== undefined) {
      this.#clearTimer(t);
      delete this.#retryTimers[route];
    }
  }

  /** Release everything before the process exits. */
  async shutdown(): Promise<void> {
    for (const r of ["laptopToPc", "micToLaptop"] as const) this.#cancelRetry(r);
    await Promise.allSettled([this.#d.audio.stop("laptopToPc"), this.#d.audio.stop("micToLaptop")]);
    await this.#d.input.deactivate();
  }
}
