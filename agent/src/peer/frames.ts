// Newline-delimited JSON over a stream, with a hard cap per line so a peer
// cannot make us buffer without bound.

import type { Duplex } from "node:stream";

export const MAX_FRAME_BYTES = 64 * 1024;

export class FrameError extends Error {}

export interface FrameChannel {
  send(msg: object): void;
  onMessage(cb: (msg: Record<string, unknown>) => void): void;
  /** Stop parsing frames and hand the socket over (used to switch to a raw tunnel). */
  detach(): Buffer;
  close(): void;
}

export function frameChannel(sock: Duplex, onError: (e: Error) => void): FrameChannel {
  let buf = Buffer.alloc(0);
  let cb: (msg: Record<string, unknown>) => void = () => {};
  let detached = false;

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    let nl: number;
    while (!detached && (nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (line.length === 0) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        onError(new FrameError("peer sent invalid JSON"));
        return;
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
        onError(new FrameError("peer sent a non-object frame"));
        return;
      }
      cb(msg as Record<string, unknown>);
    }
    if (!detached && buf.length > MAX_FRAME_BYTES) onError(new FrameError("peer frame too large"));
  };
  sock.on("data", onData);

  return {
    send(msg) {
      if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
    },
    onMessage(fn) {
      cb = fn;
    },
    detach() {
      detached = true;
      sock.off("data", onData);
      // Hold further bytes until the new owner pipes the socket.
      sock.pause();
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
    close() {
      sock.end();
    },
  };
}
