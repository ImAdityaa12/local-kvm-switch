// LAN KVM Switcher agent (control plane).
//
//   node agent/src/main.ts --simulate
//
// Only simulated engines exist so far. Real engines (Deskflow for input, a
// native WASAPI helper for audio) arrive after the feasibility spikes; see
// docs/feasibility-report.md.

import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { PROTOCOL_VERSION, type AgentState, type Machine } from "../../lib/protocol/index.ts";
import { Controller } from "./controller.ts";
import { startControlServer, CONTROL_PATH } from "./server.ts";
import { Store } from "./store.ts";
import { loadOrCreateToken } from "./token.ts";
import { SimAudio, SimInput, SimPairing, SimWorld } from "./sim/world.ts";

const VERSION = "0.1.0";

const { values } = parseArgs({
  options: {
    simulate: { type: "boolean", default: false },
    port: { type: "string", default: "47820" },
    dashboard: { type: "string", default: "http://localhost:3000" },
    origin: { type: "string", multiple: true, default: [] },
    unpaired: { type: "boolean", default: false },
    "no-endpoint": { type: "boolean", default: false },
  },
});

if (!values.simulate) {
  console.error(
    "Real input and audio engines are not implemented yet.\n" +
      "Run with --simulate to develop the dashboard. See docs/feasibility-report.md for the plan.",
  );
  process.exit(2);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("--port must be between 1024 and 65535");
  process.exit(2);
}

const machine: Machine = "gaming-pc";
const world = new SimWorld();
world.endpointPresent = !values["no-endpoint"];
const input = new SimInput(world);
const audio = new SimAudio(world);
const devices = await audio.listDevices();

const initial: AgentState = {
  agent: {
    name: hostname(),
    machine,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    simulated: true,
    engines: { input: input.kind, audio: audio.kind },
  },
  peer: values.unpaired
    ? { link: "unpaired", pairing: null }
    : { link: "online", name: "Laptop (simulated)", address: "192.0.2.24", lastSeenAt: Date.now(), pairing: null },
  input: {
    target: "gaming-pc",
    pending: null,
    engine: "stopped",
    hooksActive: false,
    clientConnected: false,
    hotkey: input.hotkey,
  },
  audio: {
    laptopToPc: {
      enabled: false,
      status: "off",
      deviceId: devices.playback.find((d) => d.isDefault)?.id ?? null,
      format: null,
      volume: 0.8,
      muted: false,
      levelDb: null,
      retry: null,
    },
    micToLaptop: {
      enabled: false,
      status: "off",
      deviceId: devices.capture.find((d) => d.isDefault)?.id ?? null,
      format: null,
      volume: 1,
      muted: false,
      levelDb: null,
      retry: null,
      virtualEndpoint: await audio.virtualEndpoint(),
    },
  },
  devices,
  events: [],
};

const store = new Store(initial);

const pairing = new SimPairing(world, () => {
  store.update((s) => {
    s.peer = { link: "online", name: "Laptop (simulated)", address: "192.0.2.24", lastSeenAt: Date.now(), pairing: null };
  });
  store.log("info", "Paired with Laptop (simulated)");
});

const controller = new Controller({ store, input, audio, peer: world.peer, pairing, sim: world });

const token = loadOrCreateToken();
const dashboard = new URL(values.dashboard).origin;
const allowedOrigins = [...new Set([dashboard, dashboard.replace("localhost", "127.0.0.1"), ...values.origin])];

try {
  await startControlServer({ host: "127.0.0.1", port, token, allowedOrigins, store, controller });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `Port ${port} is busy. Another agent is probably running already; only one may run at a time.`
      : `Could not start the control server: ${(e as Error).message}`,
  );
  process.exit(1);
}

store.log("info", "Agent started in simulated mode. No real input or audio is routed.");

// Stands in for the peer heartbeat a real laptop agent sends.
setInterval(() => {
  if (store.state.peer.link === "online" && world.peerReachable) {
    store.update((s) => {
      s.peer.lastSeenAt = Date.now();
    });
  }
}, 5_000).unref();

const link = new URL(dashboard);
link.hash = new URLSearchParams({ agent: `ws://127.0.0.1:${port}${CONTROL_PATH}`, token }).toString();
console.log(`LAN KVM agent ${VERSION} (simulated) listening on 127.0.0.1:${port}`);
console.log(`Open the dashboard with this link (the token stays in the URL fragment, never sent to a server):\n\n  ${link}\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping: releasing input and audio…");
  await controller.shutdown().catch(() => {});
  audio.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
