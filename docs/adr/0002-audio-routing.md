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

## Consequences

- One reboot on the laptop for VB-CABLE. Organisations need VB-Audio licences.
- No driver of our own unless the spike shows no acceptable alternative and the user approves it.
