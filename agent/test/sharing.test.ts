import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { TrustedPeer } from "../src/peer/trust.ts";
import { PeerLink } from "../src/peer/link.ts";
import { CLIPBOARD_TARGET, ClipboardShare, describe, parseWireClip } from "../src/sharing/clipboard.ts";
import { filesPassword, mountArgs, pathMap, pickLetter, serveEnv } from "../src/sharing/files.ts";

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function trustPair(): { pc: TrustedPeer; lap: TrustedPeer } {
  const psk = randomBytes(32);
  const id = "lan-kvm-test";
  return {
    pc: { id, psk, name: "Laptop", machine: "laptop", address: null, pairedAt: 0 },
    lap: { id, psk, name: "Gaming PC", machine: "gaming-pc", address: "127.0.0.1", pairedAt: 0 },
  };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a copy from the other machine keeps only known, well-formed fields", () => {
  assert.equal(parseWireClip(null), null);
  assert.equal(parseWireClip({ v: 2, text: "x" }), null, "unknown version");
  assert.equal(parseWireClip({ v: 1 }), null, "nothing in it");
  assert.deepEqual(parseWireClip({ v: 1, text: "hi", html: b64("<b>x</b>"), png: "not base64!", evil: 1 }), { v: 1, text: "hi", html: b64("<b>x</b>") });
  assert.deepEqual(
    parseWireClip({ v: 1, files: [{ owner: "sender", path: "C:\\a.txt" }, { owner: "someone", path: "C:\\b" }, { owner: "receiver", path: "" }, "C:\\c", { owner: "sender", path: "C:\\d\0" }] }),
    { v: 1, files: [{ owner: "sender", path: "C:\\a.txt" }] },
  );
  assert.equal(describe({ text: "x" }), "text");
  assert.equal(describe({ text: "x", dib: "AAAA" }), "an image");
  assert.equal(describe({ files: ["a", "b"] }), "2 files");
});

test("copied files are named for the other machine through its drive", () => {
  // The laptop: it offers C and D; the gaming PC's C and E are mounted here as G:.
  const lap = pathMap({ serving: () => ["C", "D"], peerServing: () => ["C", "E"], mounted: () => "G" });
  assert.deepEqual(lap.outgoing("C:\\Users\\me\\a.txt"), { owner: "sender", path: "C:\\Users\\me\\a.txt" });
  assert.deepEqual(lap.outgoing("d:\\x"), { owner: "sender", path: "D:\\x" });
  assert.equal(lap.outgoing("F:\\not-offered.txt"), null);
  assert.equal(lap.outgoing("\\\\server\\share\\x"), null);
  // A file on the gaming PC's drive is the gaming PC's own file over there.
  assert.deepEqual(lap.outgoing("G:\\E\\Games\\save.dat"), { owner: "receiver", path: "E:\\Games\\save.dat" });
  assert.deepEqual(lap.outgoing("G:\\C"), { owner: "receiver", path: "C:\\" });

  assert.equal(lap.incoming({ owner: "sender", path: "C:\\Users\\pc\\b.png" }), "G:\\C\\Users\\pc\\b.png");
  assert.equal(lap.incoming({ owner: "sender", path: "D:\\x" }), null, "the gaming PC does not offer D");
  assert.equal(lap.incoming({ owner: "sender", path: "C:\\a\\..\\..\\x" }), null);
  assert.equal(lap.incoming({ owner: "receiver", path: "C:\\Users\\me\\a.txt" }), "C:\\Users\\me\\a.txt");

  // Without the drive, the other machine's files cannot be pasted here.
  const unmounted = pathMap({ serving: () => null, peerServing: () => ["C"], mounted: () => null });
  assert.equal(unmounted.incoming({ owner: "sender", path: "C:\\a" }), null);
  assert.equal(unmounted.outgoing("C:\\a"), null, "this machine offers nothing");
});

test("drive letters, rclone settings and the shared password", () => {
  assert.equal(pickLetter("G", () => false), "G");
  assert.equal(pickLetter("G", (l) => l === "G" || l === "Z"), "Y");
  assert.equal(pickLetter("G", () => true), null);
  const psk = randomBytes(32);
  assert.equal(filesPassword(psk), filesPassword(Buffer.from(psk)), "both machines derive the same password");
  assert.notEqual(filesPassword(psk), filesPassword(randomBytes(32)));
  assert.equal(serveEnv(["C", "D"], "p").RCLONE_COMBINE_UPSTREAMS, "C=C:/ D=D:/");
  const args = mountArgs({ letter: "G", label: "Gaming PC", cacheDir: "c", logFile: "l" });
  assert.deepEqual(args.slice(0, 3), ["mount", ":webdav:", "G:"]);
  assert.ok(args.includes("--network-mode"));
});

