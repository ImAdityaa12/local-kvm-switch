// Placeholder until the native audio helper exists (Phase 2). Reports no
// devices and refuses to start, so the dashboard shows the truth.

import type { VirtualEndpointState } from "../../lib/protocol/index.ts";
import { EngineError, type AudioEngine } from "./engines.ts";

export class NullAudio implements AudioEngine {
  readonly kind = "none" as const;
  async listDevices() {
    return { playback: [], capture: [] };
  }
  async virtualEndpoint(): Promise<VirtualEndpointState> {
    return { present: false, isDefault: null };
  }
  async start(): Promise<never> {
    throw new EngineError({
      code: "not-supported",
      message: "Audio routing is not built yet.",
      hint: "It arrives in Phase 2. Input switching works without it.",
    });
  }
  async stop(): Promise<void> {}
  setVolume(): void {}
  setMuted(): void {}
  onLevel(): void {}
  onFault(): void {}
}
