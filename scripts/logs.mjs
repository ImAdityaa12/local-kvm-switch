// Reads the agent logs from the log database, oldest first.
//
//   node scripts/logs.mjs [--since 2h] [--level warn] [--machine laptop]
//                         [--source deskflow] [--grep text] [--limit 300] [--runs]
//
// --level keeps that level and above (debug < info < warn < error).
// --runs lists agent runs instead of entries. The database URL comes from
// KVM_LOG_DATABASE_URL or DATABASE_URL (also read from the project's .env),
// else the one the agent saved with --log-db.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { neon } from "@neondatabase/serverless";

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "24h" },
    level: { type: "string", default: "debug" },
    machine: { type: "string" },
    source: { type: "string" },
    grep: { type: "string" },
    limit: { type: "string", default: "300" },
    runs: { type: "boolean", default: false },
  },
});

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env; that is fine
}

function databaseUrl() {
  const env = process.env.KVM_LOG_DATABASE_URL ?? process.env.DATABASE_URL;
  if (env) return env.trim();
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  try {
    return readFileSync(join(base, "LanKvmSwitcher", "log-database-url"), "utf8").trim();
  } catch {
    console.error("No log database set. Put DATABASE_URL in the project's .env or run the agent once with --log-db.");
    process.exit(2);
  }
}

const m = /^(\d+)([mhd])$/.exec(values.since);
if (!m) {
  console.error("--since looks like 30m, 2h or 7d");
  process.exit(2);
}
const since = new Date(Date.now() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]).toISOString();
const LEVELS = ["debug", "info", "warn", "error"];
if (!LEVELS.includes(values.level)) {
  console.error(`--level is one of ${LEVELS.join(", ")}`);
  process.exit(2);
}

const sql = neon(databaseUrl());

if (values.runs) {
  const rows = await sql.query(
    `select run_id, machine, host, version, min(at) as started, max(at) as last,
            count(*) filter (where level = 'error') as errors, count(*) filter (where level = 'warn') as warnings
     from agent_logs where at >= $1 group by run_id, machine, host, version order by started`,
    [since],
  );
  for (const r of rows) {
    console.log(`${new Date(r.started).toISOString()} → ${new Date(r.last).toISOString()}  ${r.machine} (${r.host}, ${r.version})  ${r.errors} errors, ${r.warnings} warnings  run ${r.run_id}`);
  }
  process.exit(0);
}

const rows = await sql.query(
  `select * from (
     select at, machine, source, level, message from agent_logs
     where at >= $1 and level = any($2)
       and ($3::text is null or machine = $3)
       and ($4::text is null or source = $4)
       and ($5::text is null or message ilike '%' || $5 || '%')
     order by at desc limit $6
   ) t order by at`,
  [since, LEVELS.slice(LEVELS.indexOf(values.level)), values.machine ?? null, values.source ?? null, values.grep ?? null, Number(values.limit)],
);
for (const r of rows) {
  console.log(`${new Date(r.at).toISOString()} ${r.machine.padEnd(9)} ${r.source.padEnd(8)} ${r.level.toUpperCase().padEnd(5)} ${r.message}`);
}
if (rows.length === 0) console.log("No log entries match.");
