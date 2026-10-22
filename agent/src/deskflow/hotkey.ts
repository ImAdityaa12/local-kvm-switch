// Presses a Deskflow hotkey on the gaming PC, so a click (here, in the tray,
// or on the laptop) moves the cursor without anyone reaching for the keyboard.
//
// Deskflow has no documented way to switch screens, but its switchToScreen
// keystrokes are ordinary Windows hotkeys (RegisterHotKey,
// src/lib/platform/MSWindowsComputer.cpp), and Windows fires those for
// simulated key presses too. Checked against deskflow-core 1.27.0: a simulated
// Ctrl+Alt+Left logs "hotkey: switchToScreen(laptop)".
//
// Only ever runs while the Deskflow server is up and the user asked to switch;
// in Gaming PC mode nothing is pressed (spec §2.3). Windows ignores simulated
// keys while a window that runs as admin has focus; the switch then falls back
// to asking the user to press the hotkey.

import { execFile } from "node:child_process";

/** Virtual-key and scan codes; arrows are extended keys. */
const KEYS: Record<string, { vk: number; scan: number; extended?: boolean }> = {
  Ctrl: { vk: 0x11, scan: 0x1d },
  Alt: { vk: 0x12, scan: 0x38 },
  Shift: { vk: 0x10, scan: 0x2a },
  Left: { vk: 0x25, scan: 0x4b, extended: true },
  Right: { vk: 0x27, scan: 0x4d, extended: true },
  Up: { vk: 0x26, scan: 0x48, extended: true },
  Down: { vk: 0x28, scan: 0x50, extended: true },
};

const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;

/** PowerShell that presses the keys of a hotkey such as "Ctrl+Alt+Left" in order and releases them in reverse. */
export function pressScript(hotkey: string): string {
  const keys = hotkey.split("+").map((k) => {
    const key = KEYS[k];
    if (!key) throw new Error(`Cannot press the key "${k}"`);
    return key;
  });
  const event = (k: (typeof keys)[number], up: boolean) =>
    `[LanKvm.Keys]::keybd_event(${k.vk}, ${k.scan}, ${(k.extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0)}, [UIntPtr]::Zero)`;
  return [
    `Add-Type -Namespace LanKvm -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'`,
    ...keys.map((k) => event(k, false)),
    ...[...keys].reverse().map((k) => event(k, true)),
  ].join("\n");
}

/** Presses the hotkey on this machine. Resolves once the keys were sent, which does not mean Deskflow acted on them. */
export function pressHotkey(hotkey: string): Promise<void> {
  const encoded = Buffer.from(pressScript(hotkey), "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 15_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
