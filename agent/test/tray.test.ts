import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentState } from "../../lib/protocol/index.ts";
import { trayView } from "../src/tray.ts";

function state(patch: (s: AgentState) => void = () => {}): AgentState {
  const route = { enabled: false, status: "off" as const, deviceId: null, format: null, volume: 1, muted: false, levelDb: null, retry: null };
  const s: AgentState = {
    agent: { name: "t", machine: "gaming-pc", version: "0", protocol: 1, simulated: false, engines: { input: "deskflow", audio: "wasapi" }, lanAddress: null },
    peer: { link: "online", name: "L", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false, hotkeys: { toLaptop: "Ctrl+Alt+Left", toGamingPc: "Ctrl+Alt+Right" } },
    audio: { laptopToPc: { ...route }, micToLaptop: { ...route, virtualEndpoint: { present: true, isDefault: false } } },
    devices: { playback: [], capture: [] },
    events: [],
  };
  patch(s);
  return s;
}

test("tray: grey on the gaming PC, and Switch to laptop is offered", () => {
  const v = trayView(state());
  assert.equal(v.icon, "local");
  assert.equal(v.status, "Gaming PC has the keyboard and mouse");
  assert.equal(v.canSwitch, true);
  assert.equal(v.canReturn, false);
  assert.equal(v.switchLabel, "Switch to laptop");
});

test("tray: amber while waiting for the hotkey, with the key to press", () => {
  const v = trayView(state((s) => (s.input.pending = { target: "laptop", since: 0, step: "press-hotkey" })));
  assert.equal(v.icon, "busy");
  assert.equal(v.status, "Switching to the laptop: press Ctrl+Alt+Left");
  assert.equal(v.canSwitch, false);
  assert.equal(v.canReturn, true);
});

test("tray: green when the laptop has input, and Return is offered", () => {
  const v = trayView(state((s) => ((s.input.target = "laptop"), (s.input.hooksActive = true))));
  assert.equal(v.icon, "remote");
  assert.equal(v.canReturn, true);
  assert.equal(v.canSwitch, false);
});

test("tray: red when the laptop is unreachable, and switching is not offered", () => {
  const v = trayView(state((s) => (s.peer = { link: "offline", name: "L", pairing: null })));
  assert.equal(v.icon, "problem");
  assert.equal(v.status, "Laptop is not reachable");
  assert.equal(v.canSwitch, false);
});

test("tray: the laptop can take the keyboard and mouse, and offers Return while it has input", () => {
  const idle = trayView(state((s) => (s.agent.machine = "laptop")));
  assert.equal(idle.switchLabel, "Take keyboard and mouse");
  assert.equal(idle.canSwitch, true);
  assert.equal(idle.canReturn, false);
  const offline = trayView(state((s) => ((s.agent.machine = "laptop"), (s.peer = { link: "offline", name: "PC", pairing: null }))));
  assert.equal(offline.canSwitch, false);
  assert.equal(offline.status, "Gaming PC is not reachable");
  const remote = trayView(state((s) => ((s.agent.machine = "laptop"), (s.input.target = "laptop"))));
  assert.equal(remote.status, "This laptop has the keyboard and mouse");
  assert.equal(remote.canReturn, true);
  assert.equal(remote.canSwitch, false);
});
