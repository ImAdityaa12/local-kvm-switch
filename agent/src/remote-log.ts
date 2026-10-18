// Copies what the agent logs to a Postgres database (Neon), so problems on
// either machine can be looked at from one place. Off unless a database URL
// is configured; entries are batched and kept in memory while the database
// cannot be reached. The control token and pairing secrets are never logged.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

export type LogSource = "agent" | "deskflow" | "audio" | "crash";
export type LogLevel = "debug" | "info" | "warn" | "error";

interface Entry {
  at: string;
  source: LogSource;
  level: LogLevel;
  message: string;
}

const FLUSH_MS = 5_000;
const BATCH = 200;
const MAX_QUEUED = 5_000;
const MAX_MESSAGE = 8_000;

const SCHEMA = `
create table if not exists agent_logs (
  id bigserial primary key,
  at timestamptz not null,
  run_id uuid not null,
  machine text not null,
  host text not null,
  version text not null,
  source text not null,
  level text not null,
  message text not null
);
create index if not exists agent_logs_at on agent_logs (at desc);
create index if not exists agent_logs_level_at on agent_logs (level, at desc);
`;

/** The database URL: KVM_LOG_DATABASE_URL or DATABASE_URL (also read from the project's .env), else the one saved in the data folder. */
export function logDatabaseUrl(dir: string): string | null {
  const env = (process.env.KVM_LOG_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
  if (env) return env;
  try {
    return readFileSync(join(dir, "log-database-url"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function saveLogDatabaseUrl(dir: string, url: string): void {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("The log database URL must start with postgres:// or postgresql://");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "log-database-url"), url.trim(), { mode: 0o600 });
}

class RemoteLog {
  #sql: ReturnType<typeof neon> | null = null;
  #meta = { runId: randomUUID(), machine: "", host: "", version: "" };
  #queue: Entry[] = [];
  #dropped = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #flushing: Promise<void> | null = null;
  #ready = false;
  #failing = false;

  get enabled(): boolean {
    return this.#sql !== null;
  }

  start(url: string, meta: { machine: string; host: string; version: string }): void {
    this.#sql = neon(url);
    this.#meta = { ...this.#meta, ...meta };
    this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.#timer.unref();
  }

  write(source: LogSource, level: LogLevel, message: string): void {
    if (!this.#sql) return;
    this.#queue.push({ at: new Date().toISOString(), source, level, message: message.slice(0, MAX_MESSAGE) });
    if (this.#queue.length > MAX_QUEUED) {
      this.#dropped += this.#queue.length - MAX_QUEUED;
      this.#queue.splice(0, this.#queue.length - MAX_QUEUED);
    }
    if (this.#queue.length >= BATCH) void this.flush();
  }

  /** Sends what is queued. Never throws; a failed batch stays queued for the next try. */
  flush(): Promise<void> {
    this.#flushing ??= this.#send().finally(() => (this.#flushing = null));
    return this.#flushing;
  }

  async #send(): Promise<void> {
    const sql = this.#sql;
    if (!sql) return;
    try {
      if (!this.#ready) {
        for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await sql.query(stmt);
        this.#ready = true;
      }
      while (this.#queue.length > 0) {
        if (this.#dropped > 0) {
          this.#queue.unshift({ at: new Date().toISOString(), source: "agent", level: "warn", message: `${this.#dropped} log entries were dropped while the log database was unreachable` });
          this.#dropped = 0;
        }
        const batch = this.#queue.slice(0, BATCH);
        await sql.query(
          `insert into agent_logs (at, run_id, machine, host, version, source, level, message)
           select x.at, $2::uuid, $3, $4, $5, x.source, x.level, x.message
           from json_to_recordset($1::json) as x(at timestamptz, source text, level text, message text)`,
          [JSON.stringify(batch), this.#meta.runId, this.#meta.machine, this.#meta.host, this.#meta.version],
        );
        this.#queue.splice(0, batch.length);
      }
      if (this.#failing) console.error("Log database reachable again.");
      this.#failing = false;
    } catch (e) {
      // Said once per outage, and only here: logging it would feed the queue it failed to send.
      if (!this.#failing) console.error(`Could not send logs to the log database (will keep trying): ${(e as Error).message}`);
      this.#failing = true;
    }
  }

  /** Last flush on the way out, bounded so a dead network cannot hold up shutdown. */
  async stop(timeoutMs = 3_000): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A second flush picks up what was queued while an earlier one was in flight.
    const drain = this.flush().then(() => this.flush());
    await Promise.race([drain, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }
}

export const remoteLog = new RemoteLog();
