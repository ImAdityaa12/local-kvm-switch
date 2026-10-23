// The other machine's drives as one drive letter here, and this machine's drives for it.
//
// rclone serves this machine's drives over WebDAV on loopback only, behind a password derived
// from the pairing key, so another Windows user on this machine cannot use it. The other machine
// reaches it only through the peer link (tunnel "files") and mounts it with rclone and WinFsp as a
// network drive, where each drive is a folder named by its letter: G:\C\Users\..., G:\D\Games\...
// Both run as the signed-in user, so they open what that user can open, and nothing more.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import type { AgentError, FilesTool, Machine, SharingState } from "../../../lib/protocol/index.ts";
import { EngineError } from "../engines.ts";
import type { Store } from "../store.ts";
import type { PathMap, WireFile } from "./clipboard.ts";

/** rclone's WebDAV server on each machine, loopback only. */
export const FILES_SERVE_PORT = 24840;
/** Loopback port on each machine that tunnels to the other machine's FILES_SERVE_PORT. */
export const FILES_TUNNEL_PORT = 24841;
export const FILES_TARGET = "files";
const USER = "lan-kvm";
/** After the link drops, how long the drive stays before it is removed (a short drop keeps it). */
const UNMOUNT_AFTER_MS = 20_000;
const RETRY_MS = 10_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const SETUP_HINT = "Run npm.cmd run setup:files in the project folder (it installs rclone and WinFsp with winget), then wait a few seconds.";

/** rclone from --rclone, PATH, or where winget puts it. */
export function findRclone(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(";")) {
    if (dir && existsSync(join(dir, "rclone.exe"))) return join(dir, "rclone.exe");
  }
  const winget = join(env.LOCALAPPDATA ?? "", "Microsoft", "WinGet");
  const link = join(winget, "Links", "rclone.exe");
  if (existsSync(link)) return link;
  try {
    const packages = join(winget, "Packages");
    for (const pkg of readdirSync(packages).filter((d) => d.startsWith("Rclone.Rclone_"))) {
      for (const sub of readdirSync(join(packages, pkg))) {
        const exe = join(packages, pkg, sub, "rclone.exe");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    // no winget packages
  }
  return null;
}

/** WinFsp lets rclone add a drive letter; only the machine that mounts needs it. */
export function winFspInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env["ProgramFiles(x86)"], env.ProgramFiles].some((base) => !!base && existsSync(join(base, "WinFsp", "bin", "winfsp-x64.dll")));
}

/** Both machines derive the same password from the pairing key; it never crosses the network. */
export function filesPassword(psk: Buffer): string {
  return createHmac("sha256", psk).update("lan-kvm files").digest("base64url");
}

/** This machine's local and removable drives, e.g. ["C", "D"]. Network drives (the other machine's among them) are left out. */
export function localDrives(): Promise<string[]> {
  const script = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | ForEach-Object { $_.DeviceID }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      const drives = err ? [] : [...stdout.matchAll(/^([A-Za-z]):\s*$/gm)].map((m) => m[1].toUpperCase());
      resolve(drives.length ? drives : existsSync("C:\\") ? ["C"] : []);
    });
  });
}

/** The preferred letter if free, else the last free one from Z down. */
export function pickLetter(preferred: string, inUse: (letter: string) => boolean): string | null {
  if (!inUse(preferred)) return preferred;
  for (let c = "Z".charCodeAt(0); c >= "E".charCodeAt(0); c--) {
    const l = String.fromCharCode(c);
    if (!inUse(l)) return l;
  }
  return null;
}

export function serveArgs(o: { logFile: string }): string[] {
  return [
    "serve",
    "webdav",
    ":combine:",
    "--addr",
    `127.0.0.1:${FILES_SERVE_PORT}`,
    "--disable-dir-list",
    // Files created on this machine show on the other within a few seconds (with its own cache).
    "--dir-cache-time",
    "1s",
    "--log-file",
    o.logFile,
    "--log-level",
    "NOTICE",
  ];
}

