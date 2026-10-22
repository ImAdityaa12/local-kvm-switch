// Runs the agent in the background whenever you sign in to Windows, with no
// terminal and no Next.js server, and adds a "LAN KVM" shortcut that opens the
// dashboard in a small app window only when you need it.
//
//   node scripts/autostart.mjs install --machine gaming-pc [--bind IP] [--port 47820]
//   node scripts/autostart.mjs install --machine laptop
//   node scripts/autostart.mjs stop        stop the background agent until the next sign-in
//   node scripts/autostart.mjs remove      stop it and undo install
//   node scripts/autostart.mjs disable-deskflow   gaming PC: turn off the Deskflow service (install does this too)
//   node scripts/autostart.mjs enable-deskflow    laptop: turn on the Deskflow service, so admin windows and
//                                                 permission prompts take input (install does this too)
//
// The agent restarts on its own if it stops (for example when the network is
// not up yet right after sign-in). Its console output goes to agent.log in
// %LOCALAPPDATA%\LanKvmSwitcher.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    machine: { type: "string" },
    bind: { type: "string" },
    port: { type: "string", default: "47820" },
    "no-start": { type: "boolean", default: false },
  },
});

if (process.platform !== "win32") fail("Autostart is for Windows only.");

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LanKvmSwitcher");
const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const startupFile = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "LAN KVM agent.vbs");
const startMenuLink = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "LAN KVM.lnk");
const desktopLink = join(desktopDir(), "LAN KVM.lnk");
const runner = join(dataDir, "run-agent.cmd");
const opener = join(dataDir, "open-dashboard.vbs");
const stopFlag = join(dataDir, "agent-stopped");
const logFile = join(dataDir, "agent.log");

/** The real Desktop folder (often moved into OneDrive). LAN_KVM_DESKTOP overrides it for tests. */
function desktopDir() {
  if (process.env.LAN_KVM_DESKTOP) return process.env.LAN_KVM_DESKTOP;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" });
  return r.stdout?.trim() || join(homedir(), "Desktop");
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/** Batch and VBScript files want CRLF line endings. */
function writeCrlf(file, lines) {
  writeFileSync(file, lines.join("\r\n") + "\r\n");
}

/** Values pasted into the generated files: never let one break out of its quotes. */
function plain(v, what) {
  if (/["%^&|<>\r\n]/.test(v)) fail(`${what} contains a character the startup files cannot hold: ${v}`);
  return v;
}

function browser() {
  const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of pf) {
    const chrome = join(base, "Google", "Chrome", "Application", "chrome.exe");
    if (existsSync(chrome)) return chrome;
  }
  for (const base of pf) {
    const edge = join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(edge)) return edge;
  }
  return null;
}

function shortcut(file, target, args, icon) {
  const ps = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK)",
    "$s.TargetPath = $env:TARGET",
    "$s.Arguments = $env:ARGS",
    "$s.IconLocation = $env:ICON",
    "$s.Description = 'Open the LAN KVM dashboard'",
    "$s.Save()",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, LNK: file, TARGET: target, ARGS: args, ICON: icon },
    stdio: "inherit",
  });
  if (r.status !== 0) console.warn(`Could not create the shortcut ${file}`);
}

/** Ends the background agent and the loop that restarts it; an agent started in a terminal is left alone. */
function stopAgent() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stopFlag, "");
  const ps =
    "$loops = Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*run-agent.cmd*' }; " +
    "foreach ($l in $loops) { " +
    "Get-CimInstance Win32_Process -Filter \"ParentProcessId=$($l.ProcessId)\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
    "Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "inherit" });
}

/** How the Deskflow service is set up and whether it runs; null when it is not installed. */
function deskflowService() {
  const config = spawnSync("sc.exe", ["qc", "Deskflow"], { encoding: "utf8" });
  if (config.status !== 0) return null;
  const state = spawnSync("sc.exe", ["query", "Deskflow"], { encoding: "utf8" });
  return {
    disabled: /START_TYPE\s*:\s*4\b/.test(config.stdout),
    automatic: /START_TYPE\s*:\s*2\b/.test(config.stdout),
    stopped: /STATE\s*:\s*1\b/.test(state.stdout),
    running: /STATE\s*:\s*4\b/.test(state.stdout),
  };
}

