// Runs pairing over the network and records the result.
// Gaming PC: opens a short pairing window on PAIR_PORT. Laptop: dials it.

import net from "node:net";
import type { Machine } from "../../../lib/protocol/index.ts";
import type { Pairing } from "../controller.ts";
import { EngineError } from "../engines.ts";
import type { Store } from "../store.ts";
import { frameChannel } from "./frames.ts";
import { PairingSession, type PairResult } from "./pairing.ts";
import type { TrustStore } from "./trust.ts";

export const PAIR_PORT = 47822;
export const PAIRING_WINDOW_MS = 120_000;

export interface PairingManagerOptions {
  machine: Machine;
  name: string;
  store: Store;
  trust: TrustStore;
  bind?: string;
  port?: number;
  /** Called after a successful pairing has been saved. */
  onPaired(peer: { name: string; address: string | null }): void;
}

export class PairingManager implements Pairing {
  #o: PairingManagerOptions;
  #server: net.Server | null = null;
  #session: PairingSession | null = null;
  #socket: net.Socket | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #cancelling = false;

  constructor(opts: PairingManagerOptions) {
    this.#o = opts;
  }

  async begin(address?: string): Promise<void> {
    this.cancel();
    this.#o.store.update((s) => {
      s.peer.error = undefined;
    });
    const expiresAt = Date.now() + PAIRING_WINDOW_MS;
    this.#deadline = setTimeout(() => this.#end("warn", "Pairing window closed without a match."), PAIRING_WINDOW_MS);

    if (this.#o.machine === "gaming-pc") {
      await this.#openWindow();
      this.#setPairing({ stage: "listening", expiresAt, address: this.#o.bind ?? null });
      this.#o.store.log("info", "Pairing window open for two minutes");
      return;
    }

    if (!address) {
      this.cancel();
      throw new EngineError({ code: "bad-request", message: "Enter the gaming PC's address to pair." });
    }
    this.#setPairing({ stage: "connecting", expiresAt, address });
    const sock = net.connect({ host: address, port: this.#o.port ?? PAIR_PORT });
    sock.setTimeout(8_000, () => sock.destroy(new Error("timeout")));
    sock.once("connect", () => {
      sock.setTimeout(0);
      this.#run("initiator", sock, address);
    });
    sock.once("error", () => {
      if (this.#socket === sock || this.#socket === null) {
        this.#end("error", `Could not reach ${address}. Check the address, that pairing is open on the gaming PC, and that its firewall allows the agent.`);
      }
    });
    this.#socket = sock;
  }

  confirm(accept: boolean): void {
    if (!this.#session) throw new EngineError({ code: "bad-request", message: "There is no pairing code to confirm." });
    this.#session.confirm(accept);
    if (accept) {
      this.#o.store.update((s) => {
        if (s.peer.pairing?.stage === "confirm") s.peer.pairing.localConfirmed = true;
      });
    }
  }

  cancel(): void {
    this.#cancelling = true;
    this.#session?.cancel();
    this.#cancelling = false;
    this.#teardown();
    this.#o.store.update((s) => {
      s.peer.pairing = null;
    });
  }

  async forget(): Promise<void> {
    this.cancel();
    this.#o.trust.forget();
  }

  #openWindow(): Promise<void> {
    const server = net.createServer((sock) => {
      if (this.#session) {
        sock.destroy(); // one pairing at a time
        return;
      }
      this.#run("responder", sock, null);
    });
    server.maxConnections = 2;
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (e) => {
        this.#teardown();
        reject(new EngineError({ code: "internal", message: `Could not open the pairing port: ${e.message}` }));
      });
      server.listen(this.#o.port ?? PAIR_PORT, this.#o.bind ?? "127.0.0.1", () => resolve());
    });
  }

  #run(role: "initiator" | "responder", sock: net.Socket, address: string | null): void {
    this.#socket = sock;
    sock.setNoDelay(true);
    const peerAddress = address ?? sock.remoteAddress?.replace(/^::ffff:/, "") ?? null;
    const ch = frameChannel(sock, () => this.#session?.cancel("The other device sent something unexpected."));
    const session = new PairingSession(role, ch, { name: this.#o.name, machine: this.#o.machine }, {
      onCode: (code, peerName) => {
        const expiresAt = this.#o.store.state.peer.pairing?.expiresAt ?? Date.now() + PAIRING_WINDOW_MS;
        this.#setPairing({ stage: "confirm", expiresAt, code, peerName, localConfirmed: false, remoteConfirmed: false });
      },
      onRemoteConfirm: () => {
        this.#o.store.update((s) => {
          if (s.peer.pairing?.stage === "confirm") s.peer.pairing.remoteConfirmed = true;
        });
      },
      onDone: (r: PairResult) => {
        this.#o.trust.save({
          id: r.id,
          psk: r.psk,
          name: r.peerName,
          machine: r.peerMachine,
          address: role === "initiator" ? address : null,
          pairedAt: Date.now(),
        });
        this.#teardown();
        this.#o.store.update((s) => {
          s.peer = { link: "connecting", name: r.peerName, address: peerAddress ?? undefined, pairing: null };
        });
        this.#o.store.log("info", `Paired with ${r.peerName}`);
        this.#o.onPaired({ name: r.peerName, address: role === "initiator" ? address : null });
      },
      onFail: (reason) => {
        if (this.#cancelling) return;
        if (role === "responder" && this.#server) {
          // Keep the window open for another attempt.
          this.#session = null;
          sock.destroy();
          this.#o.store.log("warn", `Pairing attempt failed: ${reason}`);
          const expiresAt = this.#o.store.state.peer.pairing?.expiresAt ?? Date.now();
          this.#setPairing({ stage: "listening", expiresAt, address: this.#o.bind ?? null });
          return;
        }
        this.#end("warn", `Pairing failed: ${reason}`);
      },
    });
    this.#session = session;
    sock.on("close", () => {
      if (this.#session === session) session.cancel("The other device disconnected.");
    });
    sock.on("error", () => {});
    session.start();
  }

  #setPairing(p: NonNullable<Store["state"]["peer"]["pairing"]>): void {
    this.#o.store.update((s) => {
      s.peer.pairing = p;
    });
  }

  #end(level: "warn" | "error", message: string): void {
    this.#teardown();
    this.#o.store.update((s) => {
      s.peer.pairing = null;
      s.peer.error = { code: "peer-unreachable", message };
    });
    this.#o.store.log(level, message);
  }

  #teardown(): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = null;
    this.#session = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#server?.close();
    this.#server = null;
  }
}