export function serveEnv(drives: string[], password: string): Record<string, string> {
  return {
    RCLONE_CONFIG: "NUL",
    RCLONE_USER: USER,
    RCLONE_PASS: password,
    RCLONE_COMBINE_UPSTREAMS: drives.map((d) => `${d}=${d}:/`).join(" "),
  };
}

export function mountArgs(o: { letter: string; label: string; cacheDir: string; logFile: string }): string[] {
  return [
    "mount",
    ":webdav:",
    `${o.letter}:`,
    "--network-mode",
    "--volname",
    `\\\\lan-kvm\\${o.label}`,
    // Apps can open, seek and save files as on a local disk; reads are kept for an hour, and a
    // saved file reaches the other machine a second after it is closed (rclone waits 5 s by default).
    "--vfs-cache-mode",
    "full",
    "--vfs-cache-max-size",
    "10G",
    "--vfs-cache-max-age",
    "1h",
    "--cache-dir",
    o.cacheDir,
    "--vfs-write-back",
    "1s",
    // Files created on the other machine show here within a few seconds.
    "--dir-cache-time",
    "2s",
    "--log-file",
    o.logFile,
    "--log-level",
    "NOTICE",
  ];
}

export function mountEnv(obscuredPassword: string): Record<string, string> {
  return {
    RCLONE_CONFIG: "NUL",
    RCLONE_WEBDAV_URL: `http://127.0.0.1:${FILES_TUNNEL_PORT}`,
    RCLONE_WEBDAV_VENDOR: "rclone",
    RCLONE_WEBDAV_USER: USER,
    RCLONE_WEBDAV_PASS: obscuredPassword,
  };
}

const DRIVE_PATH = /^([A-Za-z]):\\(.*)$/s;

/**
 * Copied files cross as paths, and the other machine pastes them from the drive: a file here is
 * named for the other machine by its own drive letter, and a file on the other machine's drive
 * (mounted here) by its path there.
 */
export function pathMap(o: { serving: () => string[] | null; peerServing: () => string[] | null; mounted: () => string | null }): PathMap {
  return {
    outgoing(path) {
      const m = DRIVE_PATH.exec(path);
      if (!m) return null;
      const letter = m[1].toUpperCase();
      const mount = o.mounted();
      if (mount && letter === mount) {
        // G:\C\Users\x is C:\Users\x on the other machine.
        const inner = /^([A-Za-z])(?:\\(.*))?$/s.exec(m[2]);
        return inner ? { owner: "receiver", path: `${inner[1].toUpperCase()}:\\${inner[2] ?? ""}` } : null;
      }
      return o.serving()?.includes(letter) ? { owner: "sender", path: `${letter}:\\${m[2]}` } : null;
    },
    incoming(f: WireFile) {
      const m = DRIVE_PATH.exec(f.path);
      if (!m || m[2].split("\\").includes("..")) return null;
      const letter = m[1].toUpperCase();
      if (f.owner === "receiver") return `${letter}:\\${m[2]}`;
      const mount = o.mounted();
      if (!mount || !o.peerServing()?.includes(letter)) return null;
      return `${mount}:\\${letter}${m[2] ? `\\${m[2]}` : ""}`;
    },
  };
}

/**
 * Whether a drive letter is in use. Never synchronous: the other machine's drive is served
 * through this agent's own peer link, so a blocking call on it would wait for itself. A drive
 * that does not answer in time (a dead network drive) counts as in use.
 */
export function driveExists(letter: string, timeoutMs = 2_000): Promise<boolean> {
  return Promise.race([
    access(`${letter}:\\`).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs).unref()),
  ]);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, every = 300): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

function obscure(rclone: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(rclone, ["obscure", "-"], { windowsHide: true, timeout: 10_000, env: { ...process.env, RCLONE_CONFIG: "NUL" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
    p.stdin?.end(password + "\n");
  });
}

function trimLog(file: string): void {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) rmSync(file);
  } catch {
    // no log yet
  }
}

function lastLogLine(file: string): string | null {
  try {
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    const line = lines.reverse().find((l) => /ERROR|CRITICAL|Fatal/i.test(l)) ?? null;
    return line ? line.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*/, "").slice(0, 300) : null;
  } catch {
    return null;
  }
}

