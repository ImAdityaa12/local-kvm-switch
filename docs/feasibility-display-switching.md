# Feasibility report: one-USB-host display switching

Status: 2026-10-19. Approved and being implemented (see §11 for the results since approval and
`docs/adr/0004-display-switching.md`). Sections 0–10 are the report as written before approval;
§11 records what has been tested since. **Nothing has run on the gaming PC yet.**

Labels: **[HW]** measured on the real hardware in this session; **[Doc]** vendor or Microsoft
documentation; **[Src]** read in community source code (reverse engineering, not vendor-backed);
**[User]** reported by you; **[Assumed]** inference, not yet tested.

## 0. Something to check first: where the monitor's USB cable is right now

The spec says the monitor's USB upstream cable goes to the gaming PC only. On the **laptop**
(DESKTOP-6I6NA8D), at 20:24 on 2026-10-19 **[HW]**:

- Windows lists the monitor's USB hub: VIA `2109:2817` (USB 2 hub) and `2109:0817` (USB 3 hub), with
  a `2109:8886` "USB 2.0 BILLBOARD" device behind it. All three first arrived at 20:00 today.
- **OSD Sidekick 1.22.0418.1 is installed and running on the laptop.** It was installed today, and
  its libusb-win32 driver is bound to the billboard device.

So either you tested Sidekick on the laptop, or the cable is on the laptop. That's not a problem for
the report: it is how the USB path below got verified on this exact monitor. The production setup
moves the same tests to the gaming PC (§9, T1).

## 1. Verified facts

| # | Fact | How |
| --- | --- | --- |
| F1 | The laptop sees the monitor over HDMI as `GBT2403`, "G24F 2", made in 2024. | [HW] WmiMonitorID / WmiMonitorConnectionParams |
| F2 | The laptop's current topology is **Extend**, with two active paths: built-in panel + HDMI. | [HW] `QueryDisplayConfig(QDC_DATABASE_CURRENT)` |
| F3 | The G24F 2 answers **DDC/CI over HDMI** on the active input. Capability string: `(prot(monitor) type(LCD)model(MStar) cmds(01 02 03 07 0C F3) vcp(10 12 87 E0 )mccs_ver(2.2)asset_eep(32)mpu(01)mswhql(1))`. | [HW] Dxva2 `CapabilitiesRequestAndCapabilitiesReply` from the laptop |
| F4 | **VCP 0x60 (input source) is readable** even though the capability string does not list it. It reads **0x12** while the monitor shows the laptop on HDMI 2, which matches the MCCS value for HDMI 2. Brightness 0x10 reads 0x1C of 0x64. | [HW] Dxva2 `GetVCPFeatureAndVCPFeatureReply` |
| F5 | The monitor's USB control device is a **VIA billboard `2109:8886`** with Sidekick's libusb-win32 driver (DriverProvider `libusb-win32`). | [HW] PnP properties |
| F6 | **DDC/CI also works over the monitor's USB link.** A standard "get VCP" message sent as a vendor control transfer (`0x40`, request 178) and read back (`0xC0`, request 162, index 111) returned standard DDC/CI replies. Brightness: `6F 6E 88 02 00 10 01 00 64 00 1C DD` (0x1C). Input: `6F 6E 88 02 00 60 00 00 FF 00 12 39` (**0x12 = HDMI 2**). Same values as over HDMI. This worked while Sidekick was running. | [HW] `scripts/hw/monitor-usb-probe.ps1` through Sidekick's `libusb0.dll` |
| F7 | OSD Sidekick on the gaming PC switched the monitor to HDMI 2. | [User] |
| F8 | OSD Sidekick has **no documented CLI, API or SDK**. Its only automation hook is user-assigned hotkeys. In the installed version (1.22.0418.1), `HotKey.xml` offers timer, counter, crosshair, brightness, volume, black equalizer, overdrive, dashboard and aim stabilizer, but **no input switch**. Its `support.xml` lists `G24F 2`. | [Doc] Sidekick guide; [HW] install folder |
| F9 | Sidekick needs the USB cable ("requires connection between PC and monitor with USB cable"). | [Doc] Gigabyte support page / Sidekick guide |
| F10 | `SetDisplayConfig(SDC_APPLY \| SDC_TOPOLOGY_EXTEND)` and `(SDC_APPLY \| SDC_TOPOLOGY_INTERNAL)`, with null path and mode arrays, are documented. They return `ERROR_ACCESS_DENIED` without access to the current desktop (for example from session 0). `QueryDisplayConfig(QDC_DATABASE_CURRENT)` returns the current topology. | [Doc] learn.microsoft.com: setdisplayconfig, querydisplayconfig |
| F11 | `DisplaySwitch.exe` arguments are **not documented**. Since 22H2, `/extend` and `/internal` reportedly open the Win+P flyout instead. | [Doc] absence on Learn; Microsoft Q&A threads |

