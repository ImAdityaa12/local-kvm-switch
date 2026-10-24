import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import type { AgentState } from "../../lib/protocol/index.ts";
import { parseAudioCommand, parseAudioMirror, type AudioCommand, type AudioMirror } from "../src/audio/mirror.ts";
import { Controller } from "../src/controller.ts";
import { PeerLink, type PeerEvent, type PeerRequest } from "../src/peer/link.ts";
import { Store } from "../src/store.ts";
import { SimAudio, SimInput, SimPairing, SimWorld } from "../src/sim/world.ts";

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const route = { enabled: true, status: "streaming" as const, deviceId: "dev-1", format: { sampleRate: 48000, channels: 2, bitDepth: 32, sample: "f32" as const }, volume: 0.8, muted: false, levelDb: -12, retry: null };
const mirror: AudioMirror = {
  audio: {
    laptopToPc: { ...route, stats: { bufferMs: 40, underruns: 0, droppedFrames: 0 }, conversion: null },
    pcToLaptop: { ...route, enabled: false, status: "off", levelDb: null, format: null },
    micToLaptop: { ...route, enabled: false, status: "off", levelDb: null, deviceId: null, format: null, virtualEndpoint: { present: true, name: "CABLE Output", isDefault: true } },
  },
  devices: {
    playback: [{ id: "dev-1", name: "IEM DAC", isDefault: true, mix: null }],
    capture: [{ id: "mic-1", name: "IEM mic", isDefault: false, mix: null }],
  },
};

test("the gaming PC's audio state keeps only known, well-formed fields", () => {
  assert.deepEqual(parseAudioMirror(JSON.parse(JSON.stringify(mirror))), mirror);
  assert.equal(parseAudioMirror(null), null);
  assert.equal(parseAudioMirror({ ...mirror, audio: { ...mirror.audio, laptopToPc: { ...route, volume: 2 } } }), null, "volume out of range");
  assert.equal(parseAudioMirror({ ...mirror, audio: { ...mirror.audio, laptopToPc: { ...route, status: "exploding" } } }), null);
  const loose = parseAudioMirror({
    audio: { laptopToPc: { ...route, extra: 1, error: { code: "x", message: "m".repeat(999) } }, micToLaptop: { ...route, virtualEndpoint: "?" } },
    devices: { playback: [{ id: "a", name: "A", isDefault: false }, { id: 5 }], capture: "nope" },
  });
  assert.ok(loose);
  assert.equal("extra" in loose.audio.laptopToPc, false);
  assert.equal(loose.audio.laptopToPc.error?.message.length, 300);
  assert.deepEqual(loose.audio.micToLaptop.virtualEndpoint, { present: false, isDefault: null });
  // A gaming PC older than the gaming PC's sound on the laptop sends no such route.
  assert.equal(loose.audio.pcToLaptop.enabled, false);
  assert.equal(loose.audio.pcToLaptop.status, "off");
  assert.deepEqual(loose.devices, { playback: [{ id: "a", name: "A", isDefault: false, mix: null }], capture: [] });
});

test("only audio commands, checked like the dashboard's, cross from the laptop", () => {
  assert.deepEqual(parseAudioCommand({ type: "audio.setVolume", route: "laptopToPc", volume: 0.5 }), { type: "audio.setVolume", route: "laptopToPc", volume: 0.5 });
  assert.deepEqual(parseAudioCommand({ type: "audio.setEnabled", route: "micToLaptop", enabled: true }), { type: "audio.setEnabled", route: "micToLaptop", enabled: true });
  assert.equal(parseAudioCommand({ type: "audio.setVolume", route: "laptopToPc", volume: 5 }), null);
  assert.equal(parseAudioCommand({ type: "audio.setMuted", route: "x", muted: true }), null);
  assert.equal(parseAudioCommand({ type: "mode.set", mode: "laptop" }), null, "not an audio command");
  assert.equal(parseAudioCommand({ type: "peer.forget" }), null);
});

test("peer link: the laptop sees the gaming PC's audio and sends it audio commands", async () => {
  const port = await freePort();
  const psk = randomBytes(32);
  const id = "lan-kvm-test";
  const pcSeen: PeerRequest[] = [];
  const lapEvents: PeerEvent[] = [];
  const pc = new PeerLink({
    machine: "gaming-pc", name: "PC", version: "0", bind: "127.0.0.1", port,
    trust: () => ({ id, psk, name: "Laptop", machine: "laptop", address: null, pairedAt: 0 }),
    onLink: () => {}, onRequest: async (r) => void pcSeen.push(r), onEvent: () => {},
  });
  const lap = new PeerLink({
    machine: "laptop", name: "LAP", version: "0", port,
    trust: () => ({ id, psk, name: "Gaming PC", machine: "gaming-pc", address: "127.0.0.1", pairedAt: 0 }),
    onLink: () => {}, onRequest: async () => {}, onEvent: (e) => void lapEvents.push(e),
  });
  await pc.start();
  await lap.start();
  try {
    await until(() => pc.online && lap.online);
    pc.emit({ op: "audio.state", mirror });
    await until(() => lapEvents.length > 0);
    assert.deepEqual(lapEvents[0], { op: "audio.state", mirror });

    const command: AudioCommand = { type: "audio.setDevice", route: "laptopToPc", deviceId: "dev-1" };
    await lap.request({ op: "audio.command", command });
    assert.deepEqual(pcSeen, [{ op: "audio.command", command }]);
    // Anything else dressed as an audio command never reaches the gaming PC.
    await assert.rejects(lap.request({ op: "audio.command", command: { type: "peer.forget" } as unknown as AudioCommand }, 500));
    assert.equal(pcSeen.length, 1);
  } finally {
    await lap.stop();
    await pc.stop();
  }
});

test("on the laptop, audio commands go to the gaming PC and leave the local engine alone", async () => {
  const world = new SimWorld(5);
  const audio = new SimAudio(world);
  const idle = { enabled: false, status: "off" as const, deviceId: null, format: null, volume: 1, muted: false, levelDb: null, retry: null };
  const store = new Store({
    agent: { name: "lap", machine: "laptop", version: "0", protocol: 1, simulated: true, engines: { input: "simulated", audio: "simulated" }, lanAddress: null },
    peer: { link: "online", name: "PC", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false },
    audio: { laptopToPc: idle, pcToLaptop: idle, micToLaptop: { ...idle, virtualEndpoint: { present: true, isDefault: true } } },
    devices: { playback: [], capture: [] },
    events: [],
  } satisfies AgentState);
  const sent: AudioCommand[] = [];
  const controller = new Controller({
    store,
    input: new SimInput(world),
    audio,
    peer: world.peer,
    pairing: new SimPairing(world, store, () => {}),
    remoteAudio: async (c) => void sent.push(c),
  });
  await controller.handle({ type: "audio.setEnabled", route: "laptopToPc", enabled: true });
  await controller.handle({ type: "audio.setVolume", route: "micToLaptop", volume: 0.3 });
  assert.deepEqual(sent, [
    { type: "audio.setEnabled", route: "laptopToPc", enabled: true },
    { type: "audio.setVolume", route: "micToLaptop", volume: 0.3 },
  ]);
  // The gaming PC's confirmation, not this command, changes what the laptop shows.
  assert.equal(store.state.audio.laptopToPc.enabled, false);
  assert.equal(store.state.audio.micToLaptop.volume, 1);
});
