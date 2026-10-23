// LAN KVM Switcher agent (control plane).
//
//   node agent/src/main.ts --simulate                     simulated engines, for the dashboard
//   node agent/src/main.ts --machine gaming-pc [--bind IP] real: Deskflow server + peer link (--bind pins one address; leave it out)
//   node agent/src/main.ts --machine laptop               real: Deskflow client + peer link
//
//   --log-db postgresql://...   also send logs to this database (saved, so pass it once per machine;
//                               DATABASE_URL in the project's .env works too)
//
// Audio is not built yet (Phase 2); real mode reports it as unavailable.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, isLanAddress, type AgentError, type Machine } from "../../lib/protocol/index.ts";
import { Controller, type ModeControl, type Pairing, type SharingControl } from "./controller.ts";
import { EngineError, type AudioEngine, type InputEngine } from "./engines.ts";
import { DESKFLOW_SERVER_PORT, DESKFLOW_TUNNEL_PORT } from "./deskflow/config.ts";
import { DeskflowClient, DeskflowServerInput, LaptopInput, type CursorEvent, type DeskflowPaths } from "./deskflow/engines.ts";
import { pressHotkey } from "./deskflow/hotkey.ts";
import { DisplayHelper, displayHelperPath, displayLayout } from "./display/helper.ts";
import { ModeRunner, idleMode } from "./mode.ts";
import { preflight } from "./deskflow/preflight.ts";
import { DAEMON_PIPE, daemonRequest, daemonRunning } from "./deskflow/daemon.ts";
import { NullAudio } from "./null-audio.ts";
import { AUDIO_PLAY_PORT, AUDIO_TUNNEL_PORT, HelperAudio, LaptopAudio, MIC_SEND_PORT, MIC_TUNNEL_PORT } from "./audio/engine.ts";
import { helperPath } from "./audio/helper.ts";
import { MIRROR_EVERY_MS, type AudioCommand } from "./audio/mirror.ts";
import { CLIPBOARD_TARGET, ClipboardShare, clipHelperPath } from "./sharing/clipboard.ts";
import { FILES_TARGET, FILES_SERVE_PORT, FILES_TUNNEL_PORT, FileShare, initialFilesState, pathMap } from "./sharing/files.ts";
import { lanAddresses } from "./peer/discovery.ts";
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
/** Laptop: how long after Extend a keyboard-and-mouse switch waits for the monitor to join the desktop. */
const JOIN_WINDOW_MS = 30_000;
/** At most this long, so input.prepare still answers inside the gaming PC's 10 s. Seen joining in 3–5 s. */
const JOIN_WAIT_MS = 6_000;

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
    // Default: rclone on PATH or where winget installs it (npm run setup:files).
    rclone: { type: "string" },
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

/**
 * Gaming PC: where the peer link and pairing listen. Every adapter, so a new DHCP address needs no
 * restart (only LAN peers are accepted). --bind pins one address, but only while this PC has it.
 */
function listenHost(): { host: string; stale: boolean } {
  const pinned = values.bind;
  if (!pinned) return { host: "0.0.0.0", stale: false };
  const mine = Object.values(networkInterfaces()).some((list) => list?.some((a) => a.address === pinned));
  return mine ? { host: pinned, stale: false } : { host: "0.0.0.0", stale: true };
}

function idleRoute() {
  return { enabled: false, status: "off" as const, deviceId: null, format: null, volume: 1, muted: false, levelDb: null, retry: null };
}

const dir = dataDir();
const name = hostname();

/** Settings the user changes in the dashboard or tray, kept across restarts. */
interface Settings {
  /** Gaming PC: switching at the screen edges. */
  edgeSwitch?: boolean;
  /** Share the clipboard with the other machine (on unless turned off). */
  clipboard?: boolean;
  /** Offer this machine's drives to the other machine (on unless turned off). */
  files?: boolean;
}
const settingsFile = join(dir, "settings.json");

function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(settingsFile, "utf8")) as Settings;
    return { edgeSwitch: s.edgeSwitch === true, clipboard: s.clipboard !== false, files: s.files !== false };
  } catch {
    return {};
  }
}

