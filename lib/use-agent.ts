"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROTOCOL_VERSION,
  type AgentError,
  type AgentState,
  type Command,
  type ServerMessage,
} from "@/lib/protocol";

const STORAGE_KEY = "lan-kvm.agent";
const DEFAULT_AGENT_URL = "ws://127.0.0.1:47820/control";
const ACK_TIMEOUT_MS = 20_000;
// A switch to the laptop is answered only once the cursor is there, and the
// agent waits up to 60 s for the hotkey (DeskflowServerInput.switchTimeoutMs).
const SWITCH_ACK_TIMEOUT_MS = 75_000;

export type ConnectionStatus =
  | "starting"
  | "no-credentials"
  | "connecting"
  | "connected"
  | "unauthorized"
  | "offline";

interface Credentials {
  url: string;
  token: string;
}

type Ack = { ok: true } | { ok: false; error: AgentError };

/** Reads credentials from the URL fragment once, then keeps them for this browser tab only. */
function readCredentials(): Credentials | null {
  try {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get("token");
    if (token) {
      const url = hash.get("agent") ?? DEFAULT_AGENT_URL;
      const parsed = new URL(url);
      if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return null;
      const creds = { url, token };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return creds;
    }
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Credentials) : null;
  } catch {
    return null;
  }
}

export function useAgent() {
  const [status, setStatus] = useState<ConnectionStatus>("starting");
  const [state, setState] = useState<AgentState | null>(null);
  const [lastError, setLastError] = useState<AgentError | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (a: Ack) => void>());
  const seqRef = useRef(-1);

  useEffect(() => {
    const creds = readCredentials();
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const failAllPending = () => {
      for (const resolve of pending.current.values()) {
        resolve({ ok: false, error: { code: "internal", message: "Lost connection to the agent before it answered." } });
      }
      pending.current.clear();
    };

    const connect = () => {
      if (disposed) return;
      if (!creds) {
        setStatus("no-credentials");
        return;
      }
      setStatus("connecting");
      const ws = new WebSocket(creds.url);
      wsRef.current = ws;
      let rejected = false;

      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: creds.token, protocol: PROTOCOL_VERSION }));
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "welcome":
            attempt = 0;
            setStatus("connected");
            setLastError(null);
            break;
          case "state":
            if (msg.seq < seqRef.current) break;
            seqRef.current = msg.seq;
            setState(msg.state);
            break;
          case "ack": {
            const resolve = pending.current.get(msg.id);
            pending.current.delete(msg.id);
            resolve?.(msg.ok ? { ok: true } : { ok: false, error: msg.error });
            break;
          }
          case "goodbye":
            if (msg.reason === "unauthorized" || msg.reason.startsWith("protocol")) rejected = true;
            break;
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        seqRef.current = -1;
        failAllPending();
        if (disposed) return;
        if (rejected) {
          sessionStorage.removeItem(STORAGE_KEY);
          setStatus("unauthorized");
          setState(null);
          return;
        }
        setStatus("offline");
        setState(null);
        const delay = Math.min(10_000, 500 * 2 ** attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    // Deferred so the first paint is never blocked on the socket.
    const start = setTimeout(connect, 0);
    return () => {
      disposed = true;
      clearTimeout(start);
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback(async (command: Command): Promise<Ack> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const error: AgentError = { code: "internal", message: "The agent is not connected." };
      setLastError(error);
      return { ok: false, error };
    }
    const id = crypto.randomUUID();
    const ack = await new Promise<Ack>((resolve) => {
      pending.current.set(id, resolve);
      ws.send(JSON.stringify({ type: "command", id, command }));
      setTimeout(() => {
        if (pending.current.delete(id)) {
          resolve({ ok: false, error: { code: "engine-timeout", message: "The agent did not answer in time." } });
        }
      }, command.type === "input.setTarget" ? SWITCH_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS);
    });
    setLastError(ack.ok ? null : ack.error);
    return ack;
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  return { status, state, send, lastError, clearError };
}
