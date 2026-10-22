// Runs the native audio helper (native/kvm-audio) and speaks its line protocol:
// JSON events on stdout, JSON commands on stdin.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { AudioDevice, AudioFormat } from "../../../lib/protocol/index.ts";
import { EngineError } from "../engines.ts";
import { remoteLog } from "../remote-log.ts";

export function helperPath(repoRoot: string): string {
  return join(repoRoot, "native", "kvm-audio", "target", "release", "kvm-audio.exe");
}

export type HelperEvent = Record<string, unknown> & { event: string };

export class HelperProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  #handlers = new Map<string, ((e: HelperEvent) => void)[]>();

  private constructor(child: ChildProcess) {
    this.child = child;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    let rest = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      if (rest.length > 65_536) rest = "";
      for (const line of lines) {
        if (!line) continue;
        let e: HelperEvent;
        try {
          e = JSON.parse(line) as HelperEvent;
        } catch {
          continue;
        }
        if (typeof e.event !== "string") continue;
        for (const h of this.#handlers.get(e.event) ?? []) h(e);
        for (const h of this.#handlers.get("*") ?? []) h(e);
      }
    });
    // The helper only writes to stderr when it panics.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => remoteLog.write("audio", "error", chunk.trimEnd()));
  }

  static spawn(exe: string, args: string[]): HelperProcess {
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const h = new HelperProcess(child);
    child.once("error", (e: NodeJS.ErrnoException) => {
      const err: HelperEvent = {
        event: "error",
        code: e.code === "ENOENT" ? "engine-missing" : "internal",
        message: e.code === "ENOENT" ? `The audio helper was not found at ${exe}.` : e.message,
      };
      for (const fn of h.#handlers.get("error") ?? []) fn(err);
      for (const fn of h.#handlers.get("*") ?? []) fn(err);
    });
    return h;
  }

  static async list(exe: string): Promise<{ playback: (AudioDevice & { mix: AudioFormat | null })[]; capture: (AudioDevice & { mix: AudioFormat | null })[] }> {
    const h = HelperProcess.spawn(exe, ["list"]);
    return new Promise((resolve, reject) => {
      h.on("devices", (e) => resolve(e as never));
      h.on("error", (e) => reject(new EngineError({ code: e.code === "engine-missing" ? "engine-missing" : "internal", message: String(e.message) })));
      h.exited.then(() => reject(new EngineError({ code: "internal", message: "The audio helper did not list devices." })));
    });
  }

  /** Makes these endpoints Windows' default playback / recording devices (every role). */
  static async setDefault(exe: string, ids: string[]): Promise<void> {
    const h = HelperProcess.spawn(exe, ["set-default", ...ids]);
    return new Promise((resolve, reject) => {
      h.on("default-set", () => resolve());
      h.on("error", (e) => reject(new EngineError({ code: e.code === "engine-missing" ? "engine-missing" : "internal", message: `Windows did not change the default device: ${String(e.message)}` })));
      h.exited.then(() => reject(new EngineError({ code: "internal", message: "The audio helper did not change the default device." })));
    });
  }

  on(event: string, fn: (e: HelperEvent) => void): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(fn);
    this.#handlers.set(event, list);
  }

  command(cmd: Record<string, unknown>): void {
    if (this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(cmd) + "\n");
  }

  /** Asks the helper to fade out and exit; closing stdin has the same effect. */
  stop(): void {
    this.command({ cmd: "stop" });
    this.child.stdin?.end();
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
}
