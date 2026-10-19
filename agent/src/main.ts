// LAN KVM Switcher agent (control plane).
//
//   node agent/src/main.ts --simulate                     simulated engines, for the dashboard
//   node agent/src/main.ts --machine gaming-pc [--bind IP] real: Deskflow server + peer link
//   node agent/src/main.ts --machine laptop               real: Deskflow client + peer link
//
//   --log-db postgresql://...   also send logs to this database (saved, so pass it once per machine;
//                               DATABASE_URL in the project's .env works too)
//
// Audio is not built yet (Phase 2); real mode reports it as unavailable.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, isLanAddress, type AgentError, type Machine } from "../../lib/protocol/index.ts";
import { Controller, type Pairing } from "./controller.ts";
import { EngineError, type AudioEngine, type InputEngine, type InputReport } from "./engines.ts";
import { DESKFLOW_SERVER_PORT, DESKFLOW_TUNNEL_PORT } from "./deskflow/config.ts";
import { DeskflowClient, DeskflowServerInput, type CursorEvent, type DeskflowPaths } from "./deskflow/engines.ts";
import { preflight } from "./deskflow/preflight.ts";
import { NullAudio } from "./null-audio.ts";
import { AUDIO_PLAY_PORT, AUDIO_TUNNEL_PORT, HelperAudio, LaptopAudio, MIC_SEND_PORT, MIC_TUNNEL_PORT } from "./audio/engine.ts";
import { helperPath } from "./audio/helper.ts";
import { LINK_PORT, PeerLink, type PeerRequest } from "./peer/link.ts";
import { PairingManager } from "./peer/manager.ts";
import { TrustStore } from "./peer/trust.ts";
import { CONTROL_PATH, startControlServer } from "./server.ts";
import { Store } from "./store.ts";
import { Tray, openDashboard, trayPath, trayView } from "./tray.ts";
import { logDatabaseUrl, remoteLog, saveLogDatabaseUrl } from "./remote-log.ts";
import { dataDir, loadOrCreateToken } from "./token.ts";
import { SimAudio, SimInput, SimPairing, SimWorld } from "./sim/world.ts";

const VERSION = "0.2.0";
const DEFAULT_DESKFLOW = "C:\\Program Files\\Deskflow\\deskflow-core.exe";

const { values } = parseArgs({
  options: {
    simulate: { type: "boolean", default: false },
    machine: { type: "string", default: "gaming-pc" },
    bind: { type: "string" },
    deskflow: { type: "string", default: DEFAULT_DESKFLOW },
    "audio-helper": { type: "string" },
    port: { type: "string", default: "47820" },
    // Default: the built dashboard the agent serves itself (npm run build). Pass http://localhost:7999 for next dev.
    dashboard: { type: "string" },
    origin: { type: "string", multiple: true, default: [] },
    unpaired: { type: "boolean", default: false },
    "no-endpoint": { type: "boolean", default: false },
    "no-tray": { type: "boolean", default: false },
    "log-db": { type: "string" },
  },
});

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) die("--port must be between 1024 and 65535");
if (values.machine !== "gaming-pc" && values.machine !== "laptop") die("--machine must be gaming-pc or laptop");
const machine = values.machine as Machine;
if (values.simulate && machine !== "gaming-pc") die("Simulation only covers the gaming PC for now.");

/** First private IPv4 address, for the gaming PC's peer link. */
function privateIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

function idleRoute() {
  return { enabled: false, status: "off" as const, deviceId: null, format: null, volume: 1, muted: false, levelDb: null, retry: null };
}

const dir = dataDir();
const name = hostname();

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // no .env; that is fine
}

if (values["log-db"]) {
  try {
    saveLogDatabaseUrl(dir, values["log-db"]);
  } catch (e) {
    die((e as Error).message);
  }
}
const logDb = values.simulate ? null : logDatabaseUrl(dir);
if (logDb) remoteLog.start(logDb, { machine, host: name, version: VERSION });

process.on("uncaughtException", (e) => {
  console.error(e);
  remoteLog.write("crash", "error", `Agent crashed: ${e?.stack ?? String(e)}`);
  void remoteLog.stop().finally(() => process.exit(1));
});
const notifyToken = randomBytes(32).toString("base64url");
let cursorHandler: (e: CursorEvent) => void = () => {};

interface Built {
  store: Store;
  controller: Controller;
  dispose(): Promise<void>;
}

