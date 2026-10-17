// Stands in for deskflow-core in tests. Prints the log lines the real one
// prints (Deskflow v1.27.0 source) and stays alive until killed.
//   node fake-deskflow.mjs <server|client> -s <settings> [behaviour via FAKE_DESKFLOW env]
const [mode] = process.argv.slice(2);
const behaviour = process.env.FAKE_DESKFLOW ?? "ok";
if (behaviour === "crash") setTimeout(() => process.exit(3), 100);
if (mode === "server") {
  console.log("[2026-10-17T12:00:00] INFO: started server");
  if (behaviour !== "no-client") setTimeout(() => console.log('[2026-10-17T12:00:00] DEBUG: client "laptop" has connected'), 80);
  if (behaviour === "switch") setTimeout(() => console.log('[2026-10-17T12:00:01] INFO: switch from "gaming-pc" to "laptop" at 10,10'), 160);
} else {
  setTimeout(() => console.log("[2026-10-17T12:00:00] DEBUG: connected to server"), 80);
}
setInterval(() => {}, 1000);