export interface FileShareOptions {
  machine: Machine;
  /** The agent's data folder: logs, the read cache and the pid file. */
  dir: string;
  store: Store;
  /** The pairing key, or null when unpaired. */
  psk: () => Buffer | null;
  online: () => boolean;
  /** Tells the other machine which drives this one offers (null: none). */
  announce: (serving: string[] | null) => void;
  saveEnabled: (on: boolean) => void;
  rclone?: string;
}

export class FileShare {
  #o: FileShareOptions;
  #rclone: string | null = null;
  #serve: ChildProcess | null = null;
  #servePsk: string | null = null;
  #mount: ChildProcess | null = null;
  #unmountTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #busy: Promise<void> = Promise.resolve();
  #drivesCheckedAt = 0;
  /** The drives the other machine last said it offers. */
  #peerDrives: string[] | null = null;

  constructor(o: FileShareOptions) {
    this.#o = o;
  }

  get #files() {
    return this.#o.store.state.sharing!.files;
  }

  #set(mutate: (f: SharingState["files"]) => void): void {
    this.#o.store.update((s) => mutate(s.sharing!.files));
  }

  #log(level: "info" | "warn" | "error", message: string): void {
    this.#o.store.log(level, message);
  }

  /** One change at a time: starting, stopping and mounting never overlap. */
  #serial(fn: () => Promise<void>): Promise<void> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => {});
    return run;
  }

  get #pidFile(): string {
    return join(this.#o.dir, "files-pids.json");
  }

  #savePids(): void {
    try {
      writeFileSync(this.#pidFile, JSON.stringify([this.#serve?.pid, this.#mount?.pid].filter(Boolean)));
    } catch {
      // the data folder is gone; nothing to clean up later either
    }
  }

  /** rclone processes an earlier agent left behind (it crashed or was killed) still hold the port and the letter. */
  async #cleanUp(): Promise<void> {
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.#pidFile, "utf8"));
    } catch {
      return;
    }
    for (const pid of pids.filter((p) => Number.isInteger(p))) {
      const image = await new Promise<string>((resolve) =>
        execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => resolve(err ? "" : out)),
      );
      if (/^"rclone\.exe"/i.test(image.trim())) {
        await new Promise((resolve) => execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true }, resolve));
      }
    }
    rmSync(this.#pidFile, { force: true });
  }

  async start(): Promise<void> {
    await this.#cleanUp();
    this.refreshTools();
  }

  /** Notices rclone and WinFsp once they are installed, and drives that come and go. */
  refreshTools(): void {
    this.#rclone = this.#o.rclone ?? findRclone();
    const missing: FilesTool[] = [];
    if (!this.#rclone) missing.push("rclone");
    if (!winFspInstalled()) missing.push("winfsp");
    if (JSON.stringify(missing) !== JSON.stringify(this.#files.missing)) {
      this.#set((f) => {
        f.missing = missing;
      });
      if (missing.length === 0) this.#log("info", "rclone and WinFsp are installed, so the two machines can open each other's drives");
      void this.#reconcile();
    } else if (this.#serve && Date.now() - this.#drivesCheckedAt > 60_000) {
      // A USB drive plugged in or out: serve the new set.
      this.#drivesCheckedAt = Date.now();
      void localDrives().then((drives) => {
        if (this.#serve && JSON.stringify(drives) !== JSON.stringify(this.#files.serving)) {
          void this.#serial(async () => {
            await this.#stopServe();
          }).then(() => this.#reconcile());
        }
      });
    }
  }

  setEnabled(on: boolean): Promise<void> {
    this.#o.saveEnabled(on);
    this.#set((f) => {
      f.enabled = on;
    });
    this.#log("info", on ? "This PC's drives are offered to the other machine" : "This PC's drives are no longer offered to the other machine");
    return this.#reconcile();
  }

  linkChanged(online: boolean): void {
    if (online) {
      if (this.#unmountTimer) clearTimeout(this.#unmountTimer);
      this.#unmountTimer = null;
      void this.#reconcile().then(() => this.#o.announce(this.#files.serving));
      return;
    }
    // A short drop keeps the drive; a long one removes it, so Explorer does not hang on it.
    if (this.#mount && !this.#unmountTimer) {
      this.#unmountTimer = setTimeout(() => {
        this.#unmountTimer = null;
        if (!this.#o.online()) {
          this.#set((f) => {
            f.remote.offered = false;
          });
          void this.#serial(() => this.#stopMount());
        }
      }, UNMOUNT_AFTER_MS);
    }
  }

  /** The other machine said which drives it offers. */
  peerServing(drives: string[] | null): void {
    const offered = !!drives && drives.length > 0;
    if (offered !== this.#files.remote.offered) {
      this.#set((f) => {
        f.remote.offered = offered;
      });
    }
    this.#peerDrives = drives;
    void this.#reconcile();
  }

  get peerDrives(): string[] | null {
    return this.#peerDrives;
  }

  /** The drive letter of the other machine's drives, while they are mounted. */
  get mountedLetter(): string | null {
    return this.#files.remote.status === "mounted" ? this.#files.remote.letter : null;
  }

  async openDrive(): Promise<void> {
    const letter = this.mountedLetter;
    if (!letter) {
      throw new EngineError({ code: "not-supported", message: "The other machine's drive is not connected." });
    }
    spawn("explorer.exe", [`${letter}:\\`], { detached: true, stdio: "ignore" }).unref();
  }

  async dispose(): Promise<void> {
    this.#stopped = true;
    if (this.#unmountTimer) clearTimeout(this.#unmountTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    await this.#serial(async () => {
      await this.#stopMount();
      await this.#stopServe();
    });
    rmSync(this.#pidFile, { force: true });
  }

  /** Brings the processes in line with the settings, the link and the other machine. */
  #reconcile(): Promise<void> {
    return this.#serial(async () => {
      if (this.#stopped) return;
      const psk = this.#o.psk();
      const key = psk ? filesPassword(psk) : null;
      const wantServe = this.#files.enabled && !!this.#rclone && !!key;
      if (this.#serve && (!wantServe || key !== this.#servePsk)) await this.#stopServe();
      if (wantServe && !this.#serve) await this.#startServe(key!);
      const wantMount = this.#files.remote.offered && !!this.#rclone && !this.#files.missing.includes("winfsp") && !!key && this.#o.online();
      if (this.#mount && !wantMount && this.#o.online()) await this.#stopMount();
      if (wantMount && !this.#mount) await this.#startMount(key!);
    });
  }

  #retry(): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#reconcile();
    }, RETRY_MS);
  }

  async #startServe(password: string): Promise<void> {
    const drives = await localDrives();
    this.#drivesCheckedAt = Date.now();
    if (drives.length === 0) {
      this.#log("warn", "No local drives were found to offer to the other machine");
      return;
    }
    if (await portOpen(FILES_SERVE_PORT)) {
      this.#log("warn", `Port ${FILES_SERVE_PORT} is already in use, so this PC's drives cannot be offered. Restart this PC if it stays.`);
      this.#retry();
      return;
    }
    const logFile = join(this.#o.dir, "files-serve.log");
    trimLog(logFile);
    const child = spawn(this.#rclone!, serveArgs({ logFile }), { windowsHide: true, stdio: "ignore", env: { ...process.env, ...serveEnv(drives, password) } });
    this.#serve = child;
    this.#servePsk = password;
    this.#savePids();
    child.on("error", () => {});
    child.on("exit", (code) => {
      if (this.#serve !== child) return;
      this.#serve = null;
      this.#savePids();
      this.#set((f) => {
        f.serving = null;
      });
      this.#o.announce(null);
      this.#log("warn", `Offering this PC's drives stopped (rclone exit code ${code}). ${lastLogLine(logFile) ?? ""}`.trim());
      this.#retry();
    });
    const up = await until(() => this.#serve === child && portOpen(FILES_SERVE_PORT), 10_000);
    if (!up || this.#serve !== child) return;
    this.#set((f) => {
      f.serving = drives;
    });
    this.#o.announce(drives);
    this.#log("info", `Offering drives ${drives.map((d) => `${d}:`).join(", ")} to the other machine`);
  }

  async #stopServe(): Promise<void> {
    const child = this.#serve;
    if (!child) return;
    this.#serve = null;
    await this.#kill(child);
    this.#savePids();
    this.#set((f) => {
      f.serving = null;
    });
    this.#o.announce(null);
  }

  async #startMount(password: string): Promise<void> {
    const preferred = this.#o.machine === "laptop" ? "G" : "L";
    const candidates = [preferred, ..."EFGHIJKLMNOPQRSTUVWXYZ"];
    const used = await Promise.all(candidates.map((l) => driveExists(l)));
    const inUse = new Set(candidates.filter((_, i) => used[i]));
    const letter = pickLetter(preferred, (l) => inUse.has(l));
    if (!letter) {
      this.#mountFailed(null, { code: "not-supported", message: "No free drive letter for the other machine's drives." });
      return;
    }
    const label = this.#o.machine === "laptop" ? "Gaming PC" : "Laptop";
    const logFile = join(this.#o.dir, "files-mount.log");
    trimLog(logFile);
    let obscured: string;
    try {
      obscured = await obscure(this.#rclone!, password);
    } catch (e) {
      this.#mountFailed(null, { code: "engine-crashed", message: `rclone could not start: ${(e as Error).message}` });
      return;
    }
    this.#set((f) => {
      f.remote.status = "mounting";
      f.remote.letter = letter;
      delete f.remote.error;
    });
    const args = mountArgs({ letter, label, cacheDir: join(this.#o.dir, "files-cache"), logFile });
    const child = spawn(this.#rclone!, args, { windowsHide: true, stdio: "ignore", env: { ...process.env, ...mountEnv(obscured) } });
    this.#mount = child;
    this.#savePids();
    child.on("error", () => {});
    child.on("exit", (code) => {
      if (this.#mount !== child) return;
      this.#mount = null;
      this.#savePids();
      this.#mountFailed(letter, { code: "engine-crashed", message: `The ${label}'s drive stopped (rclone exit code ${code}). ${lastLogLine(logFile) ?? ""}`.trim() });
      this.#retry();
    });
    const up = await until(async () => this.#mount !== child || (await driveExists(letter, 5_000)), 20_000);
    if (this.#mount !== child) return;
    if (!up) {
      await this.#stopMount();
      this.#mountFailed(letter, { code: "engine-timeout", message: `The ${label}'s drive did not appear as ${letter}: within 20 s.`, hint: lastLogLine(logFile) ?? undefined });
      this.#retry();
      return;
    }
    this.#set((f) => {
      f.remote.status = "mounted";
    });
    this.#log("info", `The ${label}'s drives are on ${letter}: (open This PC in Explorer)`);
  }

  #mountFailed(letter: string | null, error: AgentError): void {
    this.#set((f) => {
      f.remote.status = "error";
      f.remote.letter = letter;
      f.remote.error = { ...error, hint: error.hint ?? (this.#files.missing.length ? SETUP_HINT : undefined) };
    });
    this.#log("warn", error.message);
  }

  async #stopMount(): Promise<void> {
    const child = this.#mount;
    this.#mount = null;
    if (child) await this.#kill(child);
    this.#savePids();
    if (this.#files.remote.status !== "off") {
      this.#set((f) => {
        f.remote.status = "off";
        f.remote.letter = null;
        delete f.remote.error;
      });
    }
  }

  /** Ending rclone removes its drive or closes its port (WinFsp cleans up after the process). */
  #kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(resolve, 5_000);
      child.once("exit", () => (clearTimeout(done), resolve()));
      child.kill();
    });
  }
}

export function initialFilesState(enabled: boolean): SharingState["files"] {
  return { enabled, missing: [], serving: null, remote: { offered: false, status: "off", letter: null } };
}

export { SETUP_HINT as FILES_SETUP_HINT };
