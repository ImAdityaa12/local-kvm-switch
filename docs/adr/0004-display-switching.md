# ADR 0004: Display switching with one USB host

Status: accepted; implemented, laptop-side hardware tests done, gaming PC tests pending
Date: 2026-10-19

## Context

One Gigabyte G24F 2 monitor serves both machines (HDMI 1 gaming PC, HDMI 2 laptop). Its USB
upstream cable stays on the gaming PC. Laptop mode and Gaming PC mode must also switch the
monitor input and the laptop's Windows display layout (spec §14). Evidence and sources:
`docs/feasibility-display-switching.md`.

## Decision

- **Monitor input: standard DDC/CI (MCCS VCP 0x60, 0x11 HDMI 1 / 0x12 HDMI 2) over the monitor's
  USB link.**
  - The VIA billboard device (`2109:8886`) bridges vendor control transfers to the monitor's DDC/CI
    bus; we use the libusb-win32 driver that OSD Sidekick installs, loading its `libusb0.dll`.
  - It works whatever input is on screen. Switching back while the other input was selected was
    verified (report §11, R2).
  - **Fallback:** DDC/CI over the gaming PC's own HDMI cable (Dxva2) when the USB device is absent.
  - Only VCP 0x60 is ever written, and only those two values.
- **Laptop layout:** `SetDisplayConfig(SDC_APPLY | SDC_TOPOLOGY_EXTEND / _INTERNAL)`, confirmed with
  `QueryDisplayConfig(QDC_DATABASE_CURRENT)`, run by the laptop agent in the signed-in session.
  `DisplaySwitch.exe` is not used (its arguments are undocumented).
- **One native helper**, `kvm-display` (`native/kvm-audio/src/bin/kvm-display.rs`):
  - One command per run, one JSON line out.
  - Built with the audio helper (`npm run build:audio`).
  - It installs no hooks and never touches keyboard or mouse input.
- **The gaming PC runs the mode state machine** (`agent/src/mode.ts`), as it already owns input
  switching and audio routes.
  - The laptop sends `mode.set` over the paired peer link.
  - The gaming PC sends `display.setTopology` to the laptop and streams `mode.status` back, so both
    dashboards show the same steps.
  - The laptop reports its layout with `display.status`.
- **Order, so that no step leaves the user without a screen:**
  - **Laptop mode:** laptop Extend → monitor HDMI 2 → input → audio on.
    - Extend comes first because in PC screen only the laptop sends no picture to HDMI 2 (verified
      in report §11, R5: the laptop keeps the monitor while it shows HDMI 1).
    - A failed display, monitor or input step stops the switch.
    - A failed input step also puts the monitor back on HDMI 1.
  - **Gaming PC mode:** input home → audio off → monitor HDMI 1 → laptop PC screen only.
    - The last step runs only if the monitor confirmed HDMI 1; otherwise the laptop stays in Extend.
- **Every step reports** done, sent-but-unconfirmed, failed or skipped (with the reason). "Done" for
  the monitor means the monitor itself reported the new input.
- **Automatic returns:** the hotkey back (Ctrl+Alt+Right) and losing the laptop both run the full
  return to Gaming PC mode.
- **Retries:** none beyond the helper's 4 s read-back; nothing toggles on its own.

## Consequences

- OSD Sidekick (for its USB driver) is a prerequisite on the gaming PC. Replacing the driver with
  WinUSB would break Sidekick, so we don't.
- The USB request format comes from community reverse engineering of Sidekick, not from Gigabyte; a
  monitor firmware change could break it. The HDMI DDC/CI fallback and the monitor's Input button
  remain as recovery.
- Rejected:
  - Sidekick UI automation (brittle).
  - Its hotkeys (no input-switch function).
  - Its private DLLs (undocumented, licence unknown).
