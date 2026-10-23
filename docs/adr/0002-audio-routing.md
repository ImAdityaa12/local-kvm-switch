# ADR 0002: Audio routing — native WASAPI helper, raw PCM, VB-CABLE as the laptop mic

Status: proposed (pending audio spike)
Date: 2026-10-17

## Context

Laptop system audio must reach the IEM on the gaming PC, and the IEM mic must appear as a selectable
microphone on the laptop. Quality matters more than latency. A user-mode app cannot create a
system-wide capture endpoint; new kernel drivers need Microsoft signing.

## Decision

- A native audio helper on each machine does all sample work (WASAPI). The Node agent only controls
  it. Preferred language: Rust with the `wasapi` crate (MIT) — **requires installing a Rust toolchain;
  awaiting approval.**
- Laptop → PC: WASAPI loopback (or process loopback excluding our own process, build 20348+), sent as
  the mix format unchanged (normally 48 kHz f32), rendered in shared mode with `RATEADJUST` drift
  correction.
- PC → laptop mic: WASAPI capture of the chosen mic at its native format, rendered on the laptop into
  the **VB-CABLE** playback endpoint. The user installs VB-CABLE themselves; we detect it, explain it,
  and never install it silently. Voicemeeter is an accepted alternative.
- Transport: UDP, sequence-numbered frames, jitter buffer, format negotiated per stream, keys derived
  from pairing (ADR 0003). Opus only as an explicit low-bandwidth option.
- Unsupported formats fail loudly with `format-unsupported`; no silent conversion.

## Phase 2 implementation (2026-10-17)

- Helper: `native/kvm-audio`, Rust with `wasapi` 0.26 (MIT) and `serde_json`. Built with the GNU
  toolchain plus WinLibs binutils on the dev machine; MSVC works too. Driven by the agent over
  stdin/stdout JSON; it only binds or connects to loopback addresses.
- **Transport changed from UDP to TCP inside the peer link's tunnel** (target `audio`). This reuses
  the TLS-PSK channel instead of adding a second crypto layer in Rust. Trade-off: on lossy Wi-Fi a
  retransmission can cause a dropout; revisit with UDP + AEAD if the hour-long test shows it matters.
- Laptop: endpoint loopback of the default playback device at its mix format, no conversion,
  event-driven, 10 ms chunks; silence is synthesised when Windows delivers nothing (loopback stalls
  on silence). The laptop renders nothing it receives, so there is no feedback path; process-exclude
  loopback is not needed yet.
- Gaming PC: jitter buffer (40 ms target, 200 ms cap), event-driven shared-mode render. If the
  stream format equals the device mix format, samples are handed over untouched; otherwise Windows'
  converter is used (`AUTOCONVERTPCM` + `SRC_DEFAULT_QUALITY`) and the dashboard says so.
- Gain: unity passes samples untouched; other values ramp over 10 ms; stop fades out over 10 ms.
- Verified on one machine: a 1 kHz −12 dBFS tone arrives at −12 dBFS, 1000 Hz, channels intact;
  real loopback capture and real device playback stream with no dropouts.
- **Not done:** clock-drift correction (`RATEADJUST`); see `docs/phase2-testing.md`, Known limits.

## Phase 3 implementation (2026-10-17)

- Gaming PC: `kvm-audio send --listen 127.0.0.1:24830 --capture <mic>` captures the chosen microphone
  at its mix format. **Mute is applied here**, so nothing audible leaves the gaming PC while muted.
- Laptop: `kvm-audio play --connect 127.0.0.1:24831 --device <CABLE Input>`; port 24831 tunnels to
  the gaming PC's tunnel target `mic`. Apps record from **CABLE Output**. Volume is applied here
  (attenuation only, ramped).
- The laptop finds VB-CABLE by device name ("CABLE Input" / "CABLE Output"), reports it to the gaming
  PC on link-up and every 15 s, and the gaming PC refuses to start the route without it.
- Guard: the laptop-audio route refuses to start if the laptop's default playback device is CABLE
  Input, since loopback would then send the mic straight back to the IEM.
- Verified on one machine (VB-CABLE installed, silent virtual source): the route streams at 48 kHz
  stereo float with no conversion and no dropouts; mute at the sender produces exact zeros.

## Default devices (2026-10-22)

- When either route starts on the laptop (Laptop mode), the laptop makes **Voicemeeter Input** (else
  another second cable) its default output and **CABLE Output** its default input, for every role.
  Without a second cable the output only changes when it is the mic's cable. The laptop's own
  (non-VB-Audio) defaults are remembered in `own-audio-devices.json` in the data folder.
- **Reset mic and speaker** (laptop tray menu, laptop dashboard, command `audio.resetDevices`) sets
  those again in Laptop mode, or while a route runs, and the laptop's own devices otherwise. When
  the output changes while sending, the sender restarts on the new output.
- `kvm-audio set-default ID…` uses the undocumented `IPolicyConfig::SetDefaultEndpoint`, the same
  interface Sound settings use; Windows has no public API for it.

## Consequences

- One reboot on the laptop for VB-CABLE. Organisations need VB-Audio licences.
- No driver of our own unless the spike shows no acceptable alternative and the user approves it.

## Revised 2026-10-23: controlled from the laptop too

The gaming PC still owns both routes. It sends its audio state (routes and device lists) to the
laptop as `audio.state`, at most every 250 ms because level meters change constantly. The laptop's
dashboard shows the same two routes, and sends its audio commands (on/off, device, volume, mute)
back as `audio.command`. The gaming PC checks each one exactly as it checks its own dashboard's
commands, then runs it (`agent/src/audio/mirror.ts`). The laptop shows a change only once the
gaming PC confirms it, and drops the mirrored state as soon as the link goes down.