async function buildSimulated(): Promise<Built> {
  const world = new SimWorld();
  world.endpointPresent = !values["no-endpoint"];
  const input = new SimInput(world);
  const audio = new SimAudio(world);
  const devices = await audio.listDevices();
  const store = new Store({
    agent: { name, machine, version: VERSION, protocol: PROTOCOL_VERSION, simulated: true, engines: { input: input.kind, audio: audio.kind }, lanAddress: "192.0.2.10" },
    peer: values.unpaired
      ? { link: "unpaired", pairing: null }
      : { link: "online", name: "Laptop (simulated)", address: "192.0.2.24", lastSeenAt: Date.now(), pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false, hotkeys: input.hotkeys },
    audio: {
      laptopToPc: { ...idleRoute(), volume: 0.8, deviceId: devices.playback.find((d) => d.isDefault)?.id ?? null },
      micToLaptop: { ...idleRoute(), deviceId: devices.capture.find((d) => d.isDefault)?.id ?? null, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    events: [],
  });
  const pairing = new SimPairing(world, store, () => {
    store.update((s) => {
      s.peer = { link: "online", name: "Laptop (simulated)", address: "192.0.2.24", lastSeenAt: Date.now(), pairing: null };
    });
    store.log("info", "Paired with Laptop (simulated)");
  });
  const controller = new Controller({ store, input, audio, peer: world.peer, pairing, sim: world });
  // Stands in for the peer heartbeat a real laptop agent sends.
  const beat = setInterval(() => {
    if (store.state.peer.link === "online" && world.peerReachable) {
      store.update((s) => {
        s.peer.lastSeenAt = Date.now();
      });
    }
  }, 5_000);
  store.log("info", "Agent started in simulated mode. No real input or audio is routed.");
  return { store, controller, dispose: async () => (clearInterval(beat), audio.dispose()) };
}

/** Lets the controller hear about the link before the link exists. */
function linkEvents() {
  const listeners: ((online: boolean, error?: AgentError) => void)[] = [];
  return {
    onLink: (cb: (online: boolean, error?: AgentError) => void) => void listeners.push(cb),
    fire: (online: boolean, error?: AgentError) => listeners.forEach((l) => l(online, error)),
  };
}

function deskflowPaths(): DeskflowPaths {
  const notifyScript = resolve(fileURLToPath(new URL("../notify.mjs", import.meta.url))).replace(/\\/g, "/");
  const tokenFile = join(dir, "notify-token");
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenFile, notifyToken, { mode: 0o600 });
  return {
    exe: values.deskflow!,
    dir: join(dir, "deskflow"),
    notifyCommand: (event) => [process.execPath.replace(/\\/g, "/"), notifyScript, String(port), event, tokenFile.replace(/\\/g, "/")],
  };
}

async function buildReal(): Promise<Built> {
  const trust = new TrustStore(dir);
  const trusted = trust.load();
  const events = linkEvents();
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const helperExe = values["audio-helper"] ?? helperPath(repoRoot);
  const haveHelper = existsSync(helperExe);
  // Assigned below; the audio engine only calls it after the link exists.
  let requestPeer: (r: PeerRequest) => Promise<void> = () => Promise.reject(new EngineError({ code: "peer-unreachable", message: "No link yet" }));
  // Only the gaming PC owns audio routes; the laptop sends when asked.
  const helperAudio = machine === "gaming-pc" && haveHelper ? new HelperAudio(helperExe, { request: (r) => requestPeer(r) }) : null;
  const audio: AudioEngine = helperAudio ?? new NullAudio();
  const devices = await audio.listDevices().catch(() => ({ playback: [], capture: [] }));
  const lanAddress = machine === "gaming-pc" ? (values.bind ?? privateIPv4()) : null;
  if (machine === "gaming-pc") {
    if (!lanAddress || !isLanAddress(lanAddress)) die("No private network address found. Pass --bind with this PC's LAN address.");
  }

  const store = new Store({
    agent: { name, machine, version: VERSION, protocol: PROTOCOL_VERSION, simulated: false, engines: { input: "deskflow", audio: audio.kind }, lanAddress },
    peer: trusted ? { link: "offline", name: trusted.name, address: trusted.address ?? undefined, pairing: null } : { link: "unpaired", pairing: null },
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false },
    audio: {
      laptopToPc: { ...idleRoute(), volume: 0.8, deviceId: devices.playback.find((d) => d.isDefault)?.id ?? null },
      micToLaptop: { ...idleRoute(), deviceId: devices.capture.find((d) => d.isDefault)?.id ?? null, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    events: [],
  });
  const laptopAudio =
    machine === "laptop" && haveHelper ? new LaptopAudio(helperExe, (l, m) => store.log(l, m), (evt) => link.emit(evt)) : null;
  if (!haveHelper) store.log("warn", "The audio helper is not built, so audio routing is unavailable. Run npm run build:audio.");

  const paths = deskflowPaths();
  let input: InputEngine;
  let client: DeskflowClient | null = null;

  if (machine === "gaming-pc") {
    const server = new DeskflowServerInput(paths, { request: (r) => link.request(r) });
    cursorHandler = (e) => server.cursor(e);
    input = server;
  } else {
    // The laptop does not choose the target; it runs the client when asked and can give input back.
    let report: (r: InputReport, e?: AgentError) => void = () => {};
    client = new DeskflowClient(paths, (st, error) => {
      report({ target: st.entered ? "laptop" : "gaming-pc", engine: st.engine, hooksActive: st.engine === "running", clientConnected: st.connected }, error);
      link.emit({ op: "input.status", ...st });
    });
    const c = client;
    cursorHandler = (e) => c.cursor(e);
    input = {
      kind: "deskflow",
      onReport: (cb) => (report = cb),
      activateRemote: () => Promise.reject(new EngineError({ code: "not-supported", message: "Switch to the laptop from the gaming PC." })),
      deactivate: () => c.stop(),
    };
  }
  store.update((s) => {
    s.input.hotkeys = input.hotkeys;
  });

  const link: PeerLink = new PeerLink({
    machine,
    name,
    version: VERSION,
    trust: () => trust.load(),
    bind: lanAddress ?? undefined,
    port: LINK_PORT,
    tunnelTargets: machine === "gaming-pc" ? { deskflow: DESKFLOW_SERVER_PORT, audio: AUDIO_PLAY_PORT, mic: MIC_SEND_PORT } : undefined,
    tunnelListeners:
      machine === "laptop"
        ? [
            { name: "deskflow", localPort: DESKFLOW_TUNNEL_PORT },
            { name: "audio", localPort: AUDIO_TUNNEL_PORT },
            { name: "mic", localPort: MIC_TUNNEL_PORT },
          ]
        : undefined,
    onLink: (online, info) => {
      if (online) {
        store.update((s) => {
          if (info.name) s.peer.name = info.name;
          if (info.address) s.peer.address = info.address.replace(/^::ffff:/, "");
        });
      }
      events.fire(online, info.error);
      if (online) void laptopAudio?.announceEndpoint();
    },
    onRequest: async (req) => {
      if (machine !== "laptop") throw new EngineError({ code: "not-supported", message: "Only the laptop takes these requests." });
      if (req.op === "audio.start" || req.op === "audio.stop" || req.op === "audio.volume") {
        if (!laptopAudio) throw new EngineError({ code: "engine-missing", message: "The audio helper is not built on the laptop.", hint: "Run npm run build:audio on the laptop." });
        if (req.op === "audio.volume") return laptopAudio.setMicVolume(req.volume);
        return req.op === "audio.start" ? laptopAudio.start(req.route, req.volume) : laptopAudio.stop(req.route);
      }
      if (req.op === "input.prepare") await client!.start();
      else await client!.stop();
    },
    onHeard: () => {
      const last = store.state.peer.lastSeenAt ?? 0;
      if (Date.now() - last > 4_000) {
        store.update((s) => {
          s.peer.lastSeenAt = Date.now();
        });
      }
    },
    onEvent: (evt) => {
      if (evt.op === "input.status") {
        if (evt.engine === "error") store.log("error", "Deskflow could not start on the laptop");
        return;
      }
      if (!helperAudio) return;
      if (evt.op === "audio.endpoint") {
        const ep = { present: evt.present, name: evt.name ?? undefined, isDefault: evt.isDefault };
        helperAudio.setEndpoint(ep);
        const before = store.state.audio.micToLaptop.virtualEndpoint;
        if (JSON.stringify(before) !== JSON.stringify(ep)) {
          store.update((s) => {
            s.audio.micToLaptop.virtualEndpoint = ep;
          });
        }
        return;
      }
      helperAudio.remoteStatus(evt);
    },
  });

  const manager = new PairingManager({
    machine,
    name,
    store,
    trust,
    bind: lanAddress ?? undefined,
    onPaired: () => link.reset(),
  });
  const pairing: Pairing = {
    begin: (a) => manager.begin(a),
    confirm: (a) => manager.confirm(a),
    cancel: () => manager.cancel(),
    forget: async () => {
      await manager.forget();
      link.reset();
    },
  };

  requestPeer = (r) => link.request(r);

  const controller = new Controller({ store, input, audio, peer: events, pairing });
  try {
    await link.start();
  } catch (e) {
    die(`Could not open the peer link on port ${LINK_PORT}: ${(e as Error).message}`);
  }

  // Devices come and go (USB DACs, HDMI); keep the list current without ever
  // changing the selected device on our own.
  const refresh = setInterval(async () => {
    // The laptop re-reports its virtual microphone (VB-CABLE can be installed or removed).
    if (machine === "laptop") return void (link.online && laptopAudio?.announceEndpoint());
    if (!haveHelper) return;
    const next = await audio.listDevices().catch(() => null);
    if (next && JSON.stringify(next) !== JSON.stringify(store.state.devices)) {
      store.update((s) => {
        s.devices = next;
      });
    }
  }, 15_000);

  store.log("info", `Agent started as the ${machine === "gaming-pc" ? "gaming PC" : "laptop"}.`);
  // Say early what would make switching fail later.
  await preflight(paths.exe, [], (m) => store.log("info", m)).catch((e) => {
    if (e instanceof EngineError) store.log("warn", `${e.detail.message} ${e.detail.hint ?? ""}`.trim());
  });
  return {
    store,
    controller,
    dispose: async () => {
      clearInterval(refresh);
      await laptopAudio?.stop("laptopToPc");
      await laptopAudio?.stop("micToLaptop");
      await link.stop();
    },
  };
}

const built = values.simulate ? await buildSimulated() : await buildReal();
const { store, controller } = built;

const token = loadOrCreateToken();
const builtDashboard = fileURLToPath(new URL("../../out", import.meta.url));
const haveBuild = existsSync(join(builtDashboard, "index.html"));
const ownOrigin = `http://127.0.0.1:${port}`;
const dashboard = new URL(values.dashboard ?? (haveBuild ? ownOrigin : "http://localhost:7999")).origin;
const allowedOrigins = [...new Set([ownOrigin, `http://localhost:${port}`, dashboard, dashboard.replace("localhost", "127.0.0.1"), ...values.origin!])];

try {
  await startControlServer({
    host: "127.0.0.1",
    port,
    token,
    allowedOrigins,
    staticDir: haveBuild ? builtDashboard : undefined,
    store,
    controller,
    notify: { token: notifyToken, onEvent: (e) => cursorHandler(e) },
  });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `Port ${port} is busy. Another agent is probably running already; only one may run at a time.`
      : `Could not start the control server: ${(e as Error).message}`,
  );
  process.exit(1);
}

const link = new URL(dashboard);
link.hash = new URLSearchParams({ agent: `ws://127.0.0.1:${port}${CONTROL_PATH}`, token }).toString();
const role = values.simulate ? "simulated" : machine;
console.log(`LAN KVM agent ${VERSION} (${role}) listening on 127.0.0.1:${port}`);
if (!values.simulate && machine === "gaming-pc") console.log(`Peer link on ${store.state.agent.lanAddress}:${LINK_PORT} (pairing opens ${store.state.agent.lanAddress}:47822 on request)`);
console.log(`Open the dashboard with this link (the token stays in the URL fragment, never sent to a server):\n\n  ${link}\n`);
if (!values.simulate) console.log(`Deskflow's output from its last run is saved in ${join(dir, "deskflow")} (deskflow-server.log or deskflow-client.log).\n`);
if (!values.simulate) console.log(remoteLog.enabled ? "Logs are also sent to the log database.\n" : "Logs stay on this machine (pass --log-db once to also send them to a log database).\n");

// Warnings and errors also go to this window, so they can be copied as text,
// and every event goes to the log database when one is set.
const eventKey = (e: { at: number; message: string }) => `${e.at}|${e.message}`;
let lastEvent: string | undefined;
function echoEvents(events: typeof store.state.events): void {
  const fresh: typeof events = [];
  for (const e of events) {
    if (eventKey(e) === lastEvent) break;
    fresh.push(e);
  }
  if (events[0]) lastEvent = eventKey(events[0]);
  for (const e of fresh.reverse()) {
    remoteLog.write("agent", e.level, e.message);
    if (e.level !== "info") console.error(`[${new Date(e.at).toLocaleTimeString()}] ${e.level.toUpperCase()}: ${e.message}`);
  }
}
echoEvents(store.state.events);
store.subscribe((s) => echoEvents(s.events));

// The notification-area icon: shows who has the keyboard and mouse, and switches from its menu.
const tray = values["no-tray"]
  ? null
  : Tray.start(
      trayPath(fileURLToPath(new URL("../..", import.meta.url))),
      (action) => {
        if (action === "dashboard") {
          if (!openDashboard(link.toString())) store.log("warn", `No Chrome or Edge found. Open ${link.origin} with the link the agent printed.`);
          return;
        }
        // The controller logs any failure itself, and the icon shows the result.
        const cmd = action === "switch" ? ({ type: "input.setTarget", target: "laptop" } as const) : ({ type: "input.returnLocal" } as const);
        controller.handle(cmd).catch(() => {});
      },
      (message) => store.log("warn", message),
    );
if (tray) {
  tray.show(trayView(store.state));
  store.subscribe((s) => tray.show(trayView(s)));
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping: returning input to this PC and releasing resources…");
  await controller.shutdown().catch(() => {});
  await built.dispose().catch(() => {});
  tray?.stop();
  await remoteLog.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
