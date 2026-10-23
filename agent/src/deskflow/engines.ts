// Deskflow as the input engine.
//
// Gaming PC: the server process exists only while Laptop is selected, because
// Deskflow keeps global keyboard/mouse hooks for as long as its server runs.
// The exception is switching at the screen edges, which the user turns on: then
// it also runs in Gaming PC mode, waiting for the cursor to leave the screen.
// Laptop: the client process runs while the gaming PC asks for it.
//
// Where the cursor is comes from Deskflow's own enter/exit commands
// (src/lib/deskflow/Computer.cpp runs them on every enter/leave), with the
// server's "switch from" log line as a second signal.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { remoteLog } from "../remote-log.ts";

export type CursorEvent = "enter" | "leave";

/** Give the server a moment with its new client before pressing the hotkey. */
const PRESS_SETTLE_MS = 250;

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

function writeFiles(p: DeskflowPaths, mode: "server" | "client", service = false, edges = false): string {
  mkdirSync(p.dir, { recursive: true });
  const settingsFile = join(p.dir, `deskflow-${mode}.conf`);
  const layoutFile = join(p.dir, "deskflow-layout.conf").replace(/\\/g, "/");
  if (mode === "server") writeFileSync(layoutFile, serverLayout(HOTKEYS, edges));
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
  /** Switching at the screen edges: the laptop's right edge leads back (config.ts). */
  #edges = false;

  /** Presses a hotkey on this machine (hotkey.ts); without it the user presses it. */
  #press: ((hotkey: string) => Promise<void>) | undefined;
  /** How long after pressing the hotkey to wait for the cursor before asking the user to press it. */
  #pressFallbackMs: number;

  constructor(paths: DeskflowPaths, peer: PeerControl, opts: { pressHotkey?: (hotkey: string) => Promise<void>; pressFallbackMs?: number } = {}) {
    this.#p = paths;
    this.#peer = peer;
    this.#press = opts.pressHotkey;
    this.#pressFallbackMs = opts.pressFallbackMs ?? 3_000;
  }

  onReport(cb: (r: InputReport, e?: AgentError) => void): void {
    this.#cb = cb;
  }

  #report(patch: Partial<InputReport>, error?: AgentError): void {
    this.#state = { ...this.#state, ...patch };
    this.#cb(this.#state, error);
  }

  setEdges(on: boolean): void {
    this.#edges = on;
  }

  /** Readies the laptop, starts the server and waits for the laptop to connect. */
  async #startServer(gen: number): Promise<void> {
    const cancelled = () => {
      if (gen !== this.#gen) throw new EngineError({ code: "engine-crashed", message: "Switch cancelled" });
    };
    // Check our own side first, so a missing install is reported for this machine.
    if (!this.#p.exePrefixArgs) await preflight(this.#p.exe);
    this.#report({ step: "waiting-for-laptop" });
    await this.#peer.request({ op: "input.prepare" });
    cancelled();

    this.#report({ step: "starting-engine", engine: "starting" });
    const settings = writeFiles(this.#p, "server", false, this.#edges);
    const connected = this.#connected.wait();
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
    cancelled();
    this.#report({ clientConnected: true });
  }

  async standby(): Promise<void> {
    if (this.#proc?.running) return;
    await this.#startServer(++this.#gen);
  }

  async activateRemote(): Promise<void> {
    const gen = ++this.#gen;
    const cancelled = () => {
      if (gen !== this.#gen) throw new EngineError({ code: "engine-crashed", message: "Switch cancelled" });
    };
    // Running for edge switching but without the laptop: start over. With the laptop
    // connected, only the cursor has to move.
    if (this.#proc?.running && !this.#state.clientConnected) await this.#stopServer();
    cancelled();
    const onLaptop = this.#onLaptop.wait();
    if (!this.#proc?.running) await this.#startServer(gen);
    this.#report({ step: this.#press ? "moving-cursor" : "press-hotkey" });
    if (this.#press) {
      // Press the hotkey for the user; if the cursor has not moved soon after, ask them to.
      const press = this.#press;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const askUser = () => {
        if (gen === this.#gen && this.#state.target !== "laptop") this.#report({ step: "press-hotkey" });
      };
      void delay(PRESS_SETTLE_MS)
        .then(() => {
          if (gen !== this.#gen) return;
          return press(HOTKEYS.toLaptop).then(
            () => void (fallback = setTimeout(askUser, this.#pressFallbackMs)),
            (e: Error) => {
              remoteLog.write("deskflow", "warn", `could not press ${HOTKEYS.toLaptop}: ${e.message}`);
              askUser();
            },
          );
        })
        .catch(() => {});
      try {
        await onLaptop;
      } finally {
        clearTimeout(fallback);
      }
    } else {
      await onLaptop;
    }
    this.#report({ target: "laptop" });
  }

  async deactivate(): Promise<void> {
    this.#gen++;
    await this.#stopServer();
    this.#peer.request({ op: "input.release" }).catch(() => {});
  }

  async #stopServer(): Promise<void> {
    const proc = this.#proc;
    if (proc?.running) {
      this.#stopping = true;
      this.#report({ engine: "stopping", step: "stopping-engine" });
      await proc.stop();
    }
    this.#proc = null;
    this.#report({ target: "gaming-pc", engine: "stopped", hooksActive: false, clientConnected: false });
  }

  /** From the notifier: the cursor entered or left the gaming PC. */
  cursor(event: CursorEvent): void {
    if (!this.#proc?.running) return;
    if (event === "leave") this.#cursorLeft();
    else if (this.#state.target === "laptop") this.#report({ target: "gaming-pc" });
  }

  /** The cursor is on the laptop: by a switch in progress, or over the screen edge. */
  #cursorLeft(): void {
    this.#onLaptop.done();
    if (this.#state.target !== "laptop") this.#report({ target: "laptop" });
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
      if (sw[2] === CLIENT_SCREEN) this.#cursorLeft();
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
  #stopped: Promise<void> | null = null;

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
    // A stop still under way finishes first; otherwise this would find the old client running and keep it.
    await this.#stopped;
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
    const stopped = this.#proc.stop();
    this.#stopped = stopped.catch(() => {});
    try {
      await stopped;
    } finally {
      this.#stopped = null;
    }
  }

  cursor(event: CursorEvent): void {
    if (this.#proc?.running) this.#set({ entered: event === "enter" });
  }
}

export interface GamingPcControl {
  request(req: { op: "input.take" } | { op: "input.return" }, timeoutMs?: number): Promise<void>;
}

/** A switch asked for on the laptop runs on the gaming PC, which may wait up to its own 60 s for the hotkey. */
const TAKE_TIMEOUT_MS = 65_000;
const RETURN_TIMEOUT_MS = 10_000;

/**
 * Laptop side of the input engine. The gaming PC owns the switch (it runs the
 * server and the hotkey), but either machine can start it: taking input asks
 * the gaming PC to switch to this laptop, giving it back asks it to return.
 */
export class LaptopInput implements InputEngine {
  readonly kind = "deskflow" as const;
  readonly hotkeys = HOTKEYS;
  readonly switchTimeoutMs = TAKE_TIMEOUT_MS;
  #client: DeskflowClient;
  #pc: GamingPcControl;
  #cb: (r: InputReport, e?: AgentError) => void = () => {};

  constructor(client: DeskflowClient, pc: GamingPcControl) {
    this.#client = client;
    this.#pc = pc;
  }

  onReport(cb: (r: InputReport, e?: AgentError) => void): void {
    this.#cb = cb;
  }

  /** Called with every status change of the laptop's Deskflow client. */
  clientStatus(st: ClientStatus, error?: AgentError): void {
    this.#cb(
      {
        target: st.entered ? "laptop" : "gaming-pc",
        engine: st.engine,
        hooksActive: st.engine === "running",
        clientConnected: st.connected,
        step: st.connected && !st.entered ? "moving-cursor" : st.engine === "starting" ? "starting-engine" : undefined,
      },
      error,
    );
  }

  activateRemote(): Promise<void> {
    return this.#pc.request({ op: "input.take" }, TAKE_TIMEOUT_MS);
  }

  async deactivate(): Promise<void> {
    // Tell the gaming PC first, so it stops its server rather than waiting out a switch; stop the client either way.
    await Promise.allSettled([this.#pc.request({ op: "input.return" }, RETURN_TIMEOUT_MS), this.#client.stop()]);
  }
}
