// Deskflow as the input engine.
//
// Gaming PC: the server process exists only while Laptop is selected, because
// Deskflow keeps global keyboard/mouse hooks for as long as its server runs.
// Laptop: the client process runs while the gaming PC asks for it.
//
// Where the cursor is comes from Deskflow's own enter/exit commands
// (src/lib/deskflow/Computer.cpp runs them on every enter/leave), with the
// server's "switch from" log line as a second signal.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentError, InputEngineStatus } from "../../../lib/protocol/index.ts";
import { EngineError, type InputEngine, type InputReport } from "../engines.ts";
import {
  CLIENT_SCREEN,
  DESKFLOW_SERVER_PORT,
  DESKFLOW_TUNNEL_PORT,
  HOTKEYS,
  RE_CLIENT_CONNECTED,
  RE_CLIENT_DISCONNECTED,
  RE_CONNECTED_TO_SERVER,
  RE_DISCONNECTED_FROM_SERVER,
  RE_SWITCH,
  SERVER_SCREEN,
  commandLine,
  serverLayout,
  settingsIni,
} from "./config.ts";
import { DaemonCore, daemonRunning } from "./daemon.ts";
import { CoreProcess, type Core } from "./process.ts";
import { preflight } from "./preflight.ts";

export type CursorEvent = "enter" | "leave";

export interface DeskflowPaths {
  exe: string;
  /** Arguments placed before Deskflow's own (tests run a fake core through node). */
  exePrefixArgs?: string[];
  /** Folder for generated settings; per user, outside the repo. */
  dir: string;
  /** Builds the command Deskflow runs on enter/leave. */
  notifyCommand(event: CursorEvent): string[];
  /** Laptop: the Deskflow service's pipe. While the service answers there, the client runs through it (daemon.ts). */
  servicePipe?: string;
}

/** Deskflow started by the service opens a console for each enter/leave command; this runs it without one. */
export function hiddenCommand(args: string[]): string[] {
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  const runner = fileURLToPath(new URL("../../notify-hidden.vbs", import.meta.url));
  return [wscript, "//B", "//Nologo", runner, ...args].map((a) => a.replace(/\\/g, "/"));
}

function writeFiles(p: DeskflowPaths, mode: "server" | "client", service = false): string {
  mkdirSync(p.dir, { recursive: true });
  const settingsFile = join(p.dir, `deskflow-${mode}.conf`);
  const layoutFile = join(p.dir, "deskflow-layout.conf").replace(/\\/g, "/");
  if (mode === "server") writeFileSync(layoutFile, serverLayout(HOTKEYS));
  const notify = (event: CursorEvent) => commandLine(service ? hiddenCommand(p.notifyCommand(event)) : p.notifyCommand(event));
  writeFileSync(
    settingsFile,
    settingsIni({
      mode,
      port: mode === "server" ? DESKFLOW_SERVER_PORT : DESKFLOW_TUNNEL_PORT,
      layoutFile: mode === "server" ? layoutFile : undefined,
      enterCommand: notify("enter"),
      exitCommand: notify("leave"),
      service: service ? { logFile: logFile(p, mode).replace(/\\/g, "/") } : undefined,
    }),
  );
  return settingsFile;
}

class Waiter {
  #resolve: (() => void) | null = null;
  #reject: ((e: Error) => void) | null = null;
  wait(): Promise<void> {
    const p = new Promise<void>((res, rej) => {
      this.#resolve = res;
      this.#reject = rej;
    });
    // A waiter may be abandoned when an earlier step fails; never leave its rejection unhandled.
    p.catch(() => {});
    return p;
  }
  done(): void {
    this.#resolve?.();
    this.#resolve = this.#reject = null;
  }
  fail(e: Error): void {
    this.#reject?.(e);
    this.#resolve = this.#reject = null;
  }
}

export function logFile(p: DeskflowPaths, mode: "server" | "client"): string {
  return join(p.dir, `deskflow-${mode}.log`);
}

/** The line most likely to say why Deskflow stopped: its last error or warning, else its last line. */
export function lastError(tail: string[]): string | undefined {
  const line = tail.findLast((l) => /\b(FATAL|ERROR|WARNING)\b/.test(l)) ?? tail.at(-1);
  return line?.slice(0, 300);
}

