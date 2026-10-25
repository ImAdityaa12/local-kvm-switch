// Strict validation for messages a client sends to an agent.
// Unknown fields are rejected so a typo cannot silently become a no-op.

import { MAX_CLIENT_MESSAGE_BYTES, type ClientMessage, type Command, type Machine, type RouteId } from "./types.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ROUTES: readonly RouteId[] = ["laptopToPc", "pcToLaptop", "micToLaptop"];
const MACHINES: readonly Machine[] = ["gaming-pc", "laptop"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason };
}

/** IPv4 dotted quad or a plain host name; no ports, schemes or paths. */
export function isLanAddress(v: string): boolean {
  if (v.length === 0 || v.length > 253) return false;
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const host = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  return ipv4.test(v) || host.test(v);
}

export function parseCommand(raw: unknown): Parsed<Command> {
  if (!isObject(raw) || typeof raw.type !== "string") return fail("command must be an object with a type");
  const c = raw;
  switch (c.type) {
    case "mode.set":
      if (!onlyKeys(c, ["type", "mode"])) return fail("unexpected field");
      if (!MACHINES.includes(c.mode as Machine)) return fail("mode must be gaming-pc or laptop");
      return { ok: true, value: { type: c.type, mode: c.mode as Machine } };
    case "input.setTarget":
      if (!onlyKeys(c, ["type", "target"])) return fail("unexpected field");
      if (!MACHINES.includes(c.target as Machine)) return fail("target must be gaming-pc or laptop");
      return { ok: true, value: { type: c.type, target: c.target as Machine } };
    case "pairing.begin":
      if (!onlyKeys(c, ["type", "address"])) return fail("unexpected field");
      if (c.address === undefined) return { ok: true, value: { type: c.type } };
      if (typeof c.address !== "string" || !isLanAddress(c.address)) return fail("address must be an IPv4 address or host name");
      return { ok: true, value: { type: c.type, address: c.address } };
    case "input.setEdgeSwitch":
    case "sharing.setClipboard":
    case "sharing.setFiles":
      if (!onlyKeys(c, ["type", "enabled"]) || typeof c.enabled !== "boolean") return fail("enabled must be a boolean");
      return { ok: true, value: { type: c.type, enabled: c.enabled } };
    case "pairing.confirm":
      if (!onlyKeys(c, ["type", "accept"]) || typeof c.accept !== "boolean") return fail("accept must be a boolean");
      return { ok: true, value: { type: c.type, accept: c.accept } };
    case "input.returnLocal":
    case "audio.resetDevices":
    case "files.open":
    case "pairing.cancel":
    case "peer.forget":
      if (!onlyKeys(c, ["type"])) return fail("unexpected field");
      return { ok: true, value: { type: c.type } };
    case "audio.setEnabled":
    case "audio.setMuted": {
      const field = c.type === "audio.setEnabled" ? "enabled" : "muted";
      if (!onlyKeys(c, ["type", "route", field])) return fail("unexpected field");
      if (!ROUTES.includes(c.route as RouteId)) return fail("unknown route");
      if (typeof c[field] !== "boolean") return fail(`${field} must be a boolean`);
      return c.type === "audio.setEnabled"
        ? { ok: true, value: { type: c.type, route: c.route as RouteId, enabled: c.enabled as boolean } }
        : { ok: true, value: { type: c.type, route: c.route as RouteId, muted: c.muted as boolean } };
    }
    case "audio.setDevice":
      if (!onlyKeys(c, ["type", "route", "deviceId"])) return fail("unexpected field");
      if (!ROUTES.includes(c.route as RouteId)) return fail("unknown route");
      if (typeof c.deviceId !== "string" || c.deviceId.length === 0 || c.deviceId.length > 512) {
        return fail("deviceId must be a non-empty string");
      }
      return { ok: true, value: { type: c.type, route: c.route as RouteId, deviceId: c.deviceId } };
    case "audio.setVolume":
      if (!onlyKeys(c, ["type", "route", "volume"])) return fail("unexpected field");
      if (!ROUTES.includes(c.route as RouteId)) return fail("unknown route");
      if (typeof c.volume !== "number" || !Number.isFinite(c.volume) || c.volume < 0 || c.volume > 1) {
        return fail("volume must be between 0 and 1");
      }
      return { ok: true, value: { type: c.type, route: c.route as RouteId, volume: c.volume } };
    case "sim.setPeerReachable":
      if (!onlyKeys(c, ["type", "reachable"]) || typeof c.reachable !== "boolean") return fail("reachable must be a boolean");
      return { ok: true, value: { type: c.type, reachable: c.reachable } };
    case "sim.setEndpointPresent":
      if (!onlyKeys(c, ["type", "present"]) || typeof c.present !== "boolean") return fail("present must be a boolean");
      return { ok: true, value: { type: c.type, present: c.present } };
    default:
      return fail(`unknown command ${String(c.type).slice(0, 40)}`);
  }
}

export function parseClientMessage(text: string): Parsed<ClientMessage> {
  if (new TextEncoder().encode(text).length > MAX_CLIENT_MESSAGE_BYTES) return fail("message too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  if (!isObject(raw)) return fail("message must be an object");
  if (raw.type === "hello") {
    if (!onlyKeys(raw, ["type", "token", "protocol"])) return fail("unexpected field");
    if (typeof raw.token !== "string" || raw.token.length > 256) return fail("bad token");
    if (typeof raw.protocol !== "number") return fail("bad protocol");
    return { ok: true, value: { type: "hello", token: raw.token, protocol: raw.protocol } };
  }
  if (raw.type === "command") {
    if (!onlyKeys(raw, ["type", "id", "command"])) return fail("unexpected field");
    if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 64) return fail("bad id");
    const cmd = parseCommand(raw.command);
    if (!cmd.ok) return cmd;
    return { ok: true, value: { type: "command", id: raw.id, command: cmd.value } };
  }
  return fail("unknown message type");
}