## 2. Not yet known (only a hardware test settles these)

- **U1.** Whether "set VCP 0x60" is accepted at all. Every write is untested. 0x60 is absent from the
  capability string, which proves nothing either way: the monitor still answers 0x60 reads.
- **U2.** Whether the value for HDMI 1 is **0x11**. [Assumed] from MCCS: 0x12 has only been seen as
  the value for HDMI 2. Community tables also list a Gigabyte vendor command (`E0 2D`, 0 = HDMI1,
  1 = HDMI2) for Realtek-based models [Src]; this monitor is MStar-based, so that row may not apply.
- **U3.** Whether a USB "set 0x60" works **while the monitor shows the other input**. [Assumed] likely,
  because the USB link and hub stay up whatever is displayed (F6 is input-independent by design), but
  untested. This is the crucial case: switching back to HDMI 1 while the laptop is showing.
- **U4.** Whether HDMI DDC/CI works from the input that is **not** being shown. ddcutil's author
  reports 0x60 "works only if issued from the device whose input is selected" on some monitors [Src].
- **U5.** Whether each PC keeps the monitor in its Windows display configuration (hot-plug stays
  asserted) while the monitor shows the other input. If the laptop loses it, it cannot switch to
  Extend until the monitor is on HDMI 2.
- **U6.** How the monitor's **Input Auto Switch** setting [Doc, manual] behaves when the laptop stops
  sending a signal (PC screen only) or the gaming PC sleeps.
- **U7.** Timing: how long an input change takes, and whether a request too soon after another one
  is ignored.

## 3. How the gaming PC can control the input over USB

**Recommended primary path: DDC/CI over the monitor's USB link, from a native helper on the gaming
PC.**

- **What it is.** The VIA billboard chip bridges USB to the monitor's DDC/CI bus. Our helper sends the
  standard MCCS messages: "get VCP 0x60" (verified, F6) and "set VCP 0x60 = 0x11 / 0x12" (U1–U3).
  These are the same bytes a GPU sends over the HDMI DDC lines, so we use standard MCCS codes, not a
  private Gigabyte command set.
- **Why USB over HDMI DDC.** The USB link doesn't depend on which video input is shown or on Windows
  keeping the monitor attached (U4, U5). That makes it the only candidate that can reliably switch
  back to HDMI 1 while the laptop is on screen (requirement 4).
- **Driver.** It talks through the libusb-win32 driver that Sidekick installs for `2109:8886`, via
  `libusb0.dll`. Verified working alongside a running Sidekick (F6). Swapping the device to WinUSB
  would break Sidekick [Src], so we don't.
- **Read-back.** After a set, read 0x60 again. That's the monitor's own report of its selected input:
  better than "command sent", but still not proof that a picture is visible (§5).
