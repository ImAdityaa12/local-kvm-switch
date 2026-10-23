// Stands in for kvm-clip.exe in tests: says it is ready, keeps reporting one copy (argv[2], JSON,
// or "-" for none) until it is stopped, and appends what it is asked to set to a file (argv[3]).

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [copy, out] = process.argv.slice(2);
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
send({ event: "ready" });
if (copy && copy !== "-") setInterval(() => send({ event: "copied", content: JSON.parse(copy) }), 250);
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const m = JSON.parse(line);
    if (!m.set) return;
    if (out && out !== "-") appendFileSync(out, JSON.stringify(m.set) + "\n");
    send({ event: "set", ok: true });
  })
  .on("close", () => process.exit(0));
