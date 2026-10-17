# ADR 0001: Input engine — Deskflow, process stopped in Gaming PC mode

Status: proposed (pending two-machine spike)
Date: 2026-10-17

## Context

Keyboard and mouse stay on the gaming PC. Laptop mode must forward them over the LAN. Gaming PC mode
must not intercept, relay, or inject input (spec §2.3, §9). Custom low-level input code is discouraged.

Input Leap is archived. Deskflow is maintained (v1.27.0, 2026-10-01), GPL-2.0 with OpenSSL exception.
Deskflow's server keeps `WH_KEYBOARD_LL`/`WH_MOUSE_LL` hooks installed for as long as it runs, including
while the cursor is on the server.

## Decision

- Use Deskflow as an external process supervised by the agent. Do not link or patch it, so our code is
  not a derivative work.
- **Gaming PC mode: no `deskflow-core` process on the gaming PC.** Local mode is reported only after
  the process has exited.
- Laptop mode: start `deskflow-core server -s <generated settings>`; the laptop runs
  `deskflow-core client` continuously. Moving the cursor uses a configured `switchToScreen` hotkey
  (user presses it in Phase 1; automated press is a spike).
- Confirm screen changes through `enterCommand`/`exitCommand`, not log parsing.
- TLS on, fingerprint pinning on both sides; fingerprints exchanged during our own pairing.

## Consequences

- Switching to Laptop costs a process start (expected ~1 s; to measure).
- Edge-of-screen switching only works while Laptop mode is active, which is the intent.
- Deskflow must be installed separately (or bundled later under GPL terms with source offer).
