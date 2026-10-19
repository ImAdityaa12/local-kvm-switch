// Starts and stops one deskflow-core process. Output lines are parsed in
// memory and, when a log file is given, copied there so a failed run can be
// looked at afterwards. Deskflow runs at Debug level, which never logs
// keystrokes (those only appear at Verbose).

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { EngineError } from "../engines.ts";
import { remoteLog, type LogLevel } from "../remote-log.ts";

const TAIL_LINES = 20;

export function lineLevel(line: string): LogLevel {
  const m = /\b(FATAL|ERROR|WARNING|NOTE|INFO|DEBUG\d?)\b/.exec(line);
  if (!m) return "info";
  if (m[1] === "FATAL" || m[1] === "ERROR") return "error";
  if (m[1] === "WARNING") return "warn";
  return m[1].startsWith("DEBUG") ? "debug" : "info";
}

/** A running deskflow-core, however it was started. */
export interface Core {
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CoreProcessOptions {
  exe: string;
  args: string[];
  /** Overwritten on each start with everything Deskflow prints. */
  logFile?: string;
  onLine(line: string): void;
  /** Called when the process exits for any reason, including stop(), with the last lines it printed. */
  onExit(code: number | null, tail: string[]): void;
}

export class CoreProcess implements Core {
  #o: CoreProcessOptions;
  #child: ChildProcess | null = null;
  #exited: Promise<void> = Promise.resolve();
  #tail: string[] = [];
  /** Set by stop(), so the exit that follows is not reported as a failure. */
  #stopRequested = false;
  #log: WriteStream | null = null;

  constructor(o: CoreProcessOptions) {
    this.#o = o;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): Promise<void> {
    if (this.#child) return Promise.resolve();
    this.#tail = [];
    this.#stopRequested = false;
    this.#log?.end();
    this.#log = null;
    if (this.#o.logFile) {
      const log = createWriteStream(this.#o.logFile, { flags: "w" });
      log.on("error", () => {
        if (this.#log === log) this.#log = null;
      });
      log.write(`# ${[this.#o.exe, ...this.#o.args].join(" ")}\r\n# started ${new Date().toISOString()}\r\n`);
      this.#log = log;
    }
    remoteLog.write("deskflow", "info", `started: ${this.#o.args.join(" ")}`);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.#o.exe, this.#o.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let spawned = false;
      this.#exited = new Promise<void>((done) => {
        child.once("exit", (code, signal) => {
          if (this.#child === child) this.#child = null;
          this.#endLog(`exited ${new Date().toISOString()} with ${code === null ? `signal ${signal}` : `code ${code}`}`);
          done();
          if (spawned) this.#o.onExit(code, [...this.#tail]);
        });
      });
      child.once("spawn", () => {
        spawned = true;
        this.#child = child;
        resolve();
      });
      child.once("error", (e: NodeJS.ErrnoException) => {
        if (spawned) return;
        this.#endLog(`could not start: ${e.message}`);
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
          for (const line of parts) if (line) this.#line(line);
        });
      }
    });
  }

  #line(line: string): void {
    this.#tail.push(line);
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    this.#log?.write(line + "\r\n");
    remoteLog.write("deskflow", lineLevel(line), line);
    this.#o.onLine(line);
  }

  #endLog(note: string): void {
    remoteLog.write("deskflow", this.#stopRequested || /code 0$/.test(note) ? "info" : "warn", this.#stopRequested ? `${note} (stopped by the agent)` : note);
    this.#log?.end(`# ${note}\r\n`);
    this.#log = null;
  }

  /** Ends the process tree and resolves once it has exited. */
  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.#child;
    if (!child || child.pid === undefined) return;
    this.#stopRequested = true;
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
