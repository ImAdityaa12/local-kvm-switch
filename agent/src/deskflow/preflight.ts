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

/** Name of the process that started each pid ("" when that process is gone). */
function parentNames(pids: number[]): Promise<string[]> {
  if (process.platform !== "win32" || pids.length === 0) return Promise.resolve([]);
  const ps =
    `foreach ($id in @(${pids.join(",")})) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; ` +
    `$q = if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }; if ($q) { $q.Name } else { '-' } }`;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 10_000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean).map((l) => (l === "-" ? "" : l)));
    });
  });
}

/** What to say about a deskflow-core.exe we did not start, from what started it. */
export function conflictDetail(parents: string[]): { message: string; hint: string } {
  if (parents.includes("deskflow.exe")) {
    return {
      message: "The Deskflow app is already running Deskflow.",
      hint: "Right-click the Deskflow tray icon → Quit. To stop it coming back after a restart: Task Manager → Startup apps → Deskflow → Disable. The agent starts Deskflow itself.",
    };
  }
  if (parents.includes("deskflow-daemon.exe") || parents.includes("services.exe")) {
    return {
      message: "The Deskflow service is already running Deskflow.",
      hint: "In services.msc, stop the Deskflow service and set its Startup type to Disabled (needs admin). The agent starts Deskflow itself.",
    };
  }
  if (parents.includes("node.exe")) {
    return {
      message: "Another LAN KVM agent is already running Deskflow.",
      hint: "Only one agent may run. Close the agent in your terminal (Ctrl+C), or run npm run autostart -- stop.",
    };
  }
  return {
    message: "Deskflow is already running, started by something else.",
    hint: "Quit the Deskflow app from its tray icon and stop the Deskflow service in services.msc. If neither is running, end deskflow-core.exe in Task Manager.",
  };
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
    throw new EngineError({ code: "engine-crashed", ...conflictDetail(await parentNames(others)) });
  }
}
