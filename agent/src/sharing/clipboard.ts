// The shared clipboard. native/kvm-audio/src/bin/kvm-clip.rs watches and sets this machine's
// clipboard; this sends each copy to the other machine and puts the other machine's copies here.
//
// A copy crosses as one stream over the peer link: one JSON object, gzipped. Text, HTML, RTF and
// images cross whole. Copied files cross as paths only: the other machine pastes them from this
// machine's drive (files.ts), so a file is read over the network only when it is pasted. Copies a
// password manager marks as private never leave the machine, and nothing copied is ever logged.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

export const CLIPBOARD_TARGET = "clipboard";
/** The most one copy may take on the wire, compressed. */
export const MAX_CLIP_WIRE = 64 * 1024 * 1024;
/** ...and unpacked (base64 of the helper's 48 MB items). */
const MAX_CLIP_JSON = 200 * 1024 * 1024;
const MAX_FILES = 10_000;
const RECEIVE_TIMEOUT_MS = 60_000;
const RESTART_MS = 5_000;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function clipHelperPath(repoRoot: string): string {
  return join(repoRoot, "native", "kvm-audio", "target", "release", "kvm-clip.exe");
}

/** A copied file as the other machine should name it: on the sender's drives, or on the receiver's own. */
export interface WireFile {
  owner: "sender" | "receiver";
  path: string;
}

/** One copy. html, rtf, png and dib are base64 of the clipboard's bytes. */
export interface WireClip {
  v: 1;
  text?: string;
  html?: string;
  rtf?: string;
  png?: string;
  dib?: string;
  files?: WireFile[];
}

/** How each machine names the other machine's files (files.ts). */
export interface PathMap {
  /** A file copied here, as the other machine should name it; null when it cannot reach it. */
  outgoing(path: string): WireFile | null;
  /** A file copied on the other machine, as a path here; null when it cannot be reached from here. */
  incoming(file: WireFile): string | null;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BLOBS = ["html", "rtf", "png", "dib"] as const;

/** Keeps only known fields with the right shapes; null when nothing usable is left. */
export function parseWireClip(v: unknown): WireClip | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || o.v !== 1) return null;
  const clip: WireClip = { v: 1 };
  if (typeof o.text === "string") clip.text = o.text;
  for (const k of BLOBS) {
    const b = o[k];
    if (typeof b === "string" && b.length % 4 === 0 && BASE64.test(b)) clip[k] = b;
  }
  if (Array.isArray(o.files)) {
    const files = o.files
      .slice(0, MAX_FILES)
      .filter((f): f is WireFile => !!f && (f.owner === "sender" || f.owner === "receiver") && typeof f.path === "string" && f.path.length > 0 && f.path.length < 32_768 && !f.path.includes("\0"));
    if (files.length) clip.files = files.map((f) => ({ owner: f.owner, path: f.path }));
  }
  return Object.keys(clip).length > 1 ? clip : null;
}

/** What a copy holds, for the dashboard: never its content. */
export function describe(c: { text?: string; png?: string; dib?: string; files?: unknown[] }): string {
  if (c.files?.length) return c.files.length === 1 ? "1 file" : `${c.files.length} files`;
  if (c.png || c.dib) return "an image";
  if (c.text !== undefined) return "text";
  return "formatted text";
}

export interface ClipboardShareOptions {
  exe: string;
  /** Arguments for the helper; tests run a stand-in with node. */
  args?: string[];
  enabled: () => boolean;
  online: () => boolean;
  open: (target: string) => Promise<Duplex>;
  paths: PathMap;
  onSync: (direction: "sent" | "received", what: string) => void;
  log: (level: "info" | "warn", message: string) => void;
  /** The helper is running (true) or stopped (false). */
  onAvailable: (available: boolean) => void;
}

type HelperMessage =
  | { event: "ready" }
  | { event: "copied"; content: Record<string, unknown> }
  | { event: "skipped"; reason: string }
  | { event: "set"; ok: boolean; error?: string }
  | { event: "error"; message: string };

export class ClipboardShare {
  #o: ClipboardShareOptions;
  #child: ChildProcess | null = null;
  #stopped = false;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Copies waiting to be sent: only the newest matters. */
  #next: WireClip | null = null;
  #sending = false;
  /** Warnings that would repeat on every copy are said once until things change. */
  #said = new Set<string>();

  constructor(o: ClipboardShareOptions) {
    this.#o = o;
  }

