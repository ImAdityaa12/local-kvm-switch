import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandLine, iniString, serverLayout, settingsIni } from "../src/deskflow/config.ts";
import { conflictDetail } from "../src/deskflow/preflight.ts";
import { DeskflowClient, DeskflowServerInput, LaptopInput, crashed, lastError, type ClientStatus, type DeskflowPaths } from "../src/deskflow/engines.ts";
import { pressScript } from "../src/deskflow/hotkey.ts";
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
  assert.match(l, /keystroke\(control\+alt\+Left\) = switchToScreen\(laptop\)/);
  assert.match(l, /keystroke\(control\+alt\+Right\) = switchToScreen\(gaming-pc\)/);
  // The laptop is to the left of the gaming PC, and no laptop edge leads back.
  assert.match(l, /\tgaming-pc:\r\n\t\tleft = laptop/);
  assert.doesNotMatch(l, /\tlaptop:/);
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

test("a Deskflow we did not start is named by what started it", () => {
  assert.match(conflictDetail(["deskflow.exe"]).message, /Deskflow app/);
  assert.match(conflictDetail(["deskflow.exe"]).hint, /Startup apps/);
  assert.match(conflictDetail(["deskflow-daemon.exe"]).message, /Deskflow service/);
  assert.match(conflictDetail(["node.exe"]).message, /Another LAN KVM agent/);
  assert.match(conflictDetail([""]).hint, /Task Manager/);
});

test("client settings for the Deskflow service: client mode, run as SYSTEM, output to a file", () => {
  const c = settingsIni({ mode: "client", port: 24811, enterCommand: "a", exitCommand: "b", service: { logFile: "C:/d/deskflow-client.log" } });
  assert.match(c, /\[core\]\r\ncomputerName=laptop\r\ncoreMode=1\r\n/);
  assert.match(c, /\[log\]\r\nlevel=Debug\r\ntoFile=true\r\nfile="C:\/d\/deskflow-client\.log"/);
  assert.match(c, /\[daemon\]\r\nelevate=true/);
  const direct = settingsIni({ mode: "client", port: 24811, enterCommand: "a", exitCommand: "b" });
  assert.doesNotMatch(direct, /coreMode|\[daemon\]|elevate/);
  assert.match(direct, /toFile=false/);
});

