import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIO_PLAY_PORT, AUDIO_TUNNEL_PORT, MIC_SEND_PORT, MIC_TUNNEL_PORT, PC_AUDIO_SEND_PORT, PC_AUDIO_TUNNEL_PORT } from "../src/audio/engine.ts";
import { DESKFLOW_SERVER_PORT, DESKFLOW_TUNNEL_PORT } from "../src/deskflow/config.ts";
import { DISCOVERY_PORT } from "../src/peer/discovery.ts";
import { LINK_PORT } from "../src/peer/link.ts";
import { PAIR_PORT } from "../src/peer/manager.ts";
import { FILES_SERVE_PORT, FILES_TUNNEL_PORT } from "../src/sharing/files.ts";

test("every fixed local port is used by one thing only", () => {
  const ports = {
    AUDIO_PLAY_PORT, AUDIO_TUNNEL_PORT, MIC_SEND_PORT, MIC_TUNNEL_PORT, PC_AUDIO_SEND_PORT, PC_AUDIO_TUNNEL_PORT,
    DESKFLOW_SERVER_PORT, DESKFLOW_TUNNEL_PORT, DISCOVERY_PORT, LINK_PORT, PAIR_PORT, FILES_SERVE_PORT, FILES_TUNNEL_PORT,
  };
  const owner = new Map<number, string>();
  for (const [name, port] of Object.entries(ports)) {
    assert.equal(owner.get(port), undefined, `${name} and ${owner.get(port)} both use port ${port}`);
    owner.set(port, name);
  }
});
