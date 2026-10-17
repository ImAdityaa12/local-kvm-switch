// The one paired peer, kept in the per-user data folder.
//
// TODO(security): protect the key with Windows DPAPI (CryptProtectData) once
// the native helper exists. Today it relies on the user profile's file ACLs.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "../../../lib/protocol/index.ts";

export interface TrustedPeer {
  id: string;
  psk: Buffer;
  name: string;
  machine: Machine;
  /** Where the laptop dials the gaming PC. Empty on the gaming PC side. */
  address: string | null;
  pairedAt: number;
}

export class TrustStore {
  #file: string;
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, "peer.json");
  }

  load(): TrustedPeer | null {
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8"));
      const psk = Buffer.from(String(raw.psk), "base64");
      if (typeof raw.id !== "string" || psk.length !== 32 || typeof raw.name !== "string") return null;
      if (raw.machine !== "gaming-pc" && raw.machine !== "laptop") return null;
      return {
        id: raw.id,
        psk,
        name: raw.name,
        machine: raw.machine,
        address: typeof raw.address === "string" ? raw.address : null,
        pairedAt: Number(raw.pairedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  save(peer: TrustedPeer): void {
    mkdirSync(this.#dir, { recursive: true });
    const body = { ...peer, psk: peer.psk.toString("base64") };
    writeFileSync(this.#file, JSON.stringify(body, null, 2), { mode: 0o600 });
  }

  forget(): void {
    rmSync(this.#file, { force: true });
  }
}