  get built(): boolean {
    return existsSync(this.#o.exe);
  }

  start(): boolean {
    this.#stopped = false;
    if (!this.built) return false;
    const child = spawn(this.#o.exe, this.#o.args ?? [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.#child = child;
    let rest = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        let m: HelperMessage;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.#onHelper(m);
      }
    });
    child.stdin?.on("error", () => {});
    child.on("error", () => {});
    child.on("exit", (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#o.onAvailable(false);
      if (this.#stopped) return;
      this.#o.log("warn", `The clipboard helper stopped (exit code ${code}); starting it again`);
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        if (!this.#stopped) this.start();
      }, RESTART_MS);
    });
    return true;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#child?.stdin?.end();
    this.#child = null;
  }

  #once(key: string, level: "info" | "warn", message: string): void {
    if (this.#said.has(key)) return;
    this.#said.add(key);
    this.#o.log(level, message);
  }

  #onHelper(m: HelperMessage): void {
    if (m.event === "ready") {
      this.#o.onAvailable(true);
      return;
    }
    if (m.event === "error") {
      this.#once(`helper:${m.message}`, "warn", `Clipboard: ${m.message}`);
      return;
    }
    if (m.event === "set") {
      if (!m.ok) this.#once(`set:${m.error}`, "warn", `Could not put the other machine's copy on this clipboard: ${m.error ?? "unknown error"}`);
      return;
    }
    if (m.event === "copied") this.#copied(m.content);
  }

  /** Something was copied here. */
  #copied(content: Record<string, unknown>): void {
    if (!this.#o.enabled() || !this.#o.online()) return;
    const clip = parseWireClip({ ...content, v: 1, files: undefined });
    const local = Array.isArray(content.files) ? content.files.filter((p): p is string => typeof p === "string") : [];
    const files = local.map((p) => this.#o.paths.outgoing(p)).filter((f): f is WireFile => f !== null);
    if (local.length && files.length < local.length) {
      this.#once("files-unreachable", "info", "Copied files can be pasted on the other machine only from drives this PC offers to it (turn on Share this PC's drives)");
    }
    if (Array.isArray(content.tooLarge) && content.tooLarge.length) {
      this.#once("too-large", "info", "A copy was too large to send whole (over 48 MB); the rest of it was sent");
    }
    const wire: WireClip = { ...(clip ?? { v: 1 }), ...(files.length ? { files } : {}) };
    if (Object.keys(wire).length === 1) return;
    this.#next = wire;
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#next) {
        const clip = this.#next;
        this.#next = null;
        await this.#send(clip);
      }
    } finally {
      this.#sending = false;
    }
  }

  async #send(clip: WireClip): Promise<void> {
    const body = await gzipAsync(JSON.stringify(clip), { level: 1 });
    if (body.length > MAX_CLIP_WIRE) {
      this.#once("wire-too-large", "info", "A copy was too large to send to the other machine");
      return;
    }
    try {
      const sock = await this.#o.open(CLIPBOARD_TARGET);
      await new Promise<void>((resolve, reject) => {
        sock.once("error", reject);
        sock.end(body, () => resolve());
      });
      // The other machine closes the stream once it has read it all.
      sock.resume();
      setTimeout(() => sock.destroy(), RECEIVE_TIMEOUT_MS).unref();
      this.#said.delete("send-failed");
      this.#o.onSync("sent", describe(clip));
    } catch {
      this.#once("send-failed", "warn", "Could not send a copy to the other machine");
    }
  }

  /** The other machine's copy arrives on its own stream (the peer link's "clipboard" target). */
  readonly receive = (sock: Duplex): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => sock.destroy(), RECEIVE_TIMEOUT_MS);
    sock.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_CLIP_WIRE) {
        clearTimeout(timer);
        sock.destroy();
        return;
      }
      chunks.push(c);
    });
    sock.on("error", () => clearTimeout(timer));
    sock.on("end", () => {
      clearTimeout(timer);
      sock.end();
      void this.#take(Buffer.concat(chunks));
    });
  };

  async #take(body: Buffer): Promise<void> {
    if (!this.#o.enabled() || !this.#child?.stdin?.writable) return;
    let clip: WireClip | null;
    try {
      clip = parseWireClip(JSON.parse((await gunzipAsync(body, { maxOutputLength: MAX_CLIP_JSON })).toString("utf8")));
    } catch {
      clip = null;
    }
    if (!clip) return;
    const files = (clip.files ?? []).map((f) => this.#o.paths.incoming(f)).filter((p): p is string => p !== null);
    if (clip.files?.length && files.length < clip.files.length) {
      this.#once("files-unreachable-here", "info", "Files copied on the other machine can be pasted here once its drive is connected (it must offer its drives)");
    }
    const set: Omit<WireClip, "v" | "files"> & { files?: string[] } = {};
    for (const k of ["text", ...BLOBS] as const) if (clip[k] !== undefined) set[k] = clip[k];
    if (files.length) set.files = files;
    if (Object.keys(set).length === 0) return;
    this.#child.stdin.write(JSON.stringify({ set }) + "\n");
    this.#o.onSync("received", describe(set));
  }
}
