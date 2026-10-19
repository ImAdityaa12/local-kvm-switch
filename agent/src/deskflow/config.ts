// Files that drive deskflow-core. Every key used here was checked against the
// Deskflow v1.27.0 source (src/lib/common/Settings.h) and docs/Configuration.md.
// deskflow-core reads them via `deskflow-core <server|client> -s <file>`.

import type { Hotkeys } from "../../../lib/protocol/index.ts";

export const SERVER_SCREEN = "gaming-pc";
export const CLIENT_SCREEN = "laptop";
/** Deskflow server port, bound to loopback on the gaming PC. Not Deskflow's default, to avoid clashing with a user's own install. */
export const DESKFLOW_SERVER_PORT = 24810;
/** Loopback port on the laptop that tunnels to DESKFLOW_SERVER_PORT through the peer link. */
export const DESKFLOW_TUNNEL_PORT = 24811;

/** The laptop sits to the left of the gaming PC, so the hotkeys point the same way. */
export const HOTKEYS: Hotkeys = { toLaptop: "Ctrl+Alt+Left", toGamingPc: "Ctrl+Alt+Right" };

/**
 * A string value for a QSettings INI file. Always quoted, so commas are not
 * read as list separators; backslashes and quotes are escaped.
 */
export function iniString(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("INI values cannot contain line breaks");
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A command line for Deskflow's enter/exit hooks (split with QProcess::splitCommand). */
export function commandLine(args: string[]): string {
  return args
    .map((a) => {
      if (a.includes('"')) throw new Error("command arguments cannot contain quotes");
      return /\s/.test(a) ? `"${a}"` : a;
    })
    .join(" ");
}

export interface SettingsInput {
  mode: "server" | "client";
  port: number;
  /** Server: path of the layout file. */
  layoutFile?: string;
  enterCommand: string;
  exitCommand: string;
  /**
   * Started by the Deskflow service instead of the agent (see daemon.ts): the
   * service reads the mode and elevation from this file, and the core writes
   * its output to logFile because the agent cannot read its stdout.
   */
  service?: { logFile: string };
}

export function settingsIni(o: SettingsInput): string {
  const lines = [
    "[core]",
    `computerName=${o.mode === "server" ? SERVER_SCREEN : CLIENT_SCREEN}`,
    // Settings::CoreMode: 1 client, 2 server.
    ...(o.service ? [`coreMode=${o.mode === "server" ? 2 : 1}`] : []),
    `port=${o.port}`,
    // Server: listen on loopback only; the peer link is the only way in.
    ...(o.mode === "server" ? ["interface=127.0.0.1"] : []),
    "preventSleep=false",
    "enableEnterCommand=true",
    `enterCommand=${iniString(o.enterCommand)}`,
    "enableExitCommand=true",
    `exitCommand=${iniString(o.exitCommand)}`,
    "",
    "[security]",
    // Traffic never leaves loopback in the clear: the peer link (TLS-PSK) carries it between machines.
    "tlsEnabled=false",
    "",
    "[log]",
    // Debug includes connection and screen-switch lines; keystrokes are only logged at Verbose.
    "level=Debug",
    ...(o.service ? ["toFile=true", `file=${iniString(o.service.logFile)}`] : ["toFile=false"]),
    "",
    // Run as SYSTEM, so admin windows and permission prompts take input too.
    ...(o.service ? ["[daemon]", "elevate=true", ""] : []),
  ];
  if (o.mode === "server") {
    if (!o.layoutFile) throw new Error("server settings need a layout file");
    lines.push(
      "[server]",
      "externalConfig=true",
      `externalConfigFile=${iniString(o.layoutFile)}`,
      "enableClipboard=false",
      "disableLockToComputer=true",
      "",
      // Since 1.27 the server learns its computers from these groups
      // (Settings::knownComputers); a layout file's "screens" section is skipped.
      `[computer_${SERVER_SCREEN}]`,
      `name=${iniString(SERVER_SCREEN)}`,
      "",
      `[computer_${CLIENT_SCREEN}]`,
      `name=${iniString(CLIENT_SCREEN)}`,
      "",
    );
  } else {
    lines.push("[client]", `remoteHost=${iniString("127.0.0.1")}`, "languageSync=true", "");
  }
  return lines.join("\r\n");
}

/** Deskflow key syntax for our hotkeys: control+alt+Right. */
function keystroke(h: string): string {
  return h
    .split("+")
    .map((k) => ({ Ctrl: "control", Alt: "alt", Shift: "shift", Win: "super" })[k] ?? k)
    .join("+");
}

/** Links and hotkeys only: the computers themselves are declared in the server settings. */
export function serverLayout(hotkeys: Hotkeys = HOTKEYS): string {
  return [
    "section: links",
    // One way only: the gaming PC's left edge leads to the laptop, but no laptop
    // edge leads back, so reaching the side of the laptop screen never switches.
    // Coming back is the hotkey or Return to Gaming PC.
    `\t${SERVER_SCREEN}:`,
    `\t\tleft = ${CLIENT_SCREEN}`,
    "end",
    "",
    "section: options",
    `\tkeystroke(${keystroke(hotkeys.toLaptop)}) = switchToScreen(${CLIENT_SCREEN})`,
    `\tkeystroke(${keystroke(hotkeys.toGamingPc)}) = switchToScreen(${SERVER_SCREEN})`,
    "end",
    "",
  ].join("\r\n");
}

// ---- log lines (Deskflow v1.27.0 source) ----

/** src/lib/server/Server.cpp: LOG_DEBUG("client \"%s\" has connected") */
export const RE_CLIENT_CONNECTED = new RegExp(`client "${CLIENT_SCREEN}" has connected`);
/** src/lib/server/ClientProxy1_0.cpp: LOG_DEBUG("client \"%s\" has disconnected") */
export const RE_CLIENT_DISCONNECTED = new RegExp(`client "${CLIENT_SCREEN}" has disconnected`);
/** src/lib/server/Server.cpp: LOG_INFO("switch from \"%s\" to \"%s\" at %d,%d") */
export const RE_SWITCH = /switch from "([^"]+)" to "([^"]+)"/;
/** src/lib/deskflow/ClientApp.cpp: LOG_DEBUG("connected to server") / ("disconnected from server") */
export const RE_CONNECTED_TO_SERVER = /connected to server/;
export const RE_DISCONNECTED_FROM_SERVER = /disconnected from server/;
