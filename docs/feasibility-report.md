# Phase 0 feasibility report

Status: desk research done 2026-10-17. **No two-machine tests have been run yet.** Everything marked
"confirmed" below is confirmed from official documentation or source code, not from hands-on testing.

## 1. Repository at the start

- Next.js 16.4.2 (App Router, Turbopack, `cacheComponents: true`), React 19.3, Tailwind CSS 4, TypeScript 5.
- One commit from Create Next App. No native code, no tests.
- Toolchains on the dev machine: Node 24.16, Python 3.11. **No Rust, .NET or MSVC toolchain installed.**

## 2. Input switching

### Confirmed

| Fact | Source |
| --- | --- |
| Deskflow is GPL-2.0-only with an OpenSSL exception. Latest stable is v1.27.0 (2026-10-01); actively maintained. Windows 10 1809+ required. | github.com/deskflow/deskflow, `LICENSES/`, releases API |
| Input Leap is **archived** (read-only since 2026-07-26). Last release v3.0.3 (2025-06-13). | github.com/input-leap/input-leap |
| `deskflow-core` takes only `server`/`client`, `--new-instance`, `-s/--settings <file>`, `-h`, `-v`. Everything else comes from the INI settings file (`[core] port`, `interface`, `useHooks`, `computerName`; `[client] remoteHost`; `[security] tlsEnabled`, `checkPeerFingerprints`; `[server] externalConfig`, `externalConfigFile`). Some docs still mention `-c/--config`; the v1.27.0 source does not accept it. | `src/apps/deskflow-core/CoreArgParser.cpp`, `docs/Configuration.md`, `src/lib/common/Settings.cpp` |
| Server layout files use `section: screens / links / aliases / options`. Hotkey actions include `keystroke(key) = switchToScreen(name)` and `lockCursorToScreen(...)`; hotkeys work wherever the cursor is. | `src/lib/server/Config.cpp`, `docs/Configuration.md` |
| **There is no documented external API to switch screens.** The core IPC (`deskflow-core` local socket) accepts only `stop` and broadcasts `connectionState`, `connectedClients`, `peerFingerprint`, `unrecognisedClient`. It is internal and undocumented. | `src/lib/deskflow/ipc/CoreIpcServer.cpp` |
| `[core] enterCommand` / `exitCommand` run a command when the computer is entered / exited. | `docs/Configuration.md` |
| **While the server runs, it keeps `WH_KEYBOARD_LL` and `WH_MOUSE_LL` hooks installed, even when the cursor is on the server.** They are removed only when the server is disabled or exits. | `src/lib/platform/MSWindowsHook.cpp`, `MSWindowsDesks.cpp`, `MSWindowsComputer.cpp` |
| When the active client disconnects, the server moves the cursor back to the primary screen. Dead clients are dropped after ~9 s (3 s keep-alive, 3 misses). Keys are released (`fakeAllKeysUp`) when the cursor leaves a client normally. | `src/lib/server/Server.cpp`, `ProtocolTypes.h`, `Computer.cpp` |
| TLS is on by default. Trust is by SHA-256 fingerprint files (`tls/trusted-servers`, `tls/trusted-clients`). Default port TCP 24800. | `Settings.cpp`, `Fingerprint.cpp`, `ProtocolTypes.h` |
| The MSI installs an auto-start service (`deskflow-daemon.exe`) that can run the core elevated on secure desktops. The core can also run as a plain user process (`asInvoker`). | `deploy/windows/wix-patch.xml.in`, `MSWindowsWatchdog.cpp` |

### Consequences for this project

1. **Gaming PC mode = the Deskflow server process is not running.** Because the server keeps global
   low-level hooks for its whole lifetime, "local input" cannot be achieved by moving the cursor home;
   the process must be stopped. The agent reports `hooksActive: false` only after the process has exited.
2. **Laptop mode = start the server, wait for the laptop client, then move the cursor to the laptop.**
   The only documented ways to move it are the edge of the screen and a configured `switchToScreen`
   hotkey. A dashboard button therefore needs one of:
   - (a) press the configured hotkey for the user with `SendInput` (undocumented interaction; test it, and it fails under UIPI if the core runs elevated and the agent does not);
   - (b) ship the hotkey as the primary control and show "press Ctrl+Alt+Right" in the dashboard after the server starts (spec allows this: "ship a supported hotkey first");
   - (c) patch Deskflow's IPC (GPL-2.0 derivative work; not proposed).

   Proposed: (b) for Phase 1, spike (a).
