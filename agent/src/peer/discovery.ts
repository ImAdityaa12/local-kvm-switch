// Finding the paired gaming PC after its address changed (a new DHCP lease).
//
// The laptop broadcasts a question on UDP DISCOVERY_PORT, and only the paired
// gaming PC answers, straight back to the laptop. Both messages carry an HMAC
// with the pairing key over a fresh nonce, so the gaming PC answers no one
// else and the laptop believes no one else. The link's PSK handshake still
// decides whether the address is really the gaming PC.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isLanAddress } from "../../../lib/protocol/index.ts";
import { makeRateLimiter } from "../rate-limit.ts";
import type { TrustedPeer } from "./trust.ts";

export const DISCOVERY_PORT = 47823;
const MAX_PACKET = 512;
const FIND_TIMEOUT_MS = 1_500;

/** Loopback, private (RFC 1918) and link-local IPv4: the only addresses the gaming PC accepts the laptop from. */
export function isLanPeer(address: string | undefined): boolean {
  const parts = (address?.replace(/^::ffff:/, "") ?? "").split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
}

/** Adapters that are not the LAN the laptop is on: Hyper-V, WSL, VPNs and the like. */
const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|Loopback|Bluetooth|Tailscale|ZeroTier|VPN/i;

/** This PC's IPv4 LAN addresses, best first: real adapters before virtual ones, 192.168 before 10 before 172. */
export function lanAddresses(): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || !isLanPeer(a.address) || a.address.startsWith("169.254.")) continue;
      const kind = a.address.startsWith("192.168.") ? 0 : a.address.startsWith("10.") ? 1 : 2;
      found.push({ address: a.address, rank: (VIRTUAL_ADAPTER.test(name) ? 10 : 0) + kind });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map((x) => x.address);
}

/** Every IPv4 broadcast address of this machine's networks, and the limited broadcast. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const mask = a.netmask.split(".").map(Number);
      out.add(a.address.split(".").map((o, i) => (Number(o) | (~mask[i] & 255)) & 255).join("."));
    }
  }
  return [...out];
}

function mac(psk: Buffer, kind: "find" | "here", nonce: string): string {
  return createHmac("sha256", psk).update(`lan-kvm ${kind} ${nonce}`).digest("base64url");
}

function sameMac(got: unknown, want: string): boolean {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse(msg: Buffer): Record<string, unknown> | null {
  if (msg.length > MAX_PACKET) return null;
  try {
    const v = JSON.parse(msg.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Gaming PC: answers the paired laptop's question, on every adapter. */
export function answerDiscovery(o: { trust: () => TrustedPeer | null; port?: number; host?: string }): Promise<dgram.Socket> {
  const sock = dgram.createSocket("udp4");
  const allow = makeRateLimiter(10, 5);
  sock.on("message", (msg, from) => {
    if (!isLanPeer(from.address) || !allow()) return;
    const q = parse(msg);
    const peer = o.trust();
    if (!q || q.t !== "lan-kvm-find" || !peer || q.id !== peer.id || typeof q.n !== "string" || q.n.length > 64) return;
    if (!sameMac(q.mac, mac(peer.psk, "find", q.n))) return;
    sock.send(JSON.stringify({ t: "lan-kvm-here", n: q.n, mac: mac(peer.psk, "here", q.n) }), from.port, from.address);
  });
  return new Promise((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(o.port ?? DISCOVERY_PORT, o.host ?? "0.0.0.0", () => {
      sock.off("error", reject);
      sock.on("error", () => {});
      resolve(sock);
    });
  });
}

/** Laptop: asks the LAN where the paired gaming PC is. Null when it did not answer in time. */
export function findGamingPc(peer: TrustedPeer, o: { port?: number; targets?: string[]; timeoutMs?: number } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const nonce = randomBytes(16).toString("base64url");
    const want = mac(peer.psk, "here", nonce);
    let done = false;
    const finish = (address: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve(address);
    };
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? FIND_TIMEOUT_MS);
    sock.on("error", () => finish(null));
    sock.on("message", (msg, from) => {
      const a = parse(msg);
      if (a?.t === "lan-kvm-here" && a.n === nonce && sameMac(a.mac, want) && isLanPeer(from.address)) finish(from.address);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const q = JSON.stringify({ t: "lan-kvm-find", id: peer.id, n: nonce, mac: mac(peer.psk, "find", nonce) });
      for (const host of o.targets ?? broadcastAddresses()) sock.send(q, o.port ?? DISCOVERY_PORT, host, () => {});
    });
  });
}

/** Laptop: the gaming PC by its computer name, for when broadcasts do not reach it (another subnet). */
export async function lookupName(name: string): Promise<string | null> {
  if (!isLanAddress(name)) return null;
  try {
    const { address } = await lookup(name, { family: 4 });
    return isLanPeer(address) ? address : null;
  } catch {
    return null;
  }
}
