// Run by deskflow-core when the cursor enters or leaves this computer
// (Deskflow's enterCommand / exitCommand). Tells the local agent, then exits.
//
//   node notify.mjs <agent-port> <enter|leave> <token-file>

import { readFileSync } from "node:fs";

const [port, event, tokenFile] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !["enter", "leave"].includes(event) || !tokenFile) process.exit(2);

try {
  const token = readFileSync(tokenFile, "utf8").trim();
  await fetch(`http://127.0.0.1:${port}/notify`, {
    method: "POST",
    headers: { "x-lan-kvm-notify": token, "content-type": "text/plain" },
    body: event,
    signal: AbortSignal.timeout(2000),
  });
} catch {
  process.exit(1);
}