- **Fallbacks:**
  - (a) **HDMI DDC/CI from the gaming PC** (Dxva2 `SetVCPFeature`, no third-party code), for the
    direction where the gaming PC's input is the one being shown. Untested (U1, U4).
  - (b) **HDMI DDC/CI from the laptop**, only for "back to HDMI 1" while the laptop is the active
    input (the direction F3/F4 show working for reads). It needs no USB on the laptop, but moves part
    of monitor control to the laptop. **Needs your approval** because §14 says the gaming PC agent
    switches the monitor.
  - (c) **The monitor's Input Auto Switch** as a passive safety net (U6).
  - (d) **The monitor's own button** (Input menu) as the always-available manual recovery.
- **Rejected:**
  - Sidekick hotkeys: no input-switch function (F8).
  - Driving Sidekick's window with clicks or screen coordinates: brittle, and the spec forbids it.
  - Calling Sidekick's private DLLs (`VIALib.dll`, `CommandLine.dll`): undocumented, licence unknown.
  - A WinUSB driver swap: breaks Sidekick and needs admin.

## 4. How the laptop asks for a switch over the LAN

Reuse the existing **paired TLS-PSK peer link** (ADR 0003). It is already authenticated, LAN-only,
size-capped and rate-limited, and already carries laptop → gaming PC requests (`input.take`,
`input.return`). Add:

- **Laptop → gaming PC:** `mode.set { mode: "laptop" | "gaming-pc" }`. Only these two values; the
  network never carries raw VCP codes.
- **Gaming PC → laptop:** `display.setTopology { topology: "extend" | "internal" }`. Answered only
  after `QueryDisplayConfig` reports the new topology.
- **The gaming PC agent owns the mode state machine**, as it already owns input switching and audio
  routes. The monitor step's acknowledgement carries `{ sent, readBack: "hdmi1" | "hdmi2" | null }`.
- **Timeouts and retries:** monitor step 5 s; topology step 10 s. At most one retry of the monitor
  command, and no automatic toggling.

## 5. Proposed sequencing (changes the order in your brief; please confirm)

**Laptop mode:**

1. Laptop → **Extend** first, and confirm via `QueryDisplayConfig`.
   - *Why not after?* In "PC screen only" the laptop sends **no signal** on HDMI 2. Selecting HDMI 2
     first would show "no signal", and Input Auto Switch might jump straight back to HDMI 1 (U6).
   - If U5 shows the laptop loses the monitor while it's on HDMI 1, the order becomes: switch to
     HDMI 2, wait for the laptop to see the monitor, then Extend.
2. Gaming PC → **HDMI 2** over USB, then read 0x60 back.
3. Input switch (existing Deskflow flow).
4. Audio routes on.
5. Each step reports `confirmed`, `sent but not confirmed`, or `failed`. A failure stops the later
   steps and leaves the earlier ones, so the gaming PC keeps local input and its screen until the
   monitor step succeeds.

**Gaming PC mode:**

1. Input back to local (Deskflow stopped, existing).
2. Audio routes off.
3. Gaming PC → **HDMI 1**, with read-back.
4. **Only if step 3 succeeded**, laptop → **PC screen only**. If it failed or is unconfirmed, the
   laptop **stays in Extend**, so the monitor still shows something. The dashboard says the monitor
   could not be switched and points to the monitor's Input button.

The laptop's built-in screen is part of **both** Extend and PC screen only, so the laptop is never
left without a screen. If the gaming PC agent is offline, the laptop dashboard says the monitor
cannot be switched remotely and changes nothing.

## 6. Native components per machine

| Machine | Component | Runs as | New? |
| --- | --- | --- | --- |
| Gaming PC | Node agent (control plane, mode state machine, peer link) | user, Startup folder | exists |
| Gaming PC | Monitor control: USB DDC/CI via libusb-win32. Proposed as a subcommand of the existing Rust helper (`native/kvm-audio`), or a small separate binary. Kept out of the input path. | user | **new** |
| Gaming PC | Deskflow server (only in Laptop mode), audio helper | user | exists |
| Laptop | Node agent | user, Startup folder (has desktop access, F10) | exists |
| Laptop | Display topology: `SetDisplayConfig` / `QueryDisplayConfig`. Rust helper subcommand. | user (not the Deskflow service, not session 0) | **new** |
| Laptop | Deskflow client via the Deskflow service; audio helper | SYSTEM / user | exists |