/** Runs PowerShell lines as admin; Windows asks for permission. */
function runElevated(lines) {
  const encoded = Buffer.from(lines.join("\n"), "utf16le").toString("base64");
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' } catch { exit 1 }`,
    ],
    { stdio: "inherit" },
  );
}

/** Ends the Deskflow app, which would otherwise start Deskflow with its own settings. */
const quitDeskflowApp = "Stop-Process -Name deskflow -Force -ErrorAction SilentlyContinue";

/**
 * Gaming PC: the Deskflow service starts its own Deskflow with Windows, which
 * blocks the agent. It runs as SYSTEM, so turning it off needs admin: Windows
 * asks once. Deskflows the agent started (their parent is node.exe) are left alone.
 */
function disableDeskflowService() {
  const before = deskflowService();
  if (!before || (before.disabled && before.stopped)) return true;
  console.log("The Deskflow service starts its own Deskflow with Windows, which blocks the agent.");
  console.log("Turning it off. Windows asks for permission once; click Yes…");
  runElevated([
    "Stop-Service Deskflow -Force -ErrorAction SilentlyContinue",
    "Set-Service Deskflow -StartupType Disabled",
    "foreach ($p in Get-CimInstance Win32_Process -Filter \"Name='deskflow-core.exe'\") {",
    "  $parent = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"",
    "  if (-not $parent -or $parent.Name -ne 'node.exe') { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
    "}",
    quitDeskflowApp,
  ]);
  const after = deskflowService();
  if (after && after.disabled && after.stopped) {
    console.log("The Deskflow service is off and will not start with Windows again.");
    return true;
  }
  console.warn("The Deskflow service is still on (was the permission prompt declined?). Run this again, or in services.msc");
  console.warn("stop Deskflow and set its Startup type to Disabled. Until then switching fails after each restart.");
  return false;
}

/**
 * Laptop: Deskflow started by the agent runs as you, and Windows keeps its
 * input out of windows that run as admin (Device Manager, Task Manager) and
 * out of permission prompts. The Deskflow service starts it as SYSTEM instead,
 * which reaches those too, so the laptop agent runs Deskflow through the
 * service. Turning the service on needs admin: Windows asks once. The service
 * starts nothing until the agent asks it to.
 */
function enableDeskflowService() {
  const before = deskflowService();
  if (!before) {
    console.warn("The Deskflow service is not installed. Reinstall Deskflow 1.27.0 (deskflow-1.27.0-win-x64.msi); until then");
    console.warn("the laptop's keyboard and mouse do not reach windows that run as admin or Windows permission prompts.");
    return false;
  }
  if (before.automatic && before.running) return true;
  console.log("Turning on the Deskflow service, so the keyboard and mouse also work in admin windows (Device Manager,");
  console.log("Task Manager) and Windows permission prompts on this laptop. Windows asks for permission once; click Yes…");
  runElevated([quitDeskflowApp, "Set-Service Deskflow -StartupType Automatic", "Start-Service Deskflow"]);
  const after = deskflowService();
  if (after && after.automatic && after.running) {
    console.log("The Deskflow service is on and starts with Windows. It runs Deskflow only when the agent asks.");
    return true;
  }
  console.warn("The Deskflow service is still off (was the permission prompt declined?). Run this again, or in services.msc");
  console.warn("set Deskflow's Startup type to Automatic and start it. Until then admin windows do not take input from the gaming PC.");
  return false;
}