function saveSettings(patch: Settings): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ ...loadSettings(), ...patch }));
}

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
    input: { target: "gaming-pc", pending: null, engine: "stopped", hooksActive: false, clientConnected: false, edgeSwitch: false, hotkeys: input.hotkeys },
    audio: {
      laptopToPc: { ...idleRoute(), volume: 0.8, deviceId: devices.playback.find((d) => d.isDefault)?.id ?? null },
      micToLaptop: { ...idleRoute(), deviceId: devices.capture.find((d) => d.isDefault)?.id ?? null, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    sharing: {
      clipboard: { enabled: true, available: true, last: { at: Date.now(), direction: "received", what: "text" } },
      files: { enabled: true, missing: [], serving: ["C", "D"], remote: { offered: true, status: "mounted", letter: "L" } },
    },
    events: [],
  });
  const pairing = new SimPairing(world, store, () => {
    store.update((s) => {
      s.peer = { link: "online", name: "Laptop (simulated)", address: "192.0.2.24", lastSeenAt: Date.now(), pairing: null };
    });
    store.log("info", "Paired with Laptop (simulated)");
  });
  let mode: ModeRunner | null = null;
  const sharing: SharingControl = {
    setClipboard: async (on) =>
      store.update((s) => {
        s.sharing!.clipboard.enabled = on;
      }),
    setFiles: async (on) =>
      store.update((s) => {
        s.sharing!.files.enabled = on;
        s.sharing!.files.serving = on ? ["C", "D"] : null;
      }),
    openDrive: () => Promise.reject(new EngineError({ code: "not-supported", message: "The simulated laptop has no drive to open." })),
  };
  const controller = new Controller({ store, input, audio, peer: world.peer, pairing, sim: world, mode: () => mode, sharing });
  // No monitor to switch, and the simulated laptop's display layout always "succeeds".
  mode = new ModeRunner({
    store,
    run: (c) => controller.handle(c),
    monitor: null,
    laptop: { online: () => store.state.peer.link === "online" && world.peerReachable, setLayout: async () => {} },
  });
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
    // The laptop's client runs through the Deskflow service when it is on, so admin windows take input.
    servicePipe: machine === "laptop" && process.platform === "win32" ? DAEMON_PIPE : undefined,
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
  if (machine === "gaming-pc" && values.bind && !isLanAddress(values.bind)) die("--bind must be an IPv4 address.");
  const listen = machine === "gaming-pc" ? listenHost() : null;
  // The address to show, e.g. for pairing. It may change while the agent runs (see refresh below).
  const shownAddress = () => (listen && listen.host !== "0.0.0.0" ? listen.host : (lanAddresses()[0] ?? null));
  const lanAddress = machine === "gaming-pc" ? shownAddress() : null;

  const store = new Store({
    agent: { name, machine, version: VERSION, protocol: PROTOCOL_VERSION, simulated: false, engines: { input: "deskflow", audio: audio.kind }, lanAddress },
    peer: trusted ? { link: "offline", name: trusted.name, address: trusted.address ?? undefined, pairing: null } : { link: "unpaired", pairing: null },
    input: {
      target: "gaming-pc",
      pending: null,
      engine: "stopped",
      hooksActive: false,
      clientConnected: false,
      // The laptop learns it from the gaming PC (edge.status).
      ...(machine === "gaming-pc" ? { edgeSwitch: loadSettings().edgeSwitch === true } : {}),
    },
    audio: {
      laptopToPc: { ...idleRoute(), volume: 0.8, deviceId: devices.playback.find((d) => d.isDefault)?.id ?? null },
      micToLaptop: { ...idleRoute(), deviceId: devices.capture.find((d) => d.isDefault)?.id ?? null, virtualEndpoint: await audio.virtualEndpoint() },
    },
    devices,
    sharing: {
      clipboard: { enabled: loadSettings().clipboard !== false, available: false, last: null },
      files: initialFilesState(loadSettings().files !== false),
    },
    events: [],
  });
  // The other machine's drives as a drive letter, and this machine's for it (sharing/files.ts).
  const filesShare = new FileShare({
    machine,
    dir,
    store,
    psk: () => trust.load()?.psk ?? null,
    online: () => link.online,
    announce: (serving) => link.emit({ op: "files.status", serving }),
    saveEnabled: (on) => saveSettings({ files: on }),
    rclone: values.rclone,
  });
  // Copies cross both ways; copied files are pasted from the other machine's drive (sharing/clipboard.ts).
  const clipboard = new ClipboardShare({
    exe: clipHelperPath(repoRoot),
    enabled: () => store.state.sharing?.clipboard.enabled === true,
    online: () => link.online,
    open: (target) => link.openStream(target),
    paths: pathMap({ serving: () => store.state.sharing?.files.serving ?? null, peerServing: () => filesShare.peerDrives, mounted: () => filesShare.mountedLetter }),
    onSync: (direction, what) =>
      store.update((s) => {
        s.sharing!.clipboard.last = { at: Date.now(), direction, what };
      }),
    log: (level, message) => store.log(level, message),
    onAvailable: (available) =>
      store.update((s) => {
        s.sharing!.clipboard.available = available;
      }),
  });
  // Gaming PC: its audio routes for the laptop's dashboard, at most every MIRROR_EVERY_MS (meters
  // change constantly). Only when it can route audio at all.
  let sentAudio = "";
  let audioTimer: ReturnType<typeof setTimeout> | null = null;
  let audioAt = 0;
  const sendAudio = (force: boolean) => {
    if (!helperAudio || !link.online || audioTimer) return;
    if (!force && JSON.stringify([store.state.audio, store.state.devices]) === sentAudio) return;
    audioTimer = setTimeout(
      () => {
        audioTimer = null;
        if (!link.online) return;
        sentAudio = JSON.stringify([store.state.audio, store.state.devices]);
        audioAt = Date.now();
        link.emit({ op: "audio.state", mirror: { audio: store.state.audio, devices: store.state.devices } });
      },
      force ? 0 : Math.max(0, MIRROR_EVERY_MS - (Date.now() - audioAt)),
    );
  };
  const laptopAudio =
    machine === "laptop" && haveHelper ? new LaptopAudio(helperExe, (l, m) => store.log(l, m), (evt) => link.emit(evt), join(dir, "own-audio-devices.json")) : null;
  if (!haveHelper) store.log("warn", "The audio helper is not built, so audio routing is unavailable. Run npm run build:audio.");

  const paths = deskflowPaths();
  // Monitor input (gaming PC) and display layout (laptop): native/kvm-audio/src/bin/kvm-display.rs.
  const display = new DisplayHelper(displayHelperPath(repoRoot));
  if (!display.built) store.log("warn", "The display helper is not built, so the monitor and display layout cannot be switched. Run npm run build:audio.");
  const layout = displayLayout(display);
  // Laptop: after Extend, the displays the desktop should span and until when to wait for them (see input.prepare).
  let joining: { monitors: number; until: number } | null = null;
  store.update((s) => {
    s.mode = idleMode();
  });
  let input: InputEngine;
  let client: DeskflowClient | null = null;

  if (machine === "gaming-pc") {
    // A click presses the switch hotkey for the user (hotkey.ts); not in tests or off Windows.
    const server = new DeskflowServerInput(paths, { request: (r) => link.request(r) }, process.platform === "win32" ? { pressHotkey } : {});
    cursorHandler = (e) => server.cursor(e);
    input = server;
  } else {
    // The laptop runs the client when the gaming PC asks for it, and can itself ask the gaming PC to switch or return.
    let laptopInput: LaptopInput | null = null;
    client = new DeskflowClient(paths, (st, error) => {
      laptopInput?.clientStatus(st, error);
      link.emit({ op: "input.status", ...st });
    }, (m) => store.log("warn", m));
    const c = client;
    cursorHandler = (e) => c.cursor(e);
    input = laptopInput = new LaptopInput(c, { request: (r, timeoutMs) => link.request(r, timeoutMs) });
  }
  store.update((s) => {
    s.input.hotkeys = input.hotkeys;
  });

  const link: PeerLink = new PeerLink({
    machine,
    name,
    version: VERSION,
    trust: () => trust.load(),
    bind: listen?.host,
    port: LINK_PORT,
    // The gaming PC answers on the LAN; the laptop asks when the saved address stops answering.
    discovery: {},
    onMoved: (address) => {
      const peer = trust.load();
      if (!peer) return;
      trust.save({ ...peer, address });
      store.log("info", `Found ${peer.name} at its new address ${address} (it was ${peer.address ?? "unknown"})`);
    },
    tunnelTargets: {
      ...(machine === "gaming-pc" ? { deskflow: DESKFLOW_SERVER_PORT, audio: AUDIO_PLAY_PORT, mic: MIC_SEND_PORT } : {}),
      [FILES_TARGET]: FILES_SERVE_PORT,
      [CLIPBOARD_TARGET]: clipboard.receive,
    },
    tunnelListeners: [
      ...(machine === "laptop"
        ? [
            { name: "deskflow", localPort: DESKFLOW_TUNNEL_PORT },
            { name: "audio", localPort: AUDIO_TUNNEL_PORT },
            { name: "mic", localPort: MIC_TUNNEL_PORT },
          ]
        : []),
      { name: FILES_TARGET, localPort: FILES_TUNNEL_PORT },
    ],
    onLink: (online, info) => {
      if (online) {
        store.update((s) => {
          if (info.name) s.peer.name = info.name;
          if (info.address) s.peer.address = info.address.replace(/^::ffff:/, "");
        });
      }
      events.fire(online, info.error);
      filesShare.linkChanged(online);
      // The laptop shows the gaming PC's audio only while it can hear from it.
      if (!online && machine === "laptop" && store.state.audioFrom) {
        store.update((s) => {
          s.audio = { laptopToPc: idleRoute(), micToLaptop: { ...idleRoute(), virtualEndpoint: s.audio.micToLaptop.virtualEndpoint } };
          s.devices = { playback: [], capture: [] };
          delete s.audioFrom;
        });
      }
      if (online && machine === "gaming-pc") sendAudio(true);
      if (online) void laptopAudio?.announceEndpoint();
      // Each side tells the other what it knows: the laptop its display layout, the gaming PC the mode.
      if (online && machine === "laptop") void layout.get().then((topology) => link.emit({ op: "display.status", topology }), () => {});
      if (online && machine === "gaming-pc" && store.state.mode) link.emit({ op: "mode.status", mode: store.state.mode });
      if (online && machine === "gaming-pc") link.emit({ op: "edge.status", enabled: store.state.input.edgeSwitch === true });
    },
    onRequest: async (req) => {
      if (req.op === "audio.command") {
        // The laptop's dashboard, controlling routes this PC owns.
        if (machine !== "gaming-pc") throw new EngineError({ code: "not-supported", message: "Only the gaming PC runs the audio routes." });
        return controller.handle(req.command);
      }
      if (req.op === "mode.set") {
        if (!modeRunner) throw new EngineError({ code: "not-supported", message: "Only the gaming PC switches modes." });
        store.log("info", `${store.state.peer.name ?? "The laptop"} asked for ${req.mode === "laptop" ? "Laptop" : "Gaming PC"} mode`);
        return modeRunner.set(req.mode);
      }
      if (req.op === "display.setTopology") {
        if (machine !== "laptop") throw new EngineError({ code: "not-supported", message: "Only the laptop changes its display layout." });
        const { topology, paths } = await layout.set(req.topology);
        joining = topology === "extend" ? { monitors: paths, until: Date.now() + JOIN_WINDOW_MS } : null;
        store.update((s) => {
          if (s.mode) s.mode.laptopDisplay = topology;
        });
        link.emit({ op: "display.status", topology });
        return;
      }
      if (req.op === "input.take" || req.op === "input.return") {
        // Both machines belong to the same person, so the laptop may switch on its own.
        if (machine !== "gaming-pc") throw new EngineError({ code: "not-supported", message: "Only the gaming PC takes these requests." });
        const who = store.state.peer.name ?? "The laptop";
        store.log("info", req.op === "input.take" ? `${who} asked for the keyboard and mouse` : `${who} gave the keyboard and mouse back`);
        return controller.handle(req.op === "input.take" ? { type: "input.setTarget", target: "laptop" } : { type: "input.returnLocal" });
      }
      if (req.op === "input.setEdge") {
        if (machine !== "gaming-pc") throw new EngineError({ code: "not-supported", message: "Only the gaming PC keeps the edge-switch setting." });
        return controller.handle({ type: "input.setEdgeSwitch", enabled: req.enabled });
      }
      if (machine !== "laptop") throw new EngineError({ code: "not-supported", message: "Only the laptop takes these requests." });
      if (req.op === "audio.start" || req.op === "audio.stop" || req.op === "audio.volume") {
        if (!laptopAudio) throw new EngineError({ code: "engine-missing", message: "The audio helper is not built on the laptop.", hint: "Run npm run build:audio on the laptop." });
        if (req.op === "audio.volume") return laptopAudio.setMicVolume(req.volume);
        return req.op === "audio.start" ? laptopAudio.start(req.route, req.volume) : laptopAudio.stop(req.route);
      }
      if (req.op === "input.prepare") {
        // Deskflow reads the desktop's size once, as it starts, and can miss it growing while it
        // connects; then the cursor never reaches the monitor. After Extend, the monitor joins the
        // desktop seconds after it switches to HDMI 2, so start Deskflow once it has.
        const j = joining;
        joining = null;
        if (j && Date.now() < j.until && !(await layout.joined(j.monitors, JOIN_WAIT_MS).catch(() => true))) {
          store.log("warn", "The monitor has not joined the laptop's desktop yet; if the cursor cannot reach it, switch to Laptop mode again.");
        }
        await client!.start();
      } else await client!.stop();
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
      if (evt.op === "mode.status") {
        // The laptop shows the gaming PC's switch as it happens.
        if (machine === "laptop") {
          store.update((s) => {
            s.mode = evt.mode;
          });
        }
        return;
      }
      if (evt.op === "edge.status") {
        if (machine === "laptop" && store.state.input.edgeSwitch !== evt.enabled) {
          store.update((s) => {
            s.input.edgeSwitch = evt.enabled;
          });
        }
        return;
      }
      if (evt.op === "display.status") {
        modeRunner?.laptopDisplay(evt.topology);
        return;
      }
      if (evt.op === "input.status") {
        if (evt.engine === "error") store.log("error", "Deskflow could not start on the laptop");
        return;
      }
      if (evt.op === "files.status") return filesShare.peerServing(evt.serving);
      if (evt.op === "audio.state") {
        if (machine !== "laptop") return;
        store.update((s) => {
          s.audio = evt.mirror.audio;
          s.devices = evt.mirror.devices;
          s.audioFrom = "gaming-pc";
        });
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
    bind: listen?.host,
    address: () => store.state.agent.lanAddress,
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

  // The gaming PC runs mode switches; the laptop asks it to.
  const modeRunner =
    machine === "gaming-pc"
      ? new ModeRunner({
          store,
          run: (c) => controller.handle(c),
          monitor: display.built ? display : null,
          laptop: { online: () => link.online, setLayout: (topology) => link.request({ op: "display.setTopology", topology }, 20_000) },
        })
      : null;
  const modeControl: ModeControl = modeRunner ?? {
    set: (mode) => {
      if (!link.online) {
        return Promise.reject(
          new EngineError({ code: "peer-unreachable", message: "The gaming PC is not reachable, so the monitor cannot be switched remotely.", hint: "Check that the gaming PC agent is running and on the same network." }),
        );
      }
      // The gaming PC may wait up to a minute for the hotkey, plus the monitor and audio steps.
      return link.request({ op: "mode.set", mode }, 150_000);
    },
  };
  const resetDevices = laptopAudio
    ? () => laptopAudio.resetDevices(store.state.mode?.current === "laptop" || store.state.mode?.pending?.target === "laptop")
    : undefined;
  const edge =
    machine === "gaming-pc"
      ? { saveEdgeSwitch: (on: boolean) => saveSettings({ edgeSwitch: on }) }
      : {
          askEdgeSwitch: (on: boolean) =>
            link.online
              ? link.request({ op: "input.setEdge", enabled: on }, 20_000)
              : Promise.reject(new EngineError({ code: "peer-unreachable", message: "The gaming PC is not reachable; it keeps the edge-switch setting." })),
        };
  const sharing: SharingControl = {
    setClipboard: async (on) => {
      saveSettings({ clipboard: on });
      store.update((s) => {
        s.sharing!.clipboard.enabled = on;
      });
      store.log("info", on ? "The clipboard is shared with the other machine" : "The clipboard is no longer shared with the other machine");
    },
    setFiles: (on) => filesShare.setEnabled(on),
    openDrive: () => filesShare.openDrive(),
  };
  const remoteAudio =
    machine === "laptop"
      ? (command: AudioCommand) =>
          link.online
            ? // Starting a route waits for this laptop to start sending, and may retry.
              link.request({ op: "audio.command", command }, 30_000)
            : Promise.reject(new EngineError({ code: "peer-unreachable", message: "The gaming PC is not reachable; it runs the audio routes." }))
      : undefined;
  const controller = new Controller({ store, input, audio, peer: events, pairing, mode: () => modeControl, resetDevices, sharing, remoteAudio, ...edge });
  if (machine === "gaming-pc") {
    // The laptop's dashboard and tray show the setting.
    let sentEdge = store.state.input.edgeSwitch;
    store.subscribe((s) => {
      if (s.input.edgeSwitch !== sentEdge && link.online) {
        sentEdge = s.input.edgeSwitch;
        link.emit({ op: "edge.status", enabled: s.input.edgeSwitch === true });
      }
    });
  }
  if (machine === "gaming-pc") store.subscribe(() => sendAudio(false));
  if (modeRunner) {
    // The laptop's dashboard shows the gaming PC's mode switch as it happens.
    let sent = "";
    store.subscribe((s) => {
      const now = JSON.stringify(s.mode);
      if (now !== sent && link.online && s.mode) {
        sent = now;
        link.emit({ op: "mode.status", mode: s.mode });
      }
    });
    await modeRunner.refreshMonitor();
  }
  if (!clipboard.start()) store.log("warn", "The clipboard helper is not built, so the clipboard is not shared. Run npm.cmd run build:audio, then restart the agent.");
  await filesShare.start();
  try {
    await link.start();
  } catch (e) {
    die(`Could not open the peer link on port ${LINK_PORT}: ${(e as Error).message}`);
  }

  // Devices come and go (USB DACs, HDMI); keep the list current without ever
  // changing the selected device on our own.
  const refresh = setInterval(async () => {
    // rclone and WinFsp may have just been installed (npm run setup:files).
    filesShare.refreshTools();
    // The laptop re-reports its virtual microphone (VB-CABLE can be installed or removed).
    if (machine === "laptop") return void (link.online && laptopAudio?.announceEndpoint());
    // The monitor's input can also change from its own buttons.
    void modeRunner?.refreshMonitor().catch(() => {});
    // A new DHCP lease: the link already listens on every adapter; only the shown address changes.
    const address = shownAddress();
    if (address !== store.state.agent.lanAddress) {
      store.update((s) => {
        s.agent.lanAddress = address;
      });
      store.log("info", address ? `This PC's network address is now ${address}` : "This PC has no network address right now");
    }
    if (!haveHelper) return;
    const next = await audio.listDevices().catch(() => null);
    if (next && JSON.stringify(next) !== JSON.stringify(store.state.devices)) {
      store.update((s) => {
        s.devices = next;
      });
    }
  }, 15_000);

  store.log("info", `Agent started as the ${machine === "gaming-pc" ? "gaming PC" : "laptop"}.`);
  if (listen?.stale) {
    store.log("warn", `--bind ${values.bind} is no longer an address of this PC, so the agent listens on all its network adapters. Leave --bind out: npm.cmd run autostart -- install --machine gaming-pc`);
  }
  // A Deskflow the service still runs from before (an earlier agent, or the Deskflow app's settings) is ended.
  const viaService = paths.servicePipe !== undefined && (await daemonRunning(paths.servicePipe));
  if (viaService) await daemonRequest(paths.servicePipe!, ["stop"]).catch(() => {});
  // Say early what would make switching fail later.
  await preflight(paths.exe, [], (m) => store.log("info", m), viaService).catch((e) => {
    if (e instanceof EngineError) store.log("warn", `${e.detail.message} ${e.detail.hint ?? ""}`.trim());
  });
  return {
    store,
    controller,
    dispose: async () => {
      clearInterval(refresh);
      clipboard.stop();
      await filesShare.dispose();
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
if (!values.simulate && machine === "gaming-pc") console.log(`Peer link on port ${LINK_PORT} of every network adapter (this PC is at ${store.state.agent.lanAddress ?? "no address yet"}; pairing opens port 47822 on request)`);
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
        if (action === "edge") {
          const enabled = !store.state.input.edgeSwitch;
          controller.handle({ type: "input.setEdgeSwitch", enabled }).catch((e) => store.log("warn", `Could not turn ${enabled ? "on" : "off"} switching at the screen edges: ${e instanceof EngineError ? e.detail.message : String(e)}`));
          return;
        }
        if (action === "resetAudio") {
          controller.handle({ type: "audio.resetDevices" }).catch((e) => store.log("warn", `Could not reset the mic and speaker: ${e instanceof EngineError ? e.detail.message : String(e)}`));
          return;
        }
        // A whole mode switch: monitor, laptop display, input and audio. Failures show in the
        // dashboard's steps and the icon.
        controller.handle({ type: "mode.set", mode: action === "switch" ? "laptop" : "gaming-pc" }).catch(() => {});
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
