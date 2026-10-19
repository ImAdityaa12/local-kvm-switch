// Runs the native display helper (native/kvm-audio/src/bin/kvm-display.rs): one command per
// run, one JSON line back. The gaming PC uses it for the monitor input, the laptop for its
// display layout. Calls run one at a time, so two switches never talk to the monitor at once.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DisplayTopology, MonitorInput } from "../../../lib/protocol/index.ts";
import { EngineError } from "../engines.ts";
import { remoteLog } from "../remote-log.ts";

export function displayHelperPath(repoRoot: string): string {
  return join(repoRoot, "native", "kvm-audio", "target", "release", "kvm-display.exe");
}

const MISSING = {
  code: "engine-missing" as const,
  message: "The display helper is not built on this machine.",
  hint: "Run npm.cmd run build:audio in the project folder, then restart the agent.",
};

/** Gaming PC: the monitor's input. */
export interface MonitorControl {
  /** Whether the monitor answers over USB or the video cable, and its input if it said. */
  probe(): Promise<{ available: boolean; input: MonitorInput | null; via?: "usb" | "hdmi" }>;
  /** Sends the switch and resolves with what the monitor reports afterwards (null: it did not say). */
  set(input: MonitorInput): Promise<{ readBack: MonitorInput | null; via: "usb" | "hdmi"; ms: number }>;
}

/** Laptop: its Windows display layout. */
export interface DisplayLayout {
  get(): Promise<DisplayTopology>;
  /** Resolves once Windows reports the new layout, with how many displays it spans. */
  set(topology: "extend" | "internal"): Promise<{ topology: DisplayTopology; paths: number }>;
  /**
   * Waits until the desktop itself spans `monitors` displays, or `timeoutMs` passes; false then.
   * A new layout is in place before its displays join the desktop (see kvm-display.rs).
   */
  joined(monitors: number, timeoutMs: number): Promise<boolean>;
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

function asInput(v: unknown): MonitorInput | null {
  return v === "hdmi1" || v === "hdmi2" ? v : null;
}

function asTopology(v: unknown): DisplayTopology {
  return v === "extend" || v === "internal" || v === "clone" || v === "external" ? v : "unknown";
}

export class DisplayHelper implements MonitorControl {
  #exe: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(exe: string) {
    this.#exe = exe;
  }

  get built(): boolean {
    return existsSync(this.#exe);
  }

  #run(args: string[], timeoutMs: number): Promise<Reply> {
    const run = this.#queue.then(
      () =>
        new Promise<Reply>((resolve, reject) => {
          if (!this.built) return reject(new EngineError(MISSING));
          execFile(this.#exe, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
            const line = stdout.trim().split(/\r?\n/).pop() ?? "";
            let reply: Reply | null = null;
            try {
              reply = JSON.parse(line) as Reply;
            } catch {
              // fall through
            }
            if (!reply) {
              const why = err?.killed ? "did not finish in time" : (err?.message ?? "gave no answer");
              return reject(new EngineError({ code: "internal", message: `The display helper ${why}.` }));
            }
            remoteLog.write("display", reply.ok ? "info" : "warn", `${args.join(" ")}: ${line.slice(0, 300)}`);
            if (!reply.ok) return reject(new EngineError({ code: "internal", message: String(reply.error ?? "The display helper failed.") }));
            resolve(reply);
          });
        }),
    );
    this.#queue = run.catch(() => {});
    return run;
  }

  async probe(): Promise<{ available: boolean; input: MonitorInput | null; via?: "usb" | "hdmi" }> {
    if (!this.built) return { available: false, input: null };
    const r = await this.#run(["monitor", "probe"], 10_000).catch(() => null);
    if (!r) return { available: false, input: null };
    const via = r.usb === true ? "usb" : r.hdmi === true ? "hdmi" : undefined;
    return { available: via !== undefined, input: asInput(r.input), via };
  }

  async set(input: MonitorInput): Promise<{ readBack: MonitorInput | null; via: "usb" | "hdmi"; ms: number }> {
    const r = await this.#run(["monitor", "set", input], 15_000);
    return { readBack: asInput(r.readBack), via: r.via === "hdmi" ? "hdmi" : "usb", ms: typeof r.ms === "number" ? r.ms : 0 };
  }

  async get(): Promise<DisplayTopology> {
    return asTopology((await this.#run(["topology", "get"], 10_000)).topology);
  }

  async setLayout(topology: "extend" | "internal"): Promise<{ topology: DisplayTopology; paths: number }> {
    const r = await this.#run(["topology", "set", topology], 15_000);
    return { topology: asTopology(r.topology), paths: typeof r.paths === "number" ? r.paths : 0 };
  }

  async joined(monitors: number, timeoutMs: number): Promise<boolean> {
    return (await this.#run(["desktop", "wait", String(monitors), String(timeoutMs)], timeoutMs + 5_000)).settled === true;
  }
}

/** The laptop's layout side of the helper, under the DisplayLayout names. */
export function displayLayout(h: DisplayHelper): DisplayLayout {
  return { get: () => h.get(), set: (t) => h.setLayout(t), joined: (n, ms) => h.joined(n, ms) };
}
