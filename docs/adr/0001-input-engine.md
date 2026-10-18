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
- Laptop mode: the gaming PC asks the laptop agent to start `deskflow-core client`, then starts
  `deskflow-core server -s <generated settings>`; both stop when Gaming PC is selected again. Moving the cursor uses a configured `switchToScreen` hotkey
  (user presses it in Phase 1; automated press is a spike).
- Confirm screen changes through `enterCommand`/`exitCommand`, not log parsing.
- ~~TLS on, fingerprint pinning on both sides.~~ Revised 2026-10-17: Deskflow listens on loopback
  with its TLS off, and the laptop reaches it only through a tunnel inside our PSK-authenticated peer
  link (ADR 0003). One trust mechanism instead of two, and no Deskflow port on the network.
- Hotkeys: Ctrl+Alt+Left to the laptop, Ctrl+Alt+Right back (the laptop sits to the left of the
  gaming PC; the screen edges follow the same layout). When the cursor comes back by hotkey or
  edge, the agent stops the server, so Gaming PC mode again has no Deskflow process.

## Consequences

- Switching to Laptop costs a process start (expected ~1 s; to measure).
- Edge-of-screen switching only works while Laptop mode is active, which is the intent.
- Deskflow must be installed separately (or bundled later under GPL terms with source offer).
