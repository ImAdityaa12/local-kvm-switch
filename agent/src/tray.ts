// The notification-area icon (native/kvm-audio/src/bin/kvm-tray.rs). The agent
// owns it: it sends the state as JSON lines and gets back what was clicked.
// The tray exits on its own when the agent goes away (its stdin closes).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentState } from "../../lib/protocol/index.ts";

export function trayPath(repoRoot: string): string {
  return join(repoRoot, "native", "kvm-audio", "target", "release", "kvm-tray.exe");
}

export type TrayAction = "switch" | "return" | "dashboard";

export interface TrayView {
  icon: "local" | "remote" | "busy" | "problem";
  status: string;
  switchLabel: string;
  canSwitch: boolean;
  canReturn: boolean;
}

/** What the icon shows. Grey: gaming PC has input; green: laptop; amber: switching; red: the other machine is unreachable. */
export function trayView(s: AgentState): TrayView {
  const onGamingPc = s.agent.machine === "gaming-pc";
  const peerOnline = s.peer.link === "online";
  const remote = s.input.target === "laptop";
  const canReturn = remote || s.input.hooksActive || s.input.pending !== null;
  // Either machine can start the switch; the gaming PC presses the hotkey itself.
  const switchLabel = onGamingPc ? "Switch to laptop" : "Take keyboard and mouse";
  const base = { switchLabel, canReturn, canSwitch: peerOnline && !remote && s.input.pending === null };
  if (s.input.pending?.target === "laptop") {
    // Only when pressing it for the user did not work.
    const hotkey = s.input.pending.step === "press-hotkey" && s.input.hotkeys ? `: press ${s.input.hotkeys.toLaptop}` : "";
    return { ...base, icon: "busy", status: `Switching to the laptop${hotkey}` };
  }
  if (s.input.pending) return { ...base, icon: "busy", status: "Returning to the Gaming PC" };
  if (remote) return { ...base, icon: "remote", status: onGamingPc ? "Laptop has the keyboard and mouse" : "This laptop has the keyboard and mouse" };
  if (!peerOnline) {
    const other = onGamingPc ? "Laptop" : "Gaming PC";
    return { ...base, icon: "problem", status: s.peer.link === "unpaired" ? "No laptop paired yet" : `${other} is not reachable` };
  }
  return { ...base, icon: "local", status: "Gaming PC has the keyboard and mouse" };
}

export class Tray {
  #child: ChildProcess;
  #last = "";

  private constructor(child: ChildProcess) {
    this.#child = child;
  }

  /** Null when the tray is not built (npm run build:audio builds it with the audio helper). */
  static start(exe: string, onAction: (a: TrayAction) => void, onProblem: (message: string) => void): Tray | null {
    if (!existsSync(exe)) return null;
    const child = spawn(exe, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const tray = new Tray(child);
    let rest = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        let m: { action?: string; event?: string; ok?: boolean };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.action === "switch" || m.action === "return" || m.action === "dashboard") onAction(m.action);
        else if (m.event === "icon" && m.ok === false) onProblem("Windows did not accept the tray icon");
      }
    });
    child.on("error", (e) => onProblem(`The tray icon could not start: ${e.message}`));
    child.stdin?.on("error", () => {});
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) onProblem(`The tray icon stopped (exit code ${code})`);
    });
    return tray;
  }

  show(view: TrayView): void {
    const line = JSON.stringify(view);
    if (line === this.#last || !this.#child.stdin?.writable) return;
    this.#last = line;
    this.#child.stdin.write(line + "\n");
  }

  stop(): void {
    this.#child.stdin?.end();
  }
}

/** Chrome, else Edge (always present on Windows 11). */
export function findBrowser(): string | null {
  const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((b): b is string => !!b);
  for (const app of [join("Google", "Chrome", "Application", "chrome.exe"), join("Microsoft", "Edge", "Application", "msedge.exe")]) {
    for (const base of bases) {
      const exe = join(base, app);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/** Opens the dashboard as a small app window; the link carries the token in its fragment, which never reaches a server. */
export function openDashboard(link: string): boolean {
  const browser = findBrowser();
  if (!browser) return false;
  spawn(browser, [`--app=${link}`, "--window-size=1100,900"], { detached: true, stdio: "ignore" }).unref();
  return true;
}