test("peer link: the gaming PC opens streams on the laptop, through a handler and a tunnel", async () => {
  const port = await freePort();
  const pcLocal = await freePort();
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const t = trustPair();
  const pc = new PeerLink({
    machine: "gaming-pc", name: "PC", version: "0", trust: () => t.pc, bind: "127.0.0.1", port,
    tunnelListeners: [{ name: "echo", localPort: pcLocal }],
    onLink: () => {}, onRequest: async () => {}, onEvent: () => {},
  });
  const lap = new PeerLink({
    machine: "laptop", name: "LAP", version: "0", trust: () => t.lap, port,
    tunnelTargets: { echo: echoPort, upper: (s) => s.on("data", (d: Buffer) => s.end(d.toString().toUpperCase())) },
    onLink: () => {}, onRequest: async () => {}, onEvent: () => {},
  });
  await pc.start();
  await lap.start();
  try {
    await until(() => pc.online && lap.online);
    // A handler on the laptop, from the gaming PC.
    const s = await pc.openStream("upper");
    s.write("shout");
    const got = await new Promise<string>((resolve) => s.on("data", (d: Buffer) => resolve(d.toString())).resume());
    assert.equal(got, "SHOUT");
    // A loopback port on the laptop, through the gaming PC's local listener.
    const reply = await new Promise<string>((resolve, reject) => {
      const c = net.connect(pcLocal, "127.0.0.1", () => c.write("back the other way"));
      c.on("data", (d) => (resolve(d.toString()), c.destroy()));
      c.on("error", reject);
    });
    assert.equal(reply, "back the other way");
    // A target the laptop does not have is never answered.
    await assert.rejects(Promise.race([pc.openStream("nope"), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 1500))]));
  } finally {
    await lap.stop();
    await pc.stop();
    echo.close();
  }
});

test("clipboard: a copy on either machine is set on the other, with files named through its drive", async () => {
  const port = await freePort();
  const t = trustPair();
  const dir = mkdtempSync(join(tmpdir(), "kvm-clip-"));
  const fake = fileURLToPath(new URL("./fixtures/fake-clip.mjs", import.meta.url));
  const pcOut = join(dir, "pc.jsonl");
  const lapOut = join(dir, "lap.jsonl");
  let pcLink: PeerLink | null = null;
  let lapLink: PeerLink | null = null;
  const share = (who: "pc" | "lap", copy: object, out: string) =>
    new ClipboardShare({
      exe: process.execPath,
      args: [fake, JSON.stringify(copy), out],
      enabled: () => true,
      online: () => (who === "pc" ? pcLink : lapLink)?.online === true,
      open: (target) => (who === "pc" ? pcLink! : lapLink!).openStream(target),
      // The gaming PC offers C; the laptop offers nothing and has the gaming PC's drive on G:.
      paths: who === "pc" ? pathMap({ serving: () => ["C"], peerServing: () => null, mounted: () => null }) : pathMap({ serving: () => null, peerServing: () => ["C"], mounted: () => "G" }),
      onSync: () => {},
      log: () => {},
      onAvailable: () => {},
    });
  const pcClip = share("pc", { text: "from the PC", files: ["C:\\Users\\pc\\notes.txt", "F:\\elsewhere"] }, pcOut);
  const lapClip = share("lap", { text: "from the laptop", dib: "AAAA" }, lapOut);
  pcLink = new PeerLink({
    machine: "gaming-pc", name: "PC", version: "0", trust: () => t.pc, bind: "127.0.0.1", port,
    tunnelTargets: { [CLIPBOARD_TARGET]: pcClip.receive },
    onLink: () => {}, onRequest: async () => {}, onEvent: () => {},
  });
  lapLink = new PeerLink({
    machine: "laptop", name: "LAP", version: "0", trust: () => t.lap, port,
    tunnelTargets: { [CLIPBOARD_TARGET]: lapClip.receive },
    onLink: () => {}, onRequest: async () => {}, onEvent: () => {},
  });
  await pcLink.start();
  await lapLink.start();
  assert.ok(pcClip.start() && lapClip.start());
  try {
    await until(() => existsSync(pcOut) && existsSync(lapOut), 8000);
    const first = (f: string) => JSON.parse(readFileSync(f, "utf8").split("\n")[0]);
    assert.deepEqual(first(lapOut), { text: "from the PC", files: ["G:\\C\\Users\\pc\\notes.txt"] });
    assert.deepEqual(first(pcOut), { text: "from the laptop", dib: "AAAA" });
  } finally {
    pcClip.stop();
    lapClip.stop();
    await lapLink.stop();
    await pcLink.stop();
  }
});
