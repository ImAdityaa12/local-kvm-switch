// Installs what file sharing needs, once per machine, with winget:
//   rclone  serves this machine's drives and mounts the other machine's (a single program).
//   WinFsp  lets rclone add a drive letter (a file-system driver; Windows asks for permission).
// The running agent notices both within 15 s; no restart needed.
//
//   node scripts/setup-files.mjs

import { spawnSync } from "node:child_process";

const packages = [
  { id: "Rclone.Rclone", name: "rclone" },
  { id: "WinFsp.WinFsp", name: "WinFsp" },
];

if (spawnSync("winget", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("winget is not available. Install App Installer from the Microsoft Store, or install rclone (rclone.org) and WinFsp (winfsp.dev) by hand.");
  process.exit(1);
}

let failed = false;
for (const p of packages) {
  const listed = spawnSync("winget", ["list", "--id", p.id, "-e", "--accept-source-agreements"], { encoding: "utf8" });
  if (listed.status === 0 && listed.stdout.includes(p.id)) {
    console.log(`${p.name} is already installed.`);
    continue;
  }
  console.log(`Installing ${p.name}...`);
  const r = spawnSync("winget", ["install", "--id", p.id, "-e", "--accept-source-agreements", "--accept-package-agreements"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`Installing ${p.name} failed (winget exit code ${r.status}).`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("\nDone. Within 15 s the dashboard shows the other machine's drives, once it has rclone too and offers its drives.");