Monitor control never touches keyboard or mouse input and installs no hooks. In Gaming PC mode it is
idle, and nothing is intercepted or injected (spec §2.3, §9).

## 7. Dependencies, licences, permissions

- **Windows APIs** (Dxva2, `SetDisplayConfig`, `QueryDisplayConfig`): part of Windows; no admin
  needed (F10).
- **`windows` crate:** MIT/Apache-2.0, already used.
- **libusb-win32** (`libusb0.dll` + driver): installed by OSD Sidekick. We **load the installed
  copy, don't bundle it**, so Sidekick becomes a prerequisite on the gaming PC.
  - The library is LGPL and the driver GPL; check the exact versions before we would ever ship it.
  - Installing the driver without Sidekick would need admin and your consent.
- **OSD Sidekick:** proprietary, terms not found. Not a code dependency; only its driver is used.
- **Community references** for the USB request format:
  - m27q, gbmoncli: no licence.
  - m27q-kvm: MIT/Apache-2.0.
  - We reuse the protocol facts (byte layout), not their code.
- **ControlMyMonitor** (NirSoft freeware): manual diagnostics only. Its terms limit redistribution, so
  it is not bundled.

## 8. Security

- No new listener: the commands ride the existing paired, encrypted peer link.
- The gaming PC accepts only the two fixed mode values, validated and rate-limited.
- The helper only ever sends 0x60 with 0x11 or 0x12; there is no generic "send DDC bytes" path.
- Nothing is exposed beyond the LAN, and no port forwarding is needed.
- Logs record the command, the read-back and timings, never key presses.

## 9. Minimal hardware test plan

Scripts are in `scripts/hw/`:

- `monitor-probe.ps1`: read-only.
- `monitor-usb-probe.ps1`: read-only.
- `monitor-input-set.ps1`: sends one HDMI DDC/CI set. It needs an explicit `-Input`.

The USB **set** test (T6) needs a small extra script, written once you approve. **Before any write,
know your manual recovery:** the monitor's control button → Input → HDMI 1/HDMI 2.

| Test | Where | What | Records |
| --- | --- | --- | --- |
| T0 ✅ | laptop | Read-only probes (F1–F6) | done |
| T1 | gaming PC | Move the monitor's USB cable to the gaming PC (as the spec intends). Run `monitor-probe.ps1 -Usb` and `monitor-usb-probe.ps1`. Expect `2109:8886` with the libusb-win32 driver and 0x60 = 0x11 while the gaming PC is shown. | USB device, 0x60 value for HDMI 1 (U2) |
| T2 | gaming PC | `monitor-probe.ps1` (HDMI DDC/CI) while HDMI 1 is shown | caps string; does it match the laptop's? |
| T3 | both | Switch to HDMI 2 with Sidekick. On the gaming PC: does Windows still list the monitor; does HDMI DDC/CI answer; does USB `monitor-usb-probe.ps1` still read 0x60 = 0x12? On the laptop: topology still Extend? | U3 (reads), U4, U5 |
| T4 | both | Switch to HDMI 1 with the monitor button. Laptop: does it still list the G24F 2 / stay in Extend? | U5 |
| T5 | gaming PC | `monitor-input-set.ps1 -Input hdmi2` while HDMI 1 is shown (HDMI DDC/CI, active input) | U1; time to switch |
| T6 | gaming PC | **USB** set 0x60 = 0x11 while HDMI 2 is shown (the critical case), then 0x12 while HDMI 1 is shown | U1, U3; read-back; timing |
| T7 | gaming PC | `monitor-input-set.ps1 -Input hdmi1` while HDMI 2 is shown (HDMI DDC/CI, *inactive* input) | U4: decides whether fallback (a) exists |
| T8 | laptop | `monitor-input-set.ps1 -Input hdmi1` while HDMI 2 is shown | fallback (b) |
| T9 | laptop | Run `SetDisplayConfig` to Extend and to PC screen only, with `QueryDisplayConfig` before and after; time each; check the built-in screen stays on | F10 in practice |
| T10 | both | Note the Input Auto Switch setting. Laptop → PC screen only while HDMI 2 is shown: does the monitor fall back to HDMI 1 by itself? | U6 |
| T11 | both | 20 back-to-back round trips (T6 + T9), one every 10 s: count failures, worst-case time | U7, reliability |

