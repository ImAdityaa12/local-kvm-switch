// Pairing by numeric comparison, after Bluetooth LE Secure Connections.
//
//   laptop (initiator, A)                 gaming PC (responder, B)
//   pair1 {pkA}                ───────►
//                              ◄───────   pair2 {pkB, Cb = HMAC(Nb, pkB‖pkA)}
//   pair3 {Na}                 ───────►
//                              ◄───────   pair4 {Nb}
//   check Cb
//   both show code = SHA-256(pkA‖pkB‖Na‖Nb) mod 10^6, and both users confirm.
//
// B commits to Nb before seeing Na, and A reveals Na before seeing Nb, so a
// machine in the middle cannot steer both codes to match: its chance per
// attempt is one in a million, and each attempt needs a person to confirm.
// The pre-shared key for the peer link comes from X25519 plus both nonces.

import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type { Machine } from "../../../lib/protocol/index.ts";
import type { FrameChannel } from "./frames.ts";

export const PAIRING_VERSION = 1;
const NONCE_BYTES = 16;

export interface PairResult {
  /** Stable id for this pairing; also the TLS-PSK identity. */
  id: string;
  psk: Buffer;
  peerName: string;
  peerMachine: Machine;
}

// ---- pure functions (exported for tests) ----

export function commitment(nb: Buffer, pkB: Buffer, pkA: Buffer): Buffer {
  return createHmac("sha256", nb).update("lan-kvm/commit/v1").update(pkB).update(pkA).digest();
}

export function comparisonCode(pkA: Buffer, pkB: Buffer, na: Buffer, nb: Buffer): string {
  const h = createHash("sha256").update("lan-kvm/code/v1").update(pkA).update(pkB).update(na).update(nb).digest();
  return (h.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

export function derivePsk(shared: Buffer, pkA: Buffer, pkB: Buffer, na: Buffer, nb: Buffer): { id: string; psk: Buffer } {
  const info = Buffer.concat([Buffer.from("lan-kvm/psk/v1"), pkA, pkB]);
  const psk = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([na, nb]), info, 32));
  const id = "lan-kvm-" + createHash("sha256").update(pkA).update(pkB).digest("hex").slice(0, 24);
  return { id, psk };
}

function rawPublicKey(k: KeyObject): Buffer {
  const jwk = k.export({ format: "jwk" });
  return Buffer.from(jwk.x as string, "base64url");
}

function importPublicKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