function exitText(code: number | null): string {
  if (code === null) return "ended from outside";
  // Windows crash codes are NTSTATUS values such as 0xC0000005; they read better in hex.
  return code > 0xffff || code < 0 ? `exit code 0x${(code >>> 0).toString(16).toUpperCase()}` : `exit code ${code}`;
}

export function crashed(code: number | null, tail: string[], log: string): AgentError {
  const why = lastError(tail);
  return {
    code: "engine-crashed",
    message: `Deskflow stopped unexpectedly (${exitText(code)})${why ? `. Last output: ${why}` : ""}`,
    hint: `Input is back on the Gaming PC. Deskflow's full output is in ${log}`,
  };
}

export interface PeerControl {
  request(req: { op: "input.prepare" } | { op: "input.release" }): Promise<void>;
}

/** Gaming PC side. */
export class DeskflowServerInput implements InputEngine {
  readonly kind = "deskflow" as const;
  readonly hotkeys = HOTKEYS;
  readonly switchTimeoutMs = 60_000;
  #p: DeskflowPaths;
  #peer: PeerControl;
  #proc: CoreProcess | null = null;
  #cb: (r: InputReport, e?: AgentError) => void = () => {};
  #state: InputReport = { target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false };
  #connected = new Waiter();
  #onLaptop = new Waiter();
  #stopping = false;
  /** Bumped by deactivate(), so an activation in flight knows it was cancelled. */
  #gen = 0;

  constructor(paths: DeskflowPaths, peer: PeerControl) {
    this.#p = paths;
    this.#peer = peer;
  }

  onReport(cb: (r: InputReport, e?: AgentError) => void): void {
    this.#cb = cb;
  }

