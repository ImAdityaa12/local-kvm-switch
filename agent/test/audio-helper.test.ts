// Integration tests for the native helper (native/kvm-audio). Skipped when it
// has not been built (npm run build:audio). Nothing here makes a sound: audio
// goes to WAV files, and the one device test plays at volume 0.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCablePlayback } from "../src/audio/engine.ts";
import { HelperProcess, helperPath } from "../src/audio/helper.ts";

const exe = helperPath(fileURLToPath(new URL("../..", import.meta.url)));
const skip = existsSync(exe) ? false : "audio helper not built";
const dir = mkdtempSync(join(tmpdir(), "kvm-audio-"));
let port = 24_890;

function readWavF32(path: string) {
  const d = readFileSync(path);
  const rate = d.readUInt32LE(24);
  const ch = d.readUInt16LE(22);
  const samples = new Float32Array(d.buffer.slice(d.byteOffset + 44, d.byteOffset + d.length));
  return { rate, ch, samples };
}

async function waitFor(h: HelperProcess, event: string, ms = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} event`)), ms);
    h.on(event, (e) => {
      clearTimeout(t);
      resolve(e);
    });
  });
}

test("lists real devices", { skip }, async () => {
  const devices = await HelperProcess.list(exe);
  assert.ok(Array.isArray(devices.playback));
  assert.ok(Array.isArray(devices.capture));
});

test("a 1 kHz tone arrives intact at the receiver", { skip }, async () => {
  const p = port++;
  const wav = join(dir, "tone.wav");
  const play = HelperProcess.spawn(exe, ["play", "--listen", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "1.5"]);
  await waitFor(play, "listening");
  const send = HelperProcess.spawn(exe, ["send", "--connect", `127.0.0.1:${p}`, "--tone", "1000"]);
  await waitFor(play, "streaming");
  await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);

  const { rate, ch, samples } = readWavF32(wav);
  assert.equal(rate, 48_000);
  assert.equal(ch, 2);
  const left = samples.filter((_, i) => i % 2 === 0);
  const right = samples.filter((_, i) => i % 2 === 1);
  assert.deepEqual(left, right, "channels not swapped or mixed");
  const peak = left.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(Math.abs(20 * Math.log10(peak) + 12) < 0.05, `peak ${20 * Math.log10(peak)} dBFS, want -12`);
  let crossings = 0;
  for (let i = 1; i < left.length; i++) if (left[i - 1] < 0 && left[i] >= 0) crossings++;
  const hz = crossings / (left.length / rate);
  assert.ok(Math.abs(hz - 1000) < 5, `frequency ${hz}`);
});

test("volume ramps instead of jumping", { skip }, async () => {
  const p = port++;
  const wav = join(dir, "ramp.wav");
  const play = HelperProcess.spawn(exe, ["play", "--listen", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "1.2"]);
  await waitFor(play, "listening");
  const send = HelperProcess.spawn(exe, ["send", "--connect", `127.0.0.1:${p}`, "--tone", "250"]);
  await waitFor(play, "streaming");
  await new Promise((r) => setTimeout(r, 300));
  play.command({ cmd: "volume", value: 0 });
  await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);
  const { samples } = readWavF32(wav);
  const left = samples.filter((_, i) => i % 2 === 0);
  // Gain moves at most 1/480 per frame (10 ms ramp), plus the tone's own slope.
  const maxToneStep = 2 * Math.PI * 250 / 48_000 * 0.2512;
  for (let i = 1; i < left.length; i++) assert.ok(Math.abs(left[i] - left[i - 1]) <= maxToneStep + 0.002);
  assert.equal(Math.abs(left.at(-1)!), 0);
});

test("system audio loopback streams (silence is filled, not stalled)", { skip }, async () => {
  const p = port++;
  const wav = join(dir, "loop.wav");
  const play = HelperProcess.spawn(exe, ["play", "--listen", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "1"]);
  await waitFor(play, "listening");
  const send = HelperProcess.spawn(exe, ["send", "--connect", `127.0.0.1:${p}`]);
  const started = await waitFor(send, "streaming");
  assert.equal((started.format as { sampleRate: number }).sampleRate > 0, true);
  const done = await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);
  assert.ok((done.frames as number) > 0);
});

test("plays on a real device (volume 0, so silent)", { skip }, async () => {
  const p = port++;
  const play = HelperProcess.spawn(exe, ["play", "--listen", `127.0.0.1:${p}`, "--volume", "0"]);
  await waitFor(play, "listening");
  const send = HelperProcess.spawn(exe, ["send", "--connect", `127.0.0.1:${p}`, "--tone", "440"]);
  const fmt = await waitFor(play, "format");
  assert.ok("conversion" in fmt);
  await waitFor(play, "streaming");
  const stats = await waitFor(play, "stats");
  assert.equal(typeof stats.bufferMs, "number");
  play.stop();
  send.stop();
  await Promise.all([play.exited, send.exited]);
});

test("refuses non-loopback addresses", { skip }, async () => {
  const h = HelperProcess.spawn(exe, ["play", "--listen", "0.0.0.0:24899"]);
  const err = await waitFor(h, "error");
  assert.match(String(err.message), /loopback/);
  await h.exited;
});

test("reverse direction: sender listens, player dials (the mic route's shape)", { skip }, async () => {
  const p = port++;
  const wav = join(dir, "reverse.wav");
  const send = HelperProcess.spawn(exe, ["send", "--listen", `127.0.0.1:${p}`, "--tone", "500"]);
  await waitFor(send, "listening");
  const play = HelperProcess.spawn(exe, ["play", "--connect", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "0.5"]);
  await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);
  const { samples } = readWavF32(wav);
  const peak = samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(Math.abs(20 * Math.log10(peak) + 12) < 0.05);
});

test("mute is applied at the sender: nothing audible leaves the machine", { skip }, async () => {
  const p = port++;
  const wav = join(dir, "muted.wav");
  const send = HelperProcess.spawn(exe, ["send", "--listen", `127.0.0.1:${p}`, "--tone", "500", "--muted"]);
  await waitFor(send, "listening");
  const play = HelperProcess.spawn(exe, ["play", "--connect", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "0.5"]);
  await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);
  const { samples } = readWavF32(wav);
  assert.ok(samples.every((x) => x === 0));
});

test("captures from a recording device (the virtual cable, so no room audio is recorded)", { skip }, async (t) => {
  const devices = await HelperProcess.list(exe);
  const cable = devices.capture.find((d) => /CABLE Output/i.test(d.name));
  if (!cable) return t.skip("VB-CABLE not installed");
  const p = port++;
  const wav = join(dir, "capture.wav");
  const send = HelperProcess.spawn(exe, ["send", "--listen", `127.0.0.1:${p}`, "--capture", cable.id]);
  await waitFor(send, "listening");
  const play = HelperProcess.spawn(exe, ["play", "--connect", `127.0.0.1:${p}`, "--wav", wav, "--seconds", "0.5"]);
  const started = await waitFor(send, "streaming");
  assert.equal(started.source, "capture");
  const done = await waitFor(play, "wav", 6000);
  send.stop();
  await Promise.all([play.exited, send.exited]);
  assert.ok((done.frames as number) > 0);
});

test("player gives up when no sender appears", { skip }, async () => {
  const play = HelperProcess.spawn(exe, ["play", "--connect", `127.0.0.1:${port++}`, "--wav", join(dir, "none.wav")]);
  const err = await waitFor(play, "error", 15_000);
  assert.equal(err.code, "peer-unreachable");
  await play.exited;
});

test("every input of the virtual cable counts as the cable, nothing else does", () => {
  assert.equal(isCablePlayback("CABLE Input (VB-Audio Virtual Cable)"), true);
  assert.equal(isCablePlayback("CABLE In 16ch (VB-Audio Virtual Cable)"), true);
  assert.equal(isCablePlayback("CABLE Output (VB-Audio Virtual Cable)"), false);
  assert.equal(isCablePlayback("Speakers (Realtek(R) Audio)"), false);
});
