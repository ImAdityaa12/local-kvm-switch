// Builds the native audio helper (native/kvm-audio) in release mode.
//
// With the MSVC Rust toolchain nothing else is needed. With the GNU toolchain,
// the `windows` crate needs a full binutils `dlltool` (it calls `as`); this
// looks for one on PATH and then in a per-user WinLibs install
// (%LOCALAPPDATA%\Programs\winlibs\mingw64\bin).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const crate = join(root, "native", "kvm-audio");
const cargoBin = join(homedir(), ".cargo", "bin");
const winlibs = join(process.env.LOCALAPPDATA ?? "", "Programs", "winlibs", "mingw64", "bin");
const env = { ...process.env, PATH: [cargoBin, process.env.PATH].join(delimiter) };

const rustc = spawnSync("rustc", ["-vV"], { env, encoding: "utf8" });
if (rustc.status !== 0) {
  console.error("Rust is not installed. Install it from https://rustup.rs and run this again.");
  process.exit(1);
}
const gnu = /host: .*-windows-gnu/.test(rustc.stdout);
if (gnu) {
  const onPath = spawnSync("as", ["--version"], { env }).status === 0;
  if (!onPath) {
    if (!existsSync(join(winlibs, "dlltool.exe"))) {
      console.error(
        "The GNU Rust toolchain needs binutils (dlltool and as). Install WinLibs MinGW-w64 into\n" +
          `${winlibs}\nor switch to the MSVC toolchain.`,
      );
      process.exit(1);
    }
    env.PATH = [winlibs, env.PATH].join(delimiter);
  }
}

const args = process.argv.includes("--test") ? ["test", "--release"] : ["build", "--release"];
const r = spawnSync("cargo", args, { cwd: crate, env, stdio: "inherit" });
process.exit(r.status ?? 1);
