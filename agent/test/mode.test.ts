import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentState, ModeStepId, MonitorInput } from "../../lib/protocol/index.ts";
import { Controller } from "../src/controller.ts";
import type { MonitorControl } from "../src/display/helper.ts";
import { ModeRunner } from "../src/mode.ts";
import { parseModeState } from "../src/peer/link.ts";
import { Store } from "../src/store.ts";
import { SimAudio, SimInput, SimPairing, SimWorld } from "../src/sim/world.ts";

// Simulated audio meters run on timers; stop them so the test process can exit.
const audios: SimAudio[] = [];
after(() => audios.forEach((a) => a.dispose()));

interface Opts {
  /** ok: switches; silent: switches but reports nothing; stuck: ignores the switch; throws: the helper fails. */
  monitor?: "ok" | "silent" | "stuck" | "throws" | "none";
  laptopOnline?: boolean;
  layoutFails?: boolean;
  endpoint?: boolean;
  /** What the monitor shows at the start. */
  screen?: MonitorInput;
}

async function setup(o: Opts = {}) {
  const world = new SimWorld(2);
  world.endpointPresent = o.endpoint ?? true;
  const input = new SimInput(world);
  const audio = new SimAudio(world);
  audios.push(audio);
  const devices = await audio.listDevices();
  const route = { enabled: false, status: "off" as const, format: null, volume: 1, muted: false, levelDb: null, retry: null };
  const initial: AgentState = {
    agent: { name: "t", machine: "gaming-pc", version: "0", protocol: 1, simulated: true, engines: { input: "simulated", audio: "simulated" }, lanAddress: null },
    peer: { link: "online", name: "L", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false },
    audio: {
      laptopToPc: { ...route, deviceId: devices.playback[0].id },
      micToLaptop: { ...route, deviceId: devices.capture[0].id, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    events: [],
  };
  const store = new Store(initial);
  let screen: MonitorInput = o.screen ?? "hdmi1";
  const monitorCalls: MonitorInput[] = [];
  const kind = o.monitor ?? "ok";
  const monitor: MonitorControl = {
    probe: async () => ({ available: kind !== "none", input: screen, via: "usb" }),
    set: async (i) => {
      monitorCalls.push(i);
      if (kind === "throws") throw new Error("USB write failed (-5)");
      if (kind !== "stuck") screen = i;
      return { readBack: kind === "silent" ? null : screen, via: "usb", ms: 800 };
    },
  };
  const layouts: string[] = [];
  let online = o.laptopOnline ?? true;
  let runner: ModeRunner | null = null;
  const controller = new Controller({ store, input, audio, peer: world.peer, pairing: new SimPairing(world, store, () => {}), sim: world, mode: () => runner });
  runner = new ModeRunner({
    store,
    run: (c) => controller.handle(c),
    monitor,
    laptop: {
      online: () => online,
      setLayout: async (t) => {
        if (o.layoutFails) throw new Error("Windows refused the display change");
        layouts.push(t);
      },
    },
  });
  await runner.refreshMonitor();
  const steps = () => Object.fromEntries(store.state.mode!.steps.map((s) => [s.id, s.status])) as Record<ModeStepId, string>;
  return { store, runner, controller, monitorCalls, layouts, steps, screen: () => screen, setOnline: (v: boolean) => (online = v), world };
}

test("mode: Laptop mode sets Extend first, then HDMI 2, input, and both audio routes", async () => {
  const t = await setup();
  assert.equal(t.store.state.mode!.monitorControl, true);
  assert.equal(t.store.state.mode!.current, "gaming-pc", "HDMI 1 and local input at start");
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  assert.deepEqual(t.layouts, ["extend"]);
  assert.deepEqual(t.monitorCalls, ["hdmi2"]);
  assert.deepEqual(t.steps(), { "laptop-display": "done", monitor: "done", input: "done", "laptop-audio": "done", microphone: "done" });
  const s = t.store.state;
  assert.equal(s.mode!.current, "laptop");
  assert.equal(s.mode!.pending, null);
  assert.equal(s.mode!.monitor!.input, "hdmi2");
  assert.equal(s.input.target, "laptop");
  assert.equal(s.audio.laptopToPc.status, "streaming");
  assert.equal(s.audio.micToLaptop.status, "streaming");
  // The step order on the wire is the order they ran.
  assert.deepEqual(s.mode!.steps.map((x) => x.id), ["laptop-display", "monitor", "input", "laptop-audio", "microphone"]);
});

test("mode: Gaming PC mode returns input first, stops audio, then HDMI 1, then PC screen only", async () => {
  const t = await setup();
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  await t.controller.handle({ type: "mode.set", mode: "gaming-pc" });
  assert.deepEqual(t.monitorCalls, ["hdmi2", "hdmi1"]);
  assert.deepEqual(t.layouts, ["extend", "internal"]);
  assert.deepEqual(t.steps(), { input: "done", "laptop-audio": "done", microphone: "done", monitor: "done", "laptop-display": "done" });
  const s = t.store.state;
  assert.equal(s.mode!.current, "gaming-pc");
  assert.equal(s.input.target, "gaming-pc");
  assert.equal(s.input.hooksActive, false);
  assert.equal(s.audio.laptopToPc.status, "off");
  assert.equal(s.audio.micToLaptop.status, "off");
});

test("mode: the laptop keeps Extend when the monitor does not confirm HDMI 1", async () => {
  for (const kind of ["silent", "stuck", "throws"] as const) {
    const t2 = await setup({ monitor: kind, screen: "hdmi2" });
    // Start from Laptop mode by hand, since this monitor cannot get there: input on the laptop.
    await t2.controller.handle({ type: "input.setTarget", target: "laptop" });
    t2.store.update((s) => void (s.mode!.current = "laptop"));
    await t2.controller.handle({ type: "mode.set", mode: "gaming-pc" });
    const st = t2.steps();
    assert.equal(st.input, "done", `${kind}: input still comes home`);
    assert.equal(st["laptop-display"], "skipped", `${kind}: laptop keeps Extend`);
    assert.deepEqual(t2.layouts, [], `${kind}: no layout change sent`);
    assert.equal(st.monitor, kind === "silent" ? "unconfirmed" : "failed");
    assert.equal(t2.store.state.mode!.current, "gaming-pc", "input is local, so this is Gaming PC mode");
  }
});

test("mode: a monitor that ignores the switch stops Laptop mode before the input moves", async () => {
  const t = await setup({ monitor: "stuck" });
  await assert.rejects(t.controller.handle({ type: "mode.set", mode: "laptop" }), /still reports HDMI 1/);
  assert.deepEqual(t.steps(), { "laptop-display": "done", monitor: "failed", input: "skipped", "laptop-audio": "skipped", microphone: "skipped" });
  assert.equal(t.store.state.input.target, "gaming-pc");
  assert.equal(t.store.state.mode!.current, null);
  assert.match(t.store.state.mode!.error!.message, /still reports HDMI 1/);
});

test("mode: an unreported input after the switch is shown as unconfirmed, and the switch goes on", async () => {
  const t = await setup({ monitor: "silent" });
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  assert.equal(t.steps().monitor, "unconfirmed");
  assert.equal(t.steps().input, "done");
  assert.match(t.store.state.mode!.steps.find((s) => s.id === "monitor")!.detail!, /did not report/);
});

test("mode: without monitor control the monitor step is skipped, not claimed", async () => {
  const t = await setup({ monitor: "none" });
  assert.equal(t.store.state.mode!.monitorControl, false);
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  assert.equal(t.steps().monitor, "skipped");
  assert.deepEqual(t.monitorCalls, []);
  assert.equal(t.steps().input, "done");
});

test("mode: an unreachable laptop or a refused layout stops Laptop mode before the monitor moves", async () => {
  const off = await setup({ laptopOnline: false });
  await assert.rejects(off.controller.handle({ type: "mode.set", mode: "laptop" }), /laptop is not reachable/);
  assert.deepEqual(off.monitorCalls, []);
  const refused = await setup({ layoutFails: true });
  await assert.rejects(refused.controller.handle({ type: "mode.set", mode: "laptop" }), /Extend: Windows refused/);
  assert.deepEqual(refused.monitorCalls, []);
  assert.equal(refused.steps().monitor, "skipped");
});

test("mode: if the input switch fails, the monitor goes back to HDMI 1", async () => {
  const t = await setup();
  t.world.peerReachable = false; // the simulated laptop client never connects
  await assert.rejects(t.controller.handle({ type: "mode.set", mode: "laptop" }), /did not connect/);
  assert.deepEqual(t.monitorCalls, ["hdmi2", "hdmi1"]);
  assert.equal(t.screen(), "hdmi1");
  assert.equal(t.steps().input, "failed");
  assert.match(t.store.state.mode!.error!.message, /monitor put back on HDMI 1/);
});

test("mode: audio failures are reported but do not stop Laptop mode", async () => {
  const t = await setup({ endpoint: false });
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  assert.equal(t.steps().microphone, "failed");
  assert.equal(t.steps()["laptop-audio"], "done");
  assert.equal(t.store.state.mode!.current, "laptop");
});

test("mode: the hotkey home in Laptop mode finishes the whole return", async () => {
  const t = await setup();
  await t.controller.handle({ type: "mode.set", mode: "laptop" });
  // The cursor came back by Ctrl+Alt+Right: the engine reports the gaming PC while still running.
  assert.equal(t.runner.cursorHome(), true);
  for (let i = 0; i < 100 && t.store.state.mode!.current !== "gaming-pc"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.store.state.mode!.current, "gaming-pc");
  assert.equal(t.screen(), "hdmi1");
  assert.deepEqual(t.layouts, ["extend", "internal"]);
});

test("mode: asking for Gaming PC mode during a switch to the laptop cancels it", async () => {
  const t = await setup();
  const toLaptop = t.controller.handle({ type: "mode.set", mode: "laptop" });
  await new Promise((r) => setTimeout(r, 1));
  const home = t.controller.handle({ type: "mode.set", mode: "gaming-pc" });
  await assert.rejects(toLaptop);
  await home;
  assert.equal(t.store.state.mode!.current, "gaming-pc");
  assert.equal(t.store.state.input.target, "gaming-pc");
  assert.equal(t.screen(), "hdmi1");
});

test("mode state survives the trip to the laptop, and junk is dropped", () => {
  const mode = {
    current: "laptop",
    pending: null,
    target: "laptop",
    steps: [
      { id: "monitor", status: "unconfirmed", detail: "sent" },
      { id: "evil", status: "done" },
    ],
    monitor: { input: "hdmi2", at: 5, via: "usb" },
    monitorControl: true,
    laptopDisplay: "extend",
    error: { code: "x", message: "m", hint: 3 },
  };
  assert.deepEqual(parseModeState(mode), {
    current: "laptop",
    pending: null,
    target: "laptop",
    steps: [{ id: "monitor", status: "unconfirmed", detail: "sent" }],
    monitor: { input: "hdmi2", at: 5, via: "usb" },
    monitorControl: true,
    laptopDisplay: "extend",
    error: { code: "internal", message: "m", hint: undefined },
  });
  assert.equal(parseModeState({ ...mode, current: "toaster" }), null);
  assert.equal(parseModeState(null), null);
});