3. **Confirming the active screen.** `exitCommand` on the server runs a small notifier (`agent/notify.mjs`) that tells the agent the cursor left the gaming PC; `enterCommand` reports the return. Confirmed in source: `src/lib/deskflow/Computer.cpp` runs both on every enter/leave, primary or secondary, so hotkey and edge switches both fire them. The command is split with `QProcess::splitCommand`.
4. **Return to Gaming PC** = stop the core (IPC `stop`, else terminate the process tree) and wait for exit. The server's own disconnect handling and the client's key release cover held keys; whether the *client* releases keys on an abrupt server exit is an open question for the spike.

### Anti-cheat

No statement from Riot about Deskflow, Input Leap, Barrier or Synergy was found. Vanguard says it
blocks "certain incompatible or vulnerable software". The design keeps the risk as small as the engine
allows: no Deskflow process (and so no hooks) while Gaming PC is selected, no hooks in the agent itself,
and no attempt to hide anything from anti-cheat. **Users should not switch to Laptop mode while a
protected game is running**; the dashboard will say so.

## 3. Laptop system audio → gaming PC

### Confirmed

- WASAPI loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`, shared mode) captures the mix of a render endpoint; event-driven loopback works from Windows 10 1703. DRM-protected streams are not captured. (learn.microsoft.com: *Loopback Recording*)
- Process loopback (`ActivateAudioInterfaceAsync` with `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`, Windows 10 build 20348+) can **exclude** the agent's own process tree, which avoids feedback if the laptop ever plays received audio. (learn.microsoft.com: *AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS*; sample *ApplicationLoopbackAudio*)
- Shared-mode `GetMixFormat` is always accepted and is usually 32-bit float at the device rate; capturing at the mix format avoids a resampling step on capture. (learn.microsoft.com: *IAudioClient::GetMixFormat*)
- On the gaming PC, render in shared mode to the chosen device. `AUDCLNT_STREAMFLAGS_RATEADJUST` + `IAudioClockAdjustment::SetSampleRate` allows small rate trims to absorb clock drift between the two machines without a separate resampler.
- **No driver is needed for this direction.**

### Format and bandwidth

48 kHz stereo raw PCM: f32 3.07 Mbit/s, 24-bit 2.30 Mbit/s, 16-bit 1.54 Mbit/s. Trivial on wired LAN
and normal 5 GHz Wi-Fi. Default: send the laptop's mix format unchanged (normally f32). Opus is an
optional, explicitly labelled low-bandwidth mode, never a silent fallback.

## 4. Gaming-PC microphone → laptop microphone

### Confirmed

- A Windows capture endpoint comes from an audio driver; the endpoint manager registers endpoints on PnP-enumerated adapters. No documented user-mode API creates a system-wide capture endpoint. (learn.microsoft.com: *Audio Endpoint Devices*.) This is concluded from the absence of such an API; no Microsoft page states it is impossible.
- New kernel drivers need Microsoft signing (attestation signing with an EV certificate, which Microsoft labels for testing, or HLK/WHCP for production). (learn.microsoft.com: *Kernel-mode code signing policy*, *Driver signing offerings*)

### Candidate endpoints

| Option | License / redistribution | Install | Verdict |
| --- | --- | --- | --- |
| **VB-CABLE** (VB-Audio) | Donationware. Bundling allowed with credit and the donation model kept visible; organisations need paid licences. A+B / C+D packs may not be bundled. | Admin installer, reboot. x86/x64/ARM64. | **Default.** User installs it themselves on first use; the agent detects it. |
| Voicemeeter Standard / Banana | Donationware, redistributable "as is" with credit. Potato not. | Admin, reboot. | Alternative for users who already run it. |
| VirtualDrivers/Virtual-Audio-Driver | MIT (with MS-PL SysVAD code) | **Requires test signing** (`bcdedit /set testsigning on`); no releases. | Not acceptable for end users today. |
| Own driver from SysVAD / ACX | MS-PL sample | EV cert + Partner Center signing | Long-term only; needs explicit approval. |
| Scream | MS-PL | Render device only; Windows 11 needs Test Mode; dormant since 2022. | Rejected. |
| Steam Streaming Microphone | No licence to redistribute; reported unreliable. | — | Rejected. |

### Proposed flow

Laptop agent receives mic PCM → renders it with WASAPI shared mode into the virtual cable's **playback**
endpoint at that endpoint's mix format → Discord records from the cable's **recording** endpoint. The
agent finds the endpoint by enumeration and reports `virtualEndpoint.present`; if missing, the dashboard
explains what to install and why, and installs nothing itself.

VB-CABLE's signing status is not documented by VB-Audio; verify with `signtool verify /pa /v` on the
installed `.sys` during the spike.

## 5. Proposed architecture

```text
Gaming PC                                         Laptop
┌───────────────────────────────┐                 ┌────────────────────────────┐
│ Dashboard (Next.js, browser)  │                 │                            │
│   ws://127.0.0.1:47820 + token│                 │                            │
├───────────────────────────────┤                 ├────────────────────────────┤
│ Agent (control plane, Node)   │◄── peer link ──►│ Agent (control plane, Node)│
│  - state, pairing, commands   │  TLS, pinned    │  - same code, laptop role  │
│  - supervises engines         │                 │                            │
├───────────────┬───────────────┤                 ├──────────────┬─────────────┤
│ deskflow-core │ audio helper  │◄── UDP PCM ────►│ deskflow-core│ audio helper│
│ server, only  │ (native, Rust │  encrypted      │ client       │ loopback    │
│ in Laptop mode│ WASAPI)       │                 │              │ capture,    │
│               │ mic capture,  │                 │              │ cable render│
│               │ playback      │                 │              │             │
└───────────────┴───────────────┘                 └──────────────┴─────────────┘
```

- **Control plane** (built now): agent with a typed protocol (`lib/protocol`), strict validation,
  loopback-only WebSocket, origin check, token, rate limit, single instance per port.
- **Input**: Deskflow, supervised as a separate process. Input code never imports audio code.
- **Audio**: a native helper per machine (Rust with `wasapi`, MIT, or C++). Needs a toolchain install, so
  it waits for approval. The Node agent never touches samples.
- **Desktop shell**: undecided (Tauri vs Electron). Not needed until tray and installer work.

## 6. Minimal test plan (two real Windows machines)

Input
1. Start agent on both. Select Laptop: laptop cursor moves, keys type on the laptop.
2. Select Gaming PC: Task Manager shows no `deskflow-core.exe`; the dashboard shows "No hooks installed".
3. While remote, hold Shift and pull the laptop's network cable: within ~10 s the dashboard returns to Gaming PC, no stuck Shift on either machine.
4. Sleep the laptop while remote, then wake: same as 3; reconnect works without restarting agents.

Audio out
5. Play a 1 kHz sine and a music file on the laptop; hear it in the IEM on the gaming PC.
6. Record the gaming PC's output with loopback for both the direct file and the routed path; compare level, channel order and spectrum (null test after alignment).
7. Pull the network: the route goes to "reconnecting", then back to "streaming" when restored, without a pop above −40 dBFS.

Microphone
8. With VB-CABLE on the laptop, start the mic route; the cable's recording endpoint shows a level in Windows Sound settings; Discord's mic test works.
9. Unplug the IEM mic on the gaming PC: route goes to error "device missing", does not switch to another mic.

## 7. Open questions

1. Can `SendInput` reliably fire Deskflow's `switchToScreen` hotkey? (spike)
2. Does the laptop client release held keys when the server exits abruptly? (spike)
3. ~~Does `exitCommand`/`enterCommand` fire for hotkey switches as well as edge switches?~~ Yes, from source (`Computer::enter`/`leave`). Still to observe on hardware.
4. Native audio language: Rust (`wasapi` crate) vs C++. Needs a toolchain install — **your call**.
5. Desktop shell: Tauri vs Electron.
6. VB-CABLE signing and silent-install switches; written bundling permission if ever bundled.
7. Wi-Fi client isolation detection: likely a UDP probe plus clear wording; design during Phase 1.

## 8. Phase 1 status (2026-10-17)

Built and tested on one machine (two agents over loopback), not yet on two machines:

- Pairing by numeric comparison, peer link over TLS 1.2 PSK (ECDHE-PSK-CHACHA20-POLY1305).
- **Deskflow tunnelled through the peer link.** Deskflow listens on `127.0.0.1:24810` with its own TLS
  off; the laptop's client connects to `127.0.0.1:24811`, which the laptop agent tunnels through a
  PSK-authenticated TLS connection. Only the paired laptop can reach Deskflow, Deskflow's port is
  never on the network, and no Deskflow certificate fingerprints need managing.
- Deskflow server/client supervision, settings generated from keys verified in v1.27.0 source,
  enter/exit notifier, switch steps shown in the dashboard, cancellable switches.

Two-machine test guide: `docs/phase1-testing.md`.

Phase 2 (laptop audio → gaming PC) is built on the same link; see ADR 0002 and
`docs/phase2-testing.md`. Rust was installed per user (GNU toolchain) with WinLibs binutils for the
`windows` crate's import libraries.

## 9. Original smallest next step

Install Deskflow v1.27.0 on both machines (GPL-2.0; installs a service by default, or use the portable
zip), then build the **Deskflow input adapter** behind the existing `InputEngine` interface:
generate the settings INI and server layout, start/stop `deskflow-core server`, wire `exitCommand`
to the notifier, and run test plan items 1–4. Everything else in the dashboard already speaks the
final protocol, so the adapter swaps in for the simulator without UI changes.
