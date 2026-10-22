import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentState, Machine } from "../../lib/protocol/index.ts";
import { Store } from "../src/store.ts";
import { comparisonCode, commitment, derivePsk } from "../src/peer/pairing.ts";
import { PairingManager } from "../src/peer/manager.ts";
import { TrustStore, type TrustedPeer } from "../src/peer/trust.ts";
import { PeerLink, type PeerRequest } from "../src/peer/link.ts";

const until = async (cond: () => boolean, ms = 3000) => {
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

function blankState(machine: Machine): AgentState {
  const route = { enabled: false, status: "off" as const, deviceId: null, format: null, volume: 1, muted: false, levelDb: null, retry: null };
  return {
    agent: { name: machine, machine, version: "0", protocol: 1, simulated: false, engines: { input: "none", audio: "none" }, lanAddress: null },
    peer: { link: "unpaired", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false },
    audio: { laptopToPc: route, micToLaptop: { ...route, virtualEndpoint: { present: false, isDefault: null } } },
    devices: { playback: [], capture: [] },
    events: [],
  };
}

test("comparison code is six digits and changes with any input", () => {
  const [a, b, na, nb] = [randomBytes(32), randomBytes(32), randomBytes(16), randomBytes(16)];
  const code = comparisonCode(a, b, na, nb);
  assert.match(code, /^\d{6}$/);
  assert.notEqual(comparisonCode(a, b, na, randomBytes(16)), code);
  assert.notDeepEqual(commitment(nb, b, a), commitment(randomBytes(16), b, a));
  const k1 = derivePsk(randomBytes(32), a, b, na, nb);
  assert.equal(k1.psk.length, 32);
  assert.match(k1.id, /^lan-kvm-[0-9a-f]{24}$/);
});

function codeOf(store: Store): string {
  const p = store.state.peer.pairing;
  return p?.stage === "confirm" ? p.code : "";
}

async function pairPair() {
  const port = await freePort();
  const pcStore = new Store(blankState("gaming-pc"));
  const lapStore = new Store(blankState("laptop"));
  const pcTrust = new TrustStore(mkdtempSync(join(tmpdir(), "kvm-pc-")));
  const lapTrust = new TrustStore(mkdtempSync(join(tmpdir(), "kvm-lap-")));
  const paired: string[] = [];
  const pc = new PairingManager({ machine: "gaming-pc", name: "Gaming PC", store: pcStore, trust: pcTrust, bind: "127.0.0.1", port, onPaired: () => paired.push("pc") });
  const lap = new PairingManager({ machine: "laptop", name: "Laptop", store: lapStore, trust: lapTrust, port, onPaired: () => paired.push("lap") });

  await pc.begin();
  assert.equal(pcStore.state.peer.pairing?.stage, "listening");
  await lap.begin("127.0.0.1");
  await until(() => pcStore.state.peer.pairing?.stage === "confirm" && lapStore.state.peer.pairing?.stage === "confirm");

  const pcCode = codeOf(pcStore);
  const lapCode = codeOf(lapStore);
  return { pc, lap, pcStore, lapStore, pcTrust, lapTrust, paired, pcCode, lapCode };
}

test("pairing: both sides show the same code, and only both confirmations save a key", async () => {
  const t = await pairPair();
  assert.equal(t.pcCode, t.lapCode);
  t.pc.confirm(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.pcTrust.load(), null, "one confirmation is not enough");
  t.lap.confirm(true);
  await until(() => t.paired.length === 2);

  const a = t.pcTrust.load()!;
  const b = t.lapTrust.load()!;
  assert.equal(a.id, b.id);
  assert.deepEqual(a.psk, b.psk);
  assert.equal(a.machine, "laptop");
  assert.equal(b.machine, "gaming-pc");
  assert.equal(b.address, "127.0.0.1");
  assert.equal(t.pcStore.state.peer.name, "Laptop");
});

test("pairing: a rejection on either side saves nothing", async () => {
  const t = await pairPair();
  t.pc.confirm(true);
  t.lap.confirm(false);
  await until(() => t.lapStore.state.peer.pairing === null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.pcTrust.load(), null);
  assert.equal(t.lapTrust.load(), null);
  t.pc.cancel();
});

function trustPair(): { pc: TrustedPeer; lap: TrustedPeer } {
  const psk = randomBytes(32);
  const id = "lan-kvm-test";
  return {
    pc: { id, psk, name: "Laptop", machine: "laptop", address: null, pairedAt: 0 },
    lap: { id, psk, name: "Gaming PC", machine: "gaming-pc", address: "127.0.0.1", pairedAt: 0 },
  };
}

test("peer link: connects with the paired key, carries requests, and tunnels bytes", async () => {
  const port = await freePort();
  const tunnelLocal = await freePort();
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const echoPort = (echo.address() as net.AddressInfo).port;

  const t = trustPair();
  const seen: PeerRequest[] = [];
  const links: string[] = [];
  const pcSeen: PeerRequest[] = [];
  const pc = new PeerLink({
    machine: "gaming-pc", name: "PC", version: "0", trust: () => t.pc, bind: "127.0.0.1", port,
    tunnelTargets: { echo: echoPort },
    onLink: (on) => links.push(`pc:${on}`), onRequest: async (r) => void pcSeen.push(r), onEvent: () => {},
  });
  const lap = new PeerLink({
    machine: "laptop", name: "LAP", version: "0", trust: () => t.lap, port,
    tunnelListeners: [{ name: "echo", localPort: tunnelLocal }],
    onLink: (on) => links.push(`lap:${on}`), onRequest: async (r) => void seen.push(r), onEvent: () => {},
  });
  await pc.start();
  await lap.start();
  await until(() => pc.online && lap.online);
  assert.deepEqual(links.sort(), ["lap:true", "pc:true"]);

  await pc.request({ op: "input.prepare" });
  assert.deepEqual(seen, [{ op: "input.prepare" }]);
  // The laptop can ask for input, and give it back, too.
  await lap.request({ op: "input.take" }, 65_000);
  await lap.request({ op: "input.return" });
  assert.deepEqual(pcSeen, [{ op: "input.take" }, { op: "input.return" }]);

  const reply = await new Promise<string>((resolve, reject) => {
    const c = net.connect(tunnelLocal, "127.0.0.1", () => c.write("hello through the tunnel"));
    c.on("data", (d) => (resolve(d.toString()), c.destroy()));
    c.on("error", reject);
  });
  assert.equal(reply, "hello through the tunnel");

  await lap.stop();
  await until(() => !pc.online);
  await pc.stop();
  echo.close();
});

test("peer link: a device with the wrong key never comes online", async () => {
  const port = await freePort();
  const t = trustPair();
  const pc = new PeerLink({
    machine: "gaming-pc", name: "PC", version: "0", trust: () => t.pc, bind: "127.0.0.1", port,
    onLink: () => assert.fail("must not come online"), onRequest: async () => {}, onEvent: () => {},
  });
  const impostor = new PeerLink({
    machine: "laptop", name: "X", version: "0", trust: () => ({ ...t.lap, psk: randomBytes(32) }), port,
    onLink: () => assert.fail("must not come online"), onRequest: async () => {}, onEvent: () => {},
  });
  await pc.start();
  await impostor.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pc.online, false);
  assert.equal(impostor.online, false);
  await impostor.stop();
  await pc.stop();
});
