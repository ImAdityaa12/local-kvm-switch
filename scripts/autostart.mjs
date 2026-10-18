// Runs the agent in the background whenever you sign in to Windows, with no
// terminal and no Next.js server, and adds a "LAN KVM" shortcut that opens the
// dashboard in a small app window only when you need it.
//
//   node scripts/autostart.mjs install --machine gaming-pc [--bind IP] [--port 47820]
//   node scripts/autostart.mjs install --machine laptop
//   node scripts/autostart.mjs stop        stop the background agent until the next sign-in
//   node scripts/autostart.mjs remove      stop it and undo install
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
} else {
  fail("Usage: node scripts/autostart.mjs install --machine gaming-pc|laptop [--bind IP] | stop | remove");
}
