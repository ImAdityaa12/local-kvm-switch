import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-user data folder. Never inside the repository. */
export function dataDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "LanKvmSwitcher");
}

/** Loads the dashboard control token, creating one on first run. */
export function loadOrCreateToken(dir = dataDir()): string {
  const file = join(dir, "control-token");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(t)) return t;
  } catch {
    // first run
  }
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}
