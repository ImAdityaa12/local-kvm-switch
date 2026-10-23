import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentState } from "../../lib/protocol/index.ts";
import { Controller } from "../src/controller.ts";
import { Store } from "../src/store.ts";
import { SimAudio, SimInput, SimPairing, SimWorld } from "../src/sim/world.ts";

async function setup(opts: { unpaired?: boolean; endpoint?: boolean; edge?: boolean } = {}) {
  const world = new SimWorld(5);
  world.endpointPresent = opts.endpoint ?? true;
  const input = new SimInput(world);
  const audio = new SimAudio(world);
  const devices = await audio.listDevices();
  const route = { enabled: false, status: "off" as const, format: null, volume: 1, muted: false, levelDb: null, retry: null };
  const initial: AgentState = {
    agent: { name: "t", machine: "gaming-pc", version: "0", protocol: 1, simulated: true, engines: { input: "simulated", audio: "simulated" }, lanAddress: null },
    peer: opts.unpaired ? { link: "unpaired", pairing: null } : { link: "online", name: "L", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false, ...(opts.edge !== undefined ? { edgeSwitch: opts.edge } : {}) },
    audio: {
      laptopToPc: { ...route, deviceId: devices.playback[0].id },
      micToLaptop: { ...route, deviceId: devices.capture[0].id, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    events: [],
  };
  const store = new Store(initial);
  const timers: (() => void)[] = [];
  const saved: boolean[] = [];
  const controller = new Controller({
    store,
    input,
    audio,
    peer: world.peer,
    pairing: new SimPairing(world, store, () => {}),
    sim: world,
    saveEdgeSwitch: (on) => void saved.push(on),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const runTimers = async () => {
    while (timers.length) {
      timers.shift()!();
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  return { world, store, controller, audio, input, saved, runTimers };
}

test("gaming PC mode has no hooks and switching to laptop is confirmed, not optimistic", async () => {
  const { store, controller, audio } = await setup();
  assert.equal(store.state.input.hooksActive, false);

  const seen: (string | null)[] = [];
  store.subscribe((s) => seen.push(s.input.pending ? `pending:${s.input.target}` : s.input.target));
  await controller.handle({ type: "input.setTarget", target: "laptop" });

  assert.equal(store.state.input.target, "laptop");
  assert.equal(store.state.input.pending, null);
  assert.equal(store.state.input.hooksActive, true);
  // The target was never reported as laptop while still pending confirmation.
  assert.ok(seen.includes("pending:gaming-pc"));

  await controller.handle({ type: "input.returnLocal" });
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.hooksActive, false);
  assert.equal(store.state.input.engine, "stopped");
  audio.dispose();
});

test("switching to laptop is refused when no laptop is paired", async () => {
  const { store, controller, audio } = await setup({ unpaired: true });
  await assert.rejects(controller.handle({ type: "input.setTarget", target: "laptop" }), /No laptop is paired/);
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.hooksActive, false);
  audio.dispose();
});

test("laptop disconnect while remote returns input to the gaming PC", async () => {
  const { world, store, controller, audio } = await setup();
  await controller.handle({ type: "input.setTarget", target: "laptop" });
  world.setPeerReachable(false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.state.peer.link, "offline");
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.hooksActive, false);
  assert.ok(store.state.events.some((e) => e.message === "L disconnected: No reply from the laptop agent"));
  audio.dispose();
});

test("audio route reconnects with bounded backoff, then gives up", async () => {
  const { world, store, controller, audio, runTimers } = await setup();
  await controller.handle({ type: "audio.setEnabled", route: "laptopToPc", enabled: true });
  assert.equal(store.state.audio.laptopToPc.status, "streaming");
  assert.equal(store.state.audio.laptopToPc.format?.sampleRate, 48_000);

  world.setPeerReachable(false);
  assert.equal(store.state.audio.laptopToPc.status, "reconnecting");
  assert.equal(store.state.audio.laptopToPc.retry?.attempt, 1);

  await runTimers();
  assert.equal(store.state.audio.laptopToPc.status, "error");
  assert.equal(store.state.audio.laptopToPc.enabled, false);
  // Input was never touched by the audio failure.
  assert.equal(store.state.input.hooksActive, false);
  audio.dispose();
});

test("audio route recovers when the peer returns", async () => {
  const { world, store, controller, audio, runTimers } = await setup();
  await controller.handle({ type: "audio.setEnabled", route: "laptopToPc", enabled: true });
  world.setPeerReachable(false);
  world.setPeerReachable(true);
  await runTimers();
  assert.equal(store.state.audio.laptopToPc.status, "streaming");
  audio.dispose();
});

test("mic route refuses to start without a virtual endpoint on the laptop", async () => {
  const { store, controller, audio } = await setup({ endpoint: false });
  await assert.rejects(controller.handle({ type: "audio.setEnabled", route: "micToLaptop", enabled: true }), /virtual microphone/);
  assert.equal(store.state.audio.micToLaptop.status, "error");
  assert.equal(store.state.audio.micToLaptop.error?.code, "endpoint-missing");
  audio.dispose();
});

test("choosing a device that does not exist is rejected and nothing changes", async () => {
  const { store, controller, audio } = await setup();
  const before = store.state.audio.laptopToPc.deviceId;
  await assert.rejects(controller.handle({ type: "audio.setDevice", route: "laptopToPc", deviceId: "nope" }));
  assert.equal(store.state.audio.laptopToPc.deviceId, before);
  audio.dispose();
});

test("return to gaming PC cancels a switch that is still waiting", async () => {
  const { store, controller, audio } = await setup();
  const switching = controller.handle({ type: "input.setTarget", target: "laptop" });
  await new Promise((r) => setTimeout(r, 8));
  assert.equal(store.state.input.pending?.target, "laptop");
  const started = Date.now();
  await controller.handle({ type: "input.returnLocal" });
  await assert.rejects(switching);
  assert.ok(Date.now() - started < 1000, "did not wait for the switch timeout");
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.hooksActive, false);
  assert.equal(store.state.input.pending, null);
  audio.dispose();
});

test("a waiting audio route retries as soon as the laptop is back", async () => {
  const { world, store, controller, audio } = await setup();
  await controller.handle({ type: "audio.setEnabled", route: "laptopToPc", enabled: true });
  world.setPeerReachable(false);
  assert.equal(store.state.audio.laptopToPc.status, "reconnecting");
  // Timers are held by the test harness and never run here, so only the link event can restart it.
  world.setPeerReachable(true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.state.audio.laptopToPc.status, "streaming");
  audio.dispose();
});

test("the laptop keeps its idle client running until the gaming PC releases it", async () => {
  const { store, audio } = await setup();
  store.update((s) => {
    s.agent.machine = "laptop";
  });
  let report: (r: import("../src/engines.ts").InputReport) => void = () => {};
  let stops = 0;
  new Controller({
    store,
    input: {
      kind: "deskflow",
      onReport: (cb) => (report = cb),
      activateRemote: () => Promise.reject(new Error("not used")),
      deactivate: async () => void stops++,
    },
    audio,
    peer: { onLink: () => {} },
    pairing: new SimPairing(new SimWorld(5), store, () => {}),
  });
  // The client is up and connected, but the cursor is still on the gaming PC.
  report({ target: "gaming-pc", engine: "running", hooksActive: true, clientConnected: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stops, 0);
  assert.equal(store.state.input.engine, "running");
  audio.dispose();
});

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), what);
}