function install() {
  const machine = values.machine;
  if (machine !== "gaming-pc" && machine !== "laptop") fail("Pass --machine gaming-pc or --machine laptop.");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port must be between 1024 and 65535");
  const args = ["--machine", machine, "--port", String(port), ...(values.bind ? ["--bind", values.bind] : [])];

  // The dashboard the agent serves: built once here instead of a Next.js server running all day.
  if (!existsSync(join(repo, "out", "index.html"))) {
    console.log("Building the dashboard (once)…");
    const r = spawnSync(process.execPath, [join(repo, "node_modules", "next", "dist", "bin", "next"), "build"], { cwd: repo, stdio: "inherit" });
    if (r.status !== 0) fail("The dashboard build failed. Run npm install, then try again.");
  }

  if (machine === "laptop") enableDeskflowService();
  else disableDeskflowService();

  mkdirSync(dataDir, { recursive: true });
  const node = plain(process.execPath, "The Node.js path");
  plain(repo, "The project folder");
  plain(dataDir, "The data folder");
  writeCrlf(runner, [
    "@echo off",
    "rem Written by scripts/autostart.mjs. Restarts the agent if it stops; delete agent-stopped to allow it again.",
    `cd /d "${repo}"`,
    `del "${stopFlag}" 2>nul`,
    ":loop",
    `if exist "${stopFlag}" goto :eof`,
    `if exist "${logFile}" for %%A in ("${logFile}") do if %%~zA GTR 2000000 del "${logFile}"`,
    `echo ---- started %date% %time% >> "${logFile}"`,
    `"${node}" agent\\src\\main.ts ${args.join(" ")} >> "${logFile}" 2>&1`,
    `if exist "${stopFlag}" goto :eof`,
    "rem Wait 10 s (timeout.exe refuses to run without a console to read from).",
    "ping -n 11 127.0.0.1 >nul",
    "goto loop",
  ]);
  writeCrlf(startupFile, [
    "' LAN KVM agent: started hidden at sign-in. Written by scripts/autostart.mjs.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${runner}""", 0, False`,
  ]);
  console.log(`The agent now starts hidden when you sign in (${startupFile}).`);

  const exe = browser();
  if (exe) {
    const agentUrl = encodeURIComponent(`ws://127.0.0.1:${port}/control`);
    writeCrlf(opener, [
      "' Opens the LAN KVM dashboard in its own small window. Written by scripts/autostart.mjs.",
      "' The token is read here each time, so it is never stored in the shortcut.",
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set sh = CreateObject("WScript.Shell")',
      `tokenFile = "${dataDir}\\control-token"`,
      "If Not fso.FileExists(tokenFile) Then",
      '  MsgBox "The LAN KVM agent has not started yet. Wait a few seconds and try again.", 48, "LAN KVM"',
      "  WScript.Quit",
      "End If",
      "token = Trim(fso.OpenTextFile(tokenFile).ReadAll)",
      `url = "http://127.0.0.1:${port}/#agent=${agentUrl}&token=" & token`,
      `sh.Run """${plain(exe, "The browser path")}"" --app=""" & url & """ --window-size=1100,900", 1, False`,
    ]);
    const icon = join(repo, "app", "favicon.ico");
    const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
    for (const link of [desktopLink, startMenuLink]) shortcut(link, wscript, `"${opener}"`, existsSync(icon) ? icon : exe);
    console.log('Open the dashboard with the "LAN KVM" shortcut on the desktop or in the Start menu. Close the window when you are done; the agent keeps running.');
  } else {
    console.log(`No Chrome or Edge found. Open http://127.0.0.1:${port} with the link from ${logFile}.`);
  }

  if (values["no-start"]) return;
  const busy = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { exit 1 }`]);
  if (busy.status === 1) {
    console.log("An agent is already running (probably in a terminal). Close it; the background one starts at your next sign-in,");
    console.log("or run this install again after closing it to start it now.");
    return;
  }
  spawn("wscript.exe", [startupFile], { detached: true, stdio: "ignore" }).unref();
  console.log("Started it now in the background.");
}

const command = positionals[0];
if (command === "install") install();
else if (command === "stop") {
  stopAgent();
  console.log("Stopped. It starts again at your next sign-in (or run: wscript \"" + startupFile + "\").");
} else if (command === "remove") {
  stopAgent();
  for (const f of [startupFile, desktopLink, startMenuLink, runner, opener]) rmSync(f, { force: true });
  console.log("Removed: the agent no longer starts at sign-in, and the shortcuts are gone.");
} else if (command === "disable-deskflow") {
  if (!deskflowService()) console.log("The Deskflow service is not installed on this machine; nothing to do.");
  else if (!disableDeskflowService()) process.exit(1);
  else console.log("Nothing else to do: the agent starts Deskflow itself.");
} else if (command === "enable-deskflow") {
  if (!enableDeskflowService()) process.exit(1);
  console.log("The agent uses it from the next switch to the laptop; nothing needs restarting.");
} else {
  fail("Usage: node scripts/autostart.mjs install --machine gaming-pc|laptop [--bind IP] | stop | remove | disable-deskflow | enable-deskflow");
}