## 10. Decisions for you

1. **USB cable:** confirm it moves to the gaming PC for good (the probes above found it on the laptop).
2. **Order:** approve "Extend before HDMI 2" (§5) instead of "HDMI 2 then Extend".
3. **Fallback (b):** may the laptop send the switch-back over its own HDMI DDC/CI if the gaming PC's
   USB path fails? (It needs no laptop USB.)
4. **Sidekick:** OK to require OSD Sidekick (for its libusb-win32 driver) on the gaming PC?
5. **Tests:** run T1–T11 next, starting with T1–T4 (read-only plus Sidekick/monitor-button switches)?

## Sources

- Gigabyte G24F 2 manual: download.gigabyte.com/FileList/Manual/GIGABYTE_G24F2_UM_English_20220322.pdf
- OSD Sidekick guides: download.gigabyte.com/FileList/Manual/GIGABYTE_G24F_OSD_SideKick-EN-0302.pdf,
  AORUS_OSD_SIDEKICK_ENG_20220613.pdf
- USB control-transfer format:
  - github.com/P403n1x87/m27q
  - github.com/thilobillerbeck/gbmoncli
  - github.com/MabezDev/m27q-kvm
  - github.com/wkhughes/gigabyte-kvm-switch
- HID variant / vendor codes (Realtek models):
  - github.com/kelvie/gbmonctl
  - github.com/ayufan-research/gigabyte-m32u-ddcctl
  - github.com/jrimmer/aorus-ctl
- 0x60 caveats: github.com/rockowitz/ddcutil/issues/421, ddcutil.com/usb/
- learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setdisplayconfig, nf-winuser-querydisplayconfig
- learn.microsoft.com/answers/questions/1036148 (DisplaySwitch on 22H2)
- nirsoft.net/utils/control_my_monitor.html

## 11. Results after approval (2026-10-19)

The `kvm-display` helper (native/kvm-audio/src/bin/kvm-display.rs) ran on the laptop, which has the
monitor's USB cable at the moment. The gaming PC was off (its agent unreachable since 16:19), so
HDMI 1 had no picture during these tests.

| # | Result | Answers |
| --- | --- | --- |
| R1 | `monitor set hdmi1` over USB, while HDMI 2 was shown: the monitor reported `0x11` 2.5 s later. | U1 (USB writes work), U2 (HDMI 1 = 0x11) |
| R2 | `monitor set hdmi2` over USB, while HDMI 1 was selected: the monitor reported `0x12` 1.2 s later. | **U3: switching works while the monitor shows the other input** |
| R3 | Repeated (R1 then R2): same results, 2.1 s for the way back. | U7 (in part) |
| R4 | Right after a switch, the monitor did not answer DDC/CI for a moment (over USB and HDMI); it answered again within 2 s. The helper keeps reading back for 4 s, so this does not affect the result. | U7 |
| R5 | With the monitor on HDMI 1, the laptop kept the G24F 2 in its layout (`topology get` = extend, 2 paths; WmiMonitorID Active = True). | U5 for the laptop: Extend-before-HDMI 2 works |
| R6 | `topology set extend` when already in Extend: confirmed by `QueryDisplayConfig` in 50 ms. | F10 in practice (partly; "internal" not run yet) |

"Reported" means the monitor's own answer to a VCP 0x60 read; it is not someone looking at the
screen. Still to test, on the gaming PC with the USB cable there: T1–T4, `topology set internal`
on the laptop (T9), Input Auto Switch (T10), and full mode round trips (T11).

