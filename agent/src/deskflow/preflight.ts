// Checks before starting deskflow-core, so failures say what to do.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { EngineError } from "../engines.ts";
import { remoteLog } from "../remote-log.ts";

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

/** Ends the Deskflow app and the deskflow-core it started. It runs as you, so this needs no admin. */
function closeDeskflowApp(): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/IM", "deskflow.exe", "/T", "/F"], { windowsHide: true }, () => resolve());
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
      hint: "Run npm.cmd run autostart -- disable-deskflow once in the project folder (Windows asks for admin), or in services.msc stop the Deskflow service and set its Startup type to Disabled. The agent starts Deskflow itself.",
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
    hint: "Run npm.cmd run autostart -- disable-deskflow once in the project folder (Windows asks for admin). If that does not help, end deskflow-core.exe in Task Manager.",
  };
}

/**
 * Deskflow must be installed where we look, and nothing else may be running it:
 * the Deskflow app and its service start their own deskflow-core, which takes
 * the single-instance slot and has its own settings. The app is closed here;
 * the service runs as SYSTEM, so only autostart's disable-deskflow (admin) can
 * turn it off. When the agent runs Deskflow through the service (the laptop,
 * daemon.ts), viaService is set: the service's core is then replaced on start.
 */
export async function preflight(
  exe: string,
  ours: number[] = [],
  note: (message: string) => void = (m) => remoteLog.write("deskflow", "info", m),
  viaService = false,
): Promise<void> {
  if (!existsSync(exe)) {
    throw new EngineError({
      code: "engine-missing",
      message: `Deskflow was not found at ${exe}.`,
      hint: "Install Deskflow 1.27.0 (deskflow-1.27.0-win-x64.msi), or start the agent with --deskflow and the full path to deskflow-core.exe.",
    });
  }
  /** What started each core in the way. */
  const blocking = async () => {
    const held = (await runningCores()).filter((p) => !ours.includes(p));
    const parents = await parentNames(held);
    // Not knowing what started one still counts it as in the way.
    if (parents.length < held.length) return held.map(() => "");
    return viaService ? parents.filter((p) => p !== "deskflow-daemon.exe") : parents;
  };
  let parents = await blocking();
  if (parents.length === 0) return;
  if (parents.includes("deskflow.exe")) {
    await closeDeskflowApp();
    await delay(500);
    parents = await blocking();
    if (parents.length === 0) {
      note("Closed the Deskflow app, which was holding Deskflow. The agent starts Deskflow itself.");
      return;
    }
  }
  throw new EngineError({ code: "engine-crashed", ...conflictDetail(parents) });
}