/** Stands in for deskflow-daemon: answers "ok" and, on start, writes the client's log like its core would. */
async function fakeService() {
  const name = `kvm-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const commands: string[] = [];
  let configFile = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let rest = "";
    socket.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        commands.push(line);
        if (line.startsWith("configFile=")) configFile = line.slice("configFile=".length);
        if (line === "start") {
          const log = readIniString(/^file=(.*)$/m.exec(readFileSync(configFile, "utf8"))![1].trim());
          setTimeout(() => appendFileSync(log, "[2026-10-19T12:00:00] DEBUG: connected to server\r\n"), 50);
        }
        socket.write("ok\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(pipe, r));
  return { pipe, commands, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("laptop client runs through the Deskflow service when it answers", async () => {
  const svc = await fakeService();
  try {
    const statuses: ClientStatus[] = [];
    const warnings: string[] = [];
    const c = new DeskflowClient({ ...paths(), servicePipe: svc.pipe }, (s) => statuses.push({ ...s }), (m) => warnings.push(m));
    await c.start();
    assert.equal(c.status.engine, "running");
    for (let i = 0; i < 40 && !c.status.connected; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.status.connected, true, "connection read from the core's log file");
    await c.stop();
    assert.equal(c.status.engine, "stopped");
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      svc.commands.filter((l) => l !== "noop").map((l) => l.replace(/=.*/, "=")),
      ["configFile=", "start", "stop"],
    );
    const conf = svc.commands.find((l) => l.startsWith("configFile="))!.slice("configFile=".length);
    assert.match(conf, /deskflow-client\.conf$/);
    // The service's Deskflow would open a console window for each hook; they go through the hidden runner.
    assert.match(readFileSync(conf, "utf8"), /enterCommand=".*wscript\.exe \/\/B \/\/Nologo .*notify-hidden\.vbs node notify\.mjs 47820 enter token"/);
  } finally {
    await svc.close();
  }
});

test("laptop client without the service starts Deskflow itself and says what admin windows will miss", async () => {
  process.env.FAKE_DESKFLOW = "ok";
  const missing = process.platform === "win32" ? "\\\\.\\pipe\\kvm-test-nobody" : join(tmpdir(), "kvm-test-nobody.sock");
  const warnings: string[] = [];
  const c = new DeskflowClient({ ...paths(), servicePipe: missing }, () => {}, (m) => warnings.push(m));
  await c.start();
  for (let i = 0; i < 40 && !c.status.connected; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.status.connected, true);
  await c.stop();
  await c.start();
  await c.stop();
  assert.equal(warnings.length, 1, "warned once");
  assert.match(warnings[0], /admin.*enable-deskflow/);
});

test("server engine: a click presses the hotkey itself, and the switch completes without the user", async () => {
  process.env.FAKE_DESKFLOW = "ok";
  const pressed: string[] = [];
  const p = paths();
  // Stands in for Deskflow acting on the hotkey: the cursor leaves the gaming PC.
  const e: DeskflowServerInput = new DeskflowServerInput(p, { request: async () => {} }, { pressHotkey: async (k) => void (pressed.push(k), setTimeout(() => e.cursor("leave"), 20)) });
  const reports: InputReport[] = [];
  e.onReport((r) => reports.push({ ...r }));
  await e.activateRemote();
  assert.deepEqual(pressed, ["Ctrl+Alt+Left"]);
  assert.equal(reports.at(-1)!.target, "laptop");
  assert.ok(reports.some((r) => r.step === "moving-cursor"));
  assert.ok(!reports.some((r) => r.step === "press-hotkey"), "the user is not asked to press it");
  await e.deactivate();
});

test("server engine: when pressing the hotkey does not move the cursor, the user is asked to press it", async () => {
  process.env.FAKE_DESKFLOW = "ok";
  for (const press of [async () => {}, async () => Promise.reject(new Error("no powershell"))]) {
    const e = new DeskflowServerInput(paths(), { request: async () => {} }, { pressHotkey: press, pressFallbackMs: 100 });
    const reports: InputReport[] = [];
    e.onReport((r) => reports.push({ ...r }));
    const done = e.activateRemote();
    for (let i = 0; i < 60 && reports.at(-1)?.step !== "press-hotkey"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(reports.at(-1)!.step, "press-hotkey");
    e.cursor("leave");
    await done;
    assert.equal(reports.at(-1)!.target, "laptop");
    await e.deactivate();
  }
});

test("the hotkey press holds the modifiers around the arrow and releases them in reverse", () => {
  const lines = pressScript("Ctrl+Alt+Left").split("\n").slice(1);
  assert.deepEqual(
    lines.map((l) => /keybd_event\((\d+), (\d+), (\d+),/.exec(l)!.slice(1).map(Number)),
    [
      [0x11, 0x1d, 0],
      [0x12, 0x38, 0],
      [0x25, 0x4b, 1],
      [0x25, 0x4b, 3],
      [0x12, 0x38, 2],
      [0x11, 0x1d, 2],
    ],
  );
  assert.throws(() => pressScript("Ctrl+Q"), /Cannot press the key "Q"/);
});

test("laptop input: taking asks the gaming PC to switch, giving back asks it to return and stops the client", async () => {
  process.env.FAKE_DESKFLOW = "ok";
  const asked: { op: string; timeoutMs?: number }[] = [];
  const client = new DeskflowClient(paths(), (st, err) => li.clientStatus(st, err));
  const li: LaptopInput = new LaptopInput(client, { request: async (r, timeoutMs) => void asked.push({ op: r.op, timeoutMs }) });
  const reports: InputReport[] = [];
  li.onReport((r) => reports.push({ ...r }));

  await li.activateRemote();
  assert.deepEqual(asked, [{ op: "input.take", timeoutMs: 65_000 }]);
  assert.ok(li.switchTimeoutMs >= 65_000, "the laptop waits as long as the gaming PC may");

  // The gaming PC then starts the client here (input.prepare).
  await client.start();
  for (let i = 0; i < 40 && !reports.at(-1)?.clientConnected; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(reports.at(-1)!.step, "moving-cursor");
  client.cursor("enter");
  assert.equal(reports.at(-1)!.target, "laptop");
  assert.equal(reports.at(-1)!.step, undefined);

  await li.deactivate();
  assert.equal(asked.at(-1)!.op, "input.return");
  assert.equal(client.status.engine, "stopped");
  assert.equal(reports.at(-1)!.target, "gaming-pc");
  assert.equal(reports.at(-1)!.hooksActive, false);
});

test("laptop input: giving back still stops the client when the gaming PC cannot be reached", async () => {
  process.env.FAKE_DESKFLOW = "ok";
  const client = new DeskflowClient(paths(), () => {});
  const li = new LaptopInput(client, { request: async () => Promise.reject(new Error("unreachable")) });
  await client.start();
  await li.deactivate();
  assert.equal(client.status.engine, "stopped");
});

test("with edge switching the laptop's right edge leads back; without it no laptop edge does", () => {
  assert.doesNotMatch(serverLayout(), /\tlaptop:/);
  const l = serverLayout(undefined, true);
  assert.match(l, /\tgaming-pc:\r\n\t\tleft = laptop\r\n\tlaptop:\r\n\t\tright = gaming-pc\r\nend/);
  assert.match(l, /keystroke\(control\+alt\+Right\) = switchToScreen\(gaming-pc\)/);
});

test("server engine: edge switching waits with the laptop connected, and the edges move the input with no switch asked for", async () => {
  const { e, p, requests, reports } = engine("ok");
  e.setEdges(true);
  await e.standby();
  assert.deepEqual(requests, ["input.prepare"]);
  let last = reports.at(-1)!;
  assert.equal(last.target, "gaming-pc", "the cursor stays here until it leaves the screen");
  assert.equal(last.hooksActive, true);
  assert.equal(last.clientConnected, true);
  assert.match(readFileSync(join(p.dir, "deskflow-layout.conf"), "utf8"), /\tlaptop:\r\n\t\tright = gaming-pc/);

  e.cursor("leave");
  assert.equal(reports.at(-1)!.target, "laptop");
  e.cursor("enter");
  last = reports.at(-1)!;
  assert.equal(last.target, "gaming-pc");
  assert.equal(last.engine, "running", "coming back over the edge leaves Deskflow waiting");

  // A switch from here only moves the cursor: no second server, no second prepare.
  const done = e.activateRemote();
  await new Promise((r) => setTimeout(r, 100));
  e.cursor("leave");
  await done;
  assert.deepEqual(requests, ["input.prepare"]);
  assert.equal(reports.at(-1)!.target, "laptop");
  await e.deactivate();
  assert.equal(reports.at(-1)!.hooksActive, false);
  assert.deepEqual(requests, ["input.prepare", "input.release"]);
});

test("laptop client: a start while a stop is under way waits for it, then starts a fresh client", async () => {
  const statuses: ClientStatus[] = [];
  const c = new DeskflowClient(paths(), (s) => statuses.push({ ...s }));
  await c.start();
  const stopping = c.stop();
  await c.start();
  await stopping;
  assert.equal(c.status.engine, "running", "not left stopped by the stop that was under way");
  await c.stop();
});
