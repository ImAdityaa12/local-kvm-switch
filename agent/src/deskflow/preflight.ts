// Checks before starting deskflow-core, so failures say what to do.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { EngineError } from "../engines.ts";

/** Process ids of every running deskflow-core.exe. */
export function runningCores(): Promise<number[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq deskflow-core.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
      if (err) return resolve([]);
      const pids = out
        .split(/\r?\n/)
        .map((l) => /^"deskflow-core\.exe","(\d+)"/i.exec(l)?.[1])
        .filter((p): p is string => !!p)
        .map(Number);
      resolve(pids);
    });
  });
}

/**
 * Deskflow must be installed where we look, and nothing else may be running it:
 * the Deskflow app and its service start their own deskflow-core, which takes
 * the single-instance slot and has its own settings.
 */
export async function preflight(exe: string, ours: number[] = []): Promise<void> {
  if (!existsSync(exe)) {
    throw new EngineError({
      code: "engine-missing",
      message: `Deskflow was not found at ${exe}.`,
      hint: "Install Deskflow 1.27.0 (deskflow-1.27.0-win-x64.msi), or start the agent with --deskflow and the full path to deskflow-core.exe.",
    });
  }
  const others = (await runningCores()).filter((p) => !ours.includes(p));
  if (others.length > 0) {
    throw new EngineError({
      code: "engine-crashed",
      message: "The Deskflow app or its service is already running Deskflow.",
      hint: "Quit Deskflow from its tray icon, and in services.msc stop the Deskflow service and set it to Disabled. The agent starts Deskflow itself.",
    });
  }
}
