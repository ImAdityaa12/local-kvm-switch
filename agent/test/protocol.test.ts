import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage, parseCommand } from "../../lib/protocol/index.ts";
import { makeRateLimiter } from "../src/server.ts";

test("accepts well-formed commands", () => {
  assert.deepEqual(parseCommand({ type: "input.setTarget", target: "laptop" }), {
    ok: true,
    value: { type: "input.setTarget", target: "laptop" },
  });
  assert.equal(parseCommand({ type: "audio.setVolume", route: "micToLaptop", volume: 0.5 }).ok, true);
  assert.deepEqual(parseCommand({ type: "audio.resetDevices" }), { ok: true, value: { type: "audio.resetDevices" } });
  assert.deepEqual(parseCommand({ type: "input.setEdgeSwitch", enabled: true }), { ok: true, value: { type: "input.setEdgeSwitch", enabled: true } });
  assert.equal(parseCommand({ type: "input.setEdgeSwitch", enabled: "yes" }).ok, false);
  assert.equal(parseCommand({ type: "audio.resetDevices", route: "micToLaptop" }).ok, false);
});

test("rejects unknown fields, routes, and out-of-range values", () => {
  assert.equal(parseCommand({ type: "input.setTarget", target: "laptop", extra: 1 }).ok, false);
  assert.equal(parseCommand({ type: "input.setTarget", target: "phone" }).ok, false);
  assert.equal(parseCommand({ type: "audio.setEnabled", route: "nowhere", enabled: true }).ok, false);
  assert.equal(parseCommand({ type: "audio.setVolume", route: "laptopToPc", volume: 2 }).ok, false);
  assert.equal(parseCommand({ type: "audio.setVolume", route: "laptopToPc", volume: Number.NaN }).ok, false);
  assert.equal(parseCommand({ type: "rm -rf" }).ok, false);
});

test("caps message size and requires JSON", () => {
  assert.equal(parseClientMessage("{").ok, false);
  const big = JSON.stringify({ type: "hello", token: "x".repeat(20_000), protocol: 1 });
  const r = parseClientMessage(big);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "message too large");
});

test("rate limiter allows a burst then throttles", () => {
  let t = 0;
  const allow = makeRateLimiter(3, 1, () => t);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), true);
  assert.equal(allow(), false);
  t += 1000;
  assert.equal(allow(), true);
});
