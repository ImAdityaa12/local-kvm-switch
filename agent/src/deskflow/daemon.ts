// Runs the laptop's deskflow-core through the Deskflow service
// (deskflow-daemon.exe), which starts it as SYSTEM in the signed-in session.
//
// Why: Windows drops input sent by a program running as you into windows that
// run as admin (Device Manager, Task Manager, an admin terminal), and nothing
// running as you can reach a permission (UAC) prompt or the lock screen, which
// sit on a separate secure desktop. A core started by the service with
// daemon/elevate=true runs as SYSTEM and follows Windows onto that desktop.
//
// The service listens on a named pipe that any local user may open, and takes
// newline-separated commands, each answered "ok" (Deskflow v1.27.0
// src/lib/deskflow/ipc/DaemonIpcServer.cpp):
//   configFile=<settings>   the file "start" runs with (core/coreMode, daemon/elevate)
//   start                   (re)starts `deskflow-core <mode> --settings <file>`
//   stop                    ends it and forgets the file, so it is not started again at boot
//   noop                    nothing; tells us the service is there
// Its core's stdout goes to the service's own log, so the core is told to
// write a log file of its own (log/toFile) and that file is read here.

import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { EngineError } from "../engines.ts";
import { remoteLog } from "../remote-log.ts";
import { lineLevel, type Core } from "./process.ts";

/** QLocalServer "deskflow-daemon" (Constants.h kDaemonIpcName) is this pipe on Windows. */
export const DAEMON_PIPE = "\\\\.\\pipe\\deskflow-daemon";

const TAIL_LINES = 20;
const POLL_MS = 250;
const HEALTH_MS = 5_000;

/** Sends commands to the Deskflow service and resolves once each was answered "ok". */
export function daemonRequest(pipe: string, commands: string[], timeoutMs = 3_000): Promise<void> {
  for (const c of commands) if (/[\r\n]/.test(c)) throw new Error("service commands cannot contain line breaks");
  return new Promise((resolve, reject) => {
    const socket = connect(pipe);
    let answers = "";
    const timer = setTimeout(() => finish(new Error("the Deskflow service did not answer")), timeoutMs);
    function finish(e?: Error) {
      clearTimeout(timer);
      socket.destroy();
      if (e) reject(e);
      else resolve();
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(commands.map((c) => c + "\n").join("")));
    socket.on("data", (chunk: string) => {
      answers += chunk;
      const lines = answers.split("\n");
      lines.pop();
      const bad = lines.find((l) => l !== "ok");
      if (bad !== undefined) finish(new Error(`the Deskflow service answered "${bad.slice(0, 100)}"`));
      else if (lines.length >= commands.length) finish();
    });
    socket.once("error", (e) => finish(e));
    socket.once("close", () => finish(new Error("the Deskflow service closed the connection")));
  });
}

/** Whether the Deskflow service is running and answering. */
export function daemonRunning(pipe: string): Promise<boolean> {
  return daemonRequest(pipe, ["noop"], 1_500).then(
    () => true,
    () => false,
  );
}

export interface DaemonCoreOptions {
  pipe: string;
  /** Settings for the core; must set core/coreMode, daemon/elevate and log/file. */
  settingsFile: string;
  /** The core's log/file, read back for its output. */
  logFile: string;
  onLine(line: string): void;
  /** Called when the service stops answering while the core should be running. */
  onExit(code: number | null, tail: string[]): void;
}

export class DaemonCore implements Core {
  #o: DaemonCoreOptions;
  #running = false;
  #tail: string[] = [];
  #offset = 0;
  #rest = "";
  #poll: ReturnType<typeof setInterval> | undefined;
  #health: ReturnType<typeof setInterval> | undefined;

  constructor(o: DaemonCoreOptions) {
    if (o.settingsFile.includes("=")) throw new Error("the settings path cannot contain '='");
    this.#o = o;
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#tail = [];
    this.#offset = 0;
    this.#rest = "";
    // The core appends; start each run with an empty log, like a direct start does.
    rmSync(this.#o.logFile, { force: true });
    try {
      await daemonRequest(this.#o.pipe, [`configFile=${this.#o.settingsFile}`, "start"]);
    } catch (e) {
      throw new EngineError({
        code: "engine-crashed",
        message: `The Deskflow service did not start Deskflow: ${(e as Error).message}`,
        hint: "Run npm.cmd run autostart -- enable-deskflow once in the project folder (Windows asks for admin), then try again.",
      });
    }
    remoteLog.write("deskflow", "info", "started through the Deskflow service (as SYSTEM, so admin windows and permission prompts take input)");
    this.#running = true;
    this.#poll = setInterval(() => this.#read(), POLL_MS);
    this.#health = setInterval(() => {
      daemonRunning(this.#o.pipe).then((up) => {
        if (up || !this.#running) return;
        this.#halt();
        remoteLog.write("deskflow", "warn", "the Deskflow service stopped answering");
        this.#o.onExit(null, [...this.#tail, "ERROR: the Deskflow service stopped, so Deskflow stopped with it"]);
      });
    }, HEALTH_MS);
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#halt();
    try {
      await daemonRequest(this.#o.pipe, ["stop"]);
    } catch (e) {
      throw new EngineError({ code: "engine-timeout", message: `The Deskflow service did not stop Deskflow: ${(e as Error).message}` });
    } finally {
      this.#read();
      this.#o.onExit(0, [...this.#tail]);
    }
  }

  #halt(): void {
    this.#running = false;
    clearInterval(this.#poll);
    clearInterval(this.#health);
  }

  /** Reads what the core has added to its log since the last read. */
  #read(): void {
    let fd: number;
    try {
      // Deskflow renames a full log to <file>.1 and starts a new one.
      if (statSync(this.#o.logFile).size < this.#offset) this.#offset = 0;
      fd = openSync(this.#o.logFile, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(64 * 1024);
      let n: number;
      while ((n = readSync(fd, buf, 0, buf.length, this.#offset)) > 0) {
        this.#offset += n;
        const parts = (this.#rest + buf.toString("utf8", 0, n)).split(/\r?\n/);
        this.#rest = parts.pop() ?? "";
        if (this.#rest.length > 8192) this.#rest = "";
        for (const line of parts) if (line) this.#line(line);
      }
    } finally {
      closeSync(fd);
    }
  }

  #line(line: string): void {
    this.#tail.push(line);
    if (this.#tail.length > TAIL_LINES) this.#tail.shift();
    remoteLog.write("deskflow", lineLevel(line), line);
    this.#o.onLine(line);
  }
}