function b64(field: unknown, bytes: number): Buffer | null {
  if (typeof field !== "string" || field.length > 64) return null;
  const b = Buffer.from(field, "base64");
  return b.length === bytes ? b : null;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[^\p{L}\p{N} ._()'-]/gu, "").trim().slice(0, 64);
  return s.length > 0 ? s : null;
}

// ---- session ----

export interface SessionHandlers {
  onCode(code: string, peerName: string): void;
  onRemoteConfirm(): void;
  onDone(result: PairResult): void;
  onFail(reason: string): void;
}

/**
 * One pairing attempt over an established frame channel. The caller owns the
 * socket and the deadline; this only runs the protocol.
 */
export class PairingSession {
  readonly role: "initiator" | "responder";
  #ch: FrameChannel;
  #h: SessionHandlers;
  #local: { name: string; machine: Machine };
  #priv: KeyObject;
  #pk: Buffer;
  #nonce = randomBytes(NONCE_BYTES);
  #peerPk: Buffer | null = null;
  #peerCommit: Buffer | null = null;
  #peerNonce: Buffer | null = null;
  #peerName = "";
  #peerMachine: Machine | null = null;
  #code: string | null = null;
  #localAccept = false;
  #remoteAccept = false;
  #finished = false;

  constructor(role: "initiator" | "responder", ch: FrameChannel, local: { name: string; machine: Machine }, h: SessionHandlers) {
    this.role = role;
    this.#ch = ch;
    this.#h = h;
    this.#local = local;
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    this.#priv = privateKey;
    this.#pk = rawPublicKey(publicKey);
    ch.onMessage((m) => this.#receive(m));
  }

  start(): void {
    if (this.role === "initiator") {
      this.#ch.send({ t: "pair1", v: PAIRING_VERSION, name: this.#local.name, machine: this.#local.machine, pk: this.#pk.toString("base64") });
    }
  }

  /** The local user's answer to "do both screens show the same code?". */
  confirm(accept: boolean): void {
    if (this.#finished || this.#code === null) return;
    this.#ch.send({ t: "confirm", accept });
    if (!accept) return this.#fail("You rejected the pairing code.");
    this.#localAccept = true;
    this.#maybeDone();
  }

  cancel(reason = "Pairing cancelled."): void {
    if (this.#finished) return;
    this.#ch.send({ t: "confirm", accept: false });
    this.#fail(reason);
  }

  #receive(m: Record<string, unknown>): void {
    if (this.#finished) return;
    const expectMachine: Machine = this.role === "initiator" ? "gaming-pc" : "laptop";
    switch (m.t) {
      case "pair1": {
        if (this.role !== "responder" || this.#peerPk) return this.#fail("Unexpected pairing message.");
        const pk = b64(m.pk, 32);
        const name = cleanName(m.name);
        if (m.v !== PAIRING_VERSION) return this.#fail("The other agent runs a different pairing version.");
        if (!pk || !name || m.machine !== expectMachine) return this.#fail("The other device sent an invalid pairing request.");
        this.#peerPk = pk;
        this.#peerName = name;
        this.#peerMachine = expectMachine;
        this.#ch.send({
          t: "pair2",
          name: this.#local.name,
          machine: this.#local.machine,
          pk: this.#pk.toString("base64"),
          commit: commitment(this.#nonce, this.#pk, pk).toString("base64"),
        });
        return;
      }
      case "pair2": {
        if (this.role !== "initiator" || this.#peerPk) return this.#fail("Unexpected pairing message.");
        const pk = b64(m.pk, 32);
        const commit = b64(m.commit, 32);
        const name = cleanName(m.name);
        if (!pk || !commit || !name || m.machine !== expectMachine) return this.#fail("The other device sent an invalid pairing reply.");
        this.#peerPk = pk;
        this.#peerCommit = commit;
        this.#peerName = name;
        this.#peerMachine = expectMachine;
        this.#ch.send({ t: "pair3", nonce: this.#nonce.toString("base64") });
        return;
      }
      case "pair3": {
        if (this.role !== "responder" || !this.#peerPk || this.#peerNonce) return this.#fail("Unexpected pairing message.");
        const na = b64(m.nonce, NONCE_BYTES);
        if (!na) return this.#fail("Invalid nonce.");
        this.#peerNonce = na;
        this.#ch.send({ t: "pair4", nonce: this.#nonce.toString("base64") });
        this.#showCode();
        return;
      }
      case "pair4": {
        if (this.role !== "initiator" || !this.#peerPk || !this.#peerCommit || this.#peerNonce) return this.#fail("Unexpected pairing message.");
        const nb = b64(m.nonce, NONCE_BYTES);
        if (!nb) return this.#fail("Invalid nonce.");
        const expected = commitment(nb, this.#peerPk, this.#pk);
        if (!timingSafeEqual(expected, this.#peerCommit)) {
          return this.#fail("The other device failed the pairing check. Someone may be interfering with the network.");
        }
        this.#peerNonce = nb;
        this.#showCode();
        return;
      }
      case "confirm":
        if (this.#code === null || typeof m.accept !== "boolean") return this.#fail("Unexpected pairing message.");
        if (!m.accept) return this.#fail("The other device rejected the pairing code.");
        this.#remoteAccept = true;
        this.#h.onRemoteConfirm();
        this.#maybeDone();
        return;
      default:
        return this.#fail("Unexpected pairing message.");
    }
  }

  #ordered() {
    const a = this.role === "initiator" ? this.#pk : this.#peerPk!;
    const b = this.role === "initiator" ? this.#peerPk! : this.#pk;
    const na = this.role === "initiator" ? this.#nonce : this.#peerNonce!;
    const nb = this.role === "initiator" ? this.#peerNonce! : this.#nonce;
    return { a, b, na, nb };
  }

  #showCode(): void {
    const { a, b, na, nb } = this.#ordered();
    this.#code = comparisonCode(a, b, na, nb);
    this.#h.onCode(this.#code, this.#peerName);
  }

  #maybeDone(): void {
    if (!this.#localAccept || !this.#remoteAccept || this.#finished) return;
    this.#finished = true;
    const { a, b, na, nb } = this.#ordered();
    const shared = diffieHellman({ privateKey: this.#priv, publicKey: importPublicKey(this.#peerPk!) });
    const { id, psk } = derivePsk(shared, a, b, na, nb);
    this.#h.onDone({ id, psk, peerName: this.#peerName, peerMachine: this.#peerMachine! });
  }

  #fail(reason: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#h.onFail(reason);
  }
}
