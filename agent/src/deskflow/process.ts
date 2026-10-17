// Starts and stops one deskflow-core process. Output lines are parsed in
// memory and never written to disk.

import { spawn, type ChildProcess } from "node:child_process";
import { EngineError } from "../engines.ts";

export interface CoreProcessOptions {
  exe: string;
  args: string[];
  onLine(line: string): void;
  /** Called when the process exits for any reason, including stop(). */
  onExit(code: number | null): void;
}

export class CoreProcess {
  #o: CoreProcessOptions;
  #child: ChildProcess | null = null;
  #exited: Promise<void> = Promise.resolve();

  constructor(o: CoreProcessOptions) {
    this.#o = o;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): Promise<void> {
    if (this.#child) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.#o.exe, this.#o.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let spawned = false;
      this.#exited = new Promise<void>((done) => {
        child.once("exit", (code) => {
          if (this.#child === child) this.#child = null;
          done();
          if (spawned) this.#o.onExit(code);
        });
      });
      child.once("spawn", () => {
        spawned = true;
        this.#child = child;
        resolve();
      });
      child.once("error", (e: NodeJS.ErrnoException) => {
        if (spawned) return;
        reject(
          new EngineError(
            e.code === "ENOENT"
              ? { code: "engine-missing", message: `Deskflow was not found at ${this.#o.exe}.`, hint: "Install Deskflow 1.27 or pass --deskflow with the path to deskflow-core.exe." }
              : { code: "engine-crashed", message: `Could not start Deskflow: ${e.message}` },
          ),
        );
      });
      for (const stream of [child.stdout, child.stderr]) {
        let rest = "";
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          const parts = (rest + chunk).split(/\r?\n/);
          rest = parts.pop() ?? "";
          if (rest.length > 8192) rest = "";
          for (const line of parts) if (line) this.#o.onLine(line);
        });
      }
    });
  }

  /** Ends the process tree and resolves once it has exited. */
  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.#child;
    if (!child || child.pid === undefined) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    } else {
      child.kill("SIGTERM");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineError({ code: "engine-timeout", message: "Deskflow did not exit" })), timeoutMs);
    });
    try {
      await Promise.race([this.#exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