test("edge switching: Deskflow waits at the edges in Gaming PC mode, and the edges move only the input", async () => {
  const { store, input, audio } = await setup({ edge: true });
  await until(() => store.state.input.clientConnected, "waiting at the edges with the laptop connected");
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.hooksActive, true);
  assert.equal(store.state.input.pending, null);

  input.cross("laptop");
  assert.equal(store.state.input.target, "laptop");
  input.cross("gaming-pc");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.state.input.target, "gaming-pc");
  assert.equal(store.state.input.engine, "running", "coming home over the edge keeps it waiting");
  audio.dispose();
});

test("edge switching off: Deskflow stops, the setting is saved, and coming home stops it again", async () => {
  const { store, controller, input, saved, audio } = await setup({ edge: true });
  await until(() => store.state.input.clientConnected, "waiting at the edges");
  await controller.handle({ type: "input.setEdgeSwitch", enabled: false });
  assert.deepEqual(saved, [false]);
  assert.equal(store.state.input.edgeSwitch, false);
  assert.equal(store.state.input.engine, "stopped");
  assert.equal(store.state.input.hooksActive, false);

  // Without edge switching, the cursor coming home stops the engine, as before.
  await controller.handle({ type: "input.setTarget", target: "laptop" });
  input.cross("gaming-pc");
  await until(() => store.state.input.engine === "stopped", "engine stopped after the cursor came home");
  assert.equal(store.state.input.hooksActive, false);

  await controller.handle({ type: "input.setEdgeSwitch", enabled: true });
  assert.deepEqual(saved, [false, true]);
  await until(() => store.state.input.clientConnected, "waiting at the edges again");
  audio.dispose();
});

test("edge switching: the laptop going away stops Deskflow, and it waits again when the laptop is back", async () => {
  const { world, store, audio } = await setup({ edge: true });
  await until(() => store.state.input.clientConnected, "waiting at the edges");
  world.setPeerReachable(false);
  await until(() => store.state.input.engine === "stopped", "stopped while the laptop is away");
  assert.equal(store.state.input.hooksActive, false);
  world.setPeerReachable(true);
  await until(() => store.state.input.clientConnected, "waiting at the edges once the laptop is back");
  audio.dispose();
});

test("without edge switching nothing waits at the edges in Gaming PC mode", async () => {
  const { store, audio } = await setup({ edge: false });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.state.input.engine, "stopped");
  assert.equal(store.state.input.hooksActive, false);
  audio.dispose();
});
