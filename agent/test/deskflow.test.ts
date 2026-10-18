import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandLine, iniString, serverLayout, settingsIni } from "../src/deskflow/config.ts";
import { DeskflowServerInput, crashed, lastError, type DeskflowPaths } from "../src/deskflow/engines.ts";
import type { InputReport } from "../src/engines.ts";

/** Reference reader for a quoted QSettings INI string (the subset we emit). */
function readIniString(v: string): string {
  assert.ok(v.startsWith('"') && v.endsWith('"'));
  return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** Reference QProcess::splitCommand for the subset we emit (quoted args, no embedded quotes). */
function splitCommand(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

test("INI strings and commands survive Deskflow's parsing", () => {
  const args = ["C:/Program Files/nodejs/node.exe", "C:/Users/A B/agent/notify.mjs", "47820", "leave", "C:/x,y/token"];
  const cmd = commandLine(args);
  const ini = iniString(cmd);
  assert.deepEqual(splitCommand(readIniString(ini)), args);
  assert.throws(() => iniString("a\nb"));
  assert.throws(() => commandLine(['say "hi"']));
});

test("server settings keep Deskflow on loopback, TLS off (tunnelled), enter/exit hooks on", () => {
  const s = settingsIni({ mode: "server", port: 24810, layoutFile: "C:/d/layout.conf", enterCommand: "a enter", exitCommand: "a leave" });
  assert.match(s, /\[core\][\s\S]*interface=127\.0\.0\.1/);
  assert.match(s, /computerName=gaming-pc/);
  assert.match(s, /tlsEnabled=false/);
  assert.match(s, /enableExitCommand=true/);
  assert.match(s, /externalConfigFile="C:\/d\/layout\.conf"/);
  assert.match(s, /level=Debug/);
  // Deskflow 1.27 only knows computers declared here; without them the layout fails to load.
  assert.match(s, /\[computer_gaming-pc\]\r\nname="gaming-pc"/);
  assert.match(s, /\[computer_laptop\]\r\nname="laptop"/);
  const c = settingsIni({ mode: "client", port: 24811, enterCommand: "a", exitCommand: "b" });
  assert.match(c, /remoteHost="127\.0\.0\.1"/);
  assert.doesNotMatch(c, /interface=/);
});

test("layout binds the switch hotkeys", () => {
  const l = serverLayout();
  assert.match(l, /keystroke\(control\+alt\+Right\) = switchToScreen\(laptop\)/);
  assert.match(l, /keystroke\(control\+alt\+Left\) = switchToScreen\(gaming-pc\)/);
  assert.doesNotMatch(l, /section: screens/);
});

function paths(): DeskflowPaths {
  return {
    exe: process.execPath,
    exePrefixArgs: [fileURLToPath(new URL("./fixtures/fake-deskflow.mjs", import.meta.url))],
    dir: mkdtempSync(join(tmpdir(), "kvm-df-")),
    notifyCommand: (e) => ["node", "notify.mjs", "47820", e, "token"],
  };
}

function engine(behaviour: string) {
  process.env.FAKE_DESKFLOW = behaviour;
  const p = paths();
  const requests: string[] = [];
  const e = new DeskflowServerInput(p, { request: async (r) => void requests.push(r.op) });
  const reports: InputReport[] = [];
  e.onReport((r) => reports.push({ ...r }));
  return { e, p, requests, reports };
}

test("server engine: hooks are reported from process start until it has exited", async () => {
  const { e, p, requests, reports } = engine("switch");
  await e.activateRemote();
  assert.deepEqual(requests, ["input.prepare"]);
  const last = reports.at(-1)!;
  assert.equal(last.target, "laptop");
  assert.equal(last.hooksActive, true);
  assert.equal(last.clientConnected, true);
  assert.ok(reports.some((r) => r.step === "press-hotkey"));
  assert.match(readFileSync(join(p.dir, "deskflow-server.conf"), "utf8"), /interface=127\.0\.0\.1/);

  await e.deactivate();
  const end = reports.at(-1)!;
  assert.equal(end.target, "gaming-pc");
  assert.equal(end.hooksActive, false);
  assert.equal(end.engine, "stopped");
  assert.deepEqual(requests, ["input.prepare", "input.release"]);
});

test("server engine: the cursor leaving via the notifier also confirms the laptop", async () => {
  const { e, reports } = engine("ok");
  const done = e.activateRemote();
  await new Promise((r) => setTimeout(r, 400));
  assert.notEqual(reports.at(-1)!.target, "laptop", "not confirmed before the cursor moves");
  e.cursor("leave");
  await done;
  assert.equal(reports.at(-1)!.target, "laptop");
  e.cursor("enter");
  assert.equal(reports.at(-1)!.target, "gaming-pc");
  await e.deactivate();
});

test("server engine: a crash reports local input with an error", async () => {
  const { e, p, reports } = engine("crash");
  await assert.rejects(e.activateRemote(), /stopped unexpectedly \(exit code 3\)\. Last output: .*ERROR: cannot listen for clients/);
  const last = reports.at(-1)!;
  assert.equal(last.hooksActive, false);
  assert.equal(last.target, "gaming-pc");
  // The whole run is kept on disk for troubleshooting.
  await new Promise((r) => setTimeout(r, 50));
  const log = readFileSync(join(p.dir, "deskflow-server.log"), "utf8");
  assert.match(log, /INFO: started server/);
  assert.match(log, /ERROR: cannot listen for clients/);
  assert.match(log, /# exited .* with code 3/);
});

test("crash messages prefer Deskflow's last error and show Windows crash codes in hex", () => {
  assert.equal(lastError(["INFO: a", "ERROR: b", "DEBUG: c"]), "ERROR: b");
  assert.equal(lastError(["INFO: a", "DEBUG: c"]), "DEBUG: c");
  assert.equal(lastError([]), undefined);
  assert.match(crashed(3221225477, [], "x.log").message, /exit code 0xC0000005\)$/);
  assert.match(crashed(1, [], "x.log").hint!, /x\.log/);
});

test("server engine: a missing Deskflow install is a clear error", async () => {
  const e = new DeskflowServerInput({ ...paths(), exe: "C:/nope/deskflow-core.exe", exePrefixArgs: [] }, { request: async () => {} });
  e.onReport(() => {});
  await assert.rejects(e.activateRemote(), /Deskflow was not found/);
});