  #report(patch: Partial<InputReport>, error?: AgentError): void {
    this.#state = { ...this.#state, ...patch };
    this.#cb(this.#state, error);
  }

  async activateRemote(): Promise<void> {
    const gen = ++this.#gen;
    const cancelled = () => {
      if (gen !== this.#gen) throw new EngineError({ code: "engine-crashed", message: "Switch cancelled" });
    };
    // Check our own side first, so a missing install is reported for this machine.
    if (!this.#p.exePrefixArgs) await preflight(this.#p.exe);
    this.#report({ step: "waiting-for-laptop" });
    await this.#peer.request({ op: "input.prepare" });
    cancelled();

    this.#report({ step: "starting-engine", engine: "starting" });
    const settings = writeFiles(this.#p, "server");
    const connected = this.#connected.wait();
    const onLaptop = this.#onLaptop.wait();
    this.#stopping = false;
    this.#proc = new CoreProcess({
      exe: this.#p.exe,
      args: [...(this.#p.exePrefixArgs ?? []), "server", "-s", settings],
      logFile: logFile(this.#p, "server"),
      onLine: (l) => this.#line(l),
      onExit: (code, tail) => this.#exited(code, tail),
    });
    await this.#proc.start();
    if (gen !== this.#gen) {
      await this.#proc?.stop();
      cancelled();
    }
    // From here Deskflow may have global hooks installed; say so.
    this.#report({ engine: "running", hooksActive: true });

    await connected;
    this.#report({ clientConnected: true, step: "press-hotkey" });
    await onLaptop;
    this.#report({ target: "laptop" });
  }

  async deactivate(): Promise<void> {
    this.#gen++;
    const proc = this.#proc;
    if (proc?.running) {
      this.#stopping = true;
      this.#report({ engine: "stopping", step: "stopping-engine" });
      await proc.stop();
    }
    this.#proc = null;
    this.#report({ target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false });
    this.#peer.request({ op: "input.release" }).catch(() => {});
  }

  /** From the notifier: the cursor entered or left the gaming PC. */
  cursor(event: CursorEvent): void {
    if (!this.#proc?.running) return;
    if (event === "leave") this.#onLaptop.done();
    else if (this.#state.target === "laptop") this.#report({ target: "gaming-pc" });
  }

  #line(line: string): void {
    if (RE_CLIENT_CONNECTED.test(line)) {
      this.#connected.done();
      if (!this.#state.clientConnected) this.#report({ clientConnected: true });
      return;
    }
    if (RE_CLIENT_DISCONNECTED.test(line)) {
      // Deskflow moves the cursor back to the server when the active client goes away.
      this.#report({ clientConnected: false, target: "gaming-pc" });
      return;
    }
    const sw = RE_SWITCH.exec(line);
    if (sw) {
      if (sw[2] === CLIENT_SCREEN) this.#onLaptop.done();
      else if (sw[2] === SERVER_SCREEN && this.#state.target === "laptop") this.#report({ target: "gaming-pc" });
    }
  }

  #exited(code: number | null, tail: string[]): void {
    this.#proc = null;
    const unexpected = !this.#stopping;
    const error = crashed(code, tail, logFile(this.#p, "server"));
    this.#report({ target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false }, unexpected ? error : undefined);
    // Stopped on purpose (Return to Gaming PC while waiting for the hotkey): a cancel, not a crash.
    const err = new EngineError(unexpected ? error : { code: "engine-crashed", message: "Switch cancelled" });
    this.#connected.fail(err);
    this.#onLaptop.fail(err);
  }
}

export interface ClientStatus {
  engine: InputEngineStatus;
  /** Connected to the gaming PC's Deskflow server. */
  connected: boolean;
  /** The cursor is on the laptop. */
  entered: boolean;
}

/** Laptop side: runs the Deskflow client while the gaming PC asks for it. */
export class DeskflowClient {
  #p: DeskflowPaths;
  #proc: Core | null = null;
  #status: ClientStatus = { engine: "stopped", connected: false, entered: false };
  #onStatus: (s: ClientStatus, error?: AgentError) => void;
  #warn: (message: string) => void;
  #warned = false;
  #stopping = false;

  constructor(paths: DeskflowPaths, onStatus: (s: ClientStatus, error?: AgentError) => void, warn: (message: string) => void = () => {}) {
    this.#p = paths;
    this.#onStatus = onStatus;
    this.#warn = warn;
  }

  get status(): ClientStatus {
    return this.#status;
  }

  #set(patch: Partial<ClientStatus>, error?: AgentError): void {
    this.#status = { ...this.#status, ...patch };
    this.#onStatus(this.#status, error);
  }

  async start(): Promise<void> {
    if (this.#proc?.running) return;
    const service = this.#p.servicePipe !== undefined && (await daemonRunning(this.#p.servicePipe));
    if (!service && this.#p.servicePipe !== undefined && !this.#warned) {
      this.#warned = true;
      this.#warn(
        "The Deskflow service is off, so Deskflow runs without admin rights: windows that run as admin (Device Manager, Task Manager) and Windows permission prompts will not take the keyboard and mouse. Run npm.cmd run autostart -- enable-deskflow once in the project folder to fix this.",
      );
    }
    // A core the service started is replaced by ours; anything else still blocks.
    if (!this.#p.exePrefixArgs) await preflight(this.#p.exe, [], undefined, service);
    this.#set({ engine: "starting" });
    const settings = writeFiles(this.#p, "client", service);
    const log = logFile(this.#p, "client");
    this.#stopping = false;
    const onLine = (l: string) => {
      if (RE_DISCONNECTED_FROM_SERVER.test(l)) this.#set({ connected: false, entered: false });
      else if (RE_CONNECTED_TO_SERVER.test(l)) this.#set({ connected: true });
    };
    const onExit = (code: number | null, tail: string[]) => {
      this.#proc = null;
      this.#set({ engine: "stopped", connected: false, entered: false }, this.#stopping ? undefined : crashed(code, tail, log));
    };
    this.#proc = service
      ? new DaemonCore({ pipe: this.#p.servicePipe!, settingsFile: settings, logFile: log, onLine, onExit })
      : new CoreProcess({ exe: this.#p.exe, args: [...(this.#p.exePrefixArgs ?? []), "client", "-s", settings], logFile: log, onLine, onExit });
    try {
      await this.#proc.start();
    } catch (e) {
      this.#proc = null;
      this.#set({ engine: "error" }, e instanceof EngineError ? e.detail : undefined);
      throw e;
    }
    this.#set({ engine: "running" });
  }

  async stop(): Promise<void> {
    if (!this.#proc?.running) return;
    this.#stopping = true;
    this.#set({ engine: "stopping" });
    await this.#proc.stop();
  }

  cursor(event: CursorEvent): void {
    if (this.#proc?.running) this.#set({ entered: event === "enter" });
  }
}
