# ADR 0003: Control plane and security

Status: accepted for the local control channel; peer link proposed
Date: 2026-10-17

## Local control (dashboard ↔ agent) — implemented

- WebSocket on `127.0.0.1:47820/control` only. Never bound to a LAN interface.
- Upgrade refused unless `Origin` is the dashboard origin (blocks other websites in the same browser).
- First message must be `hello` with a 256-bit random token, compared in constant time. The token lives
  in `%LOCALAPPDATA%\LanKvmSwitcher\control-token`, never in the repo. The agent prints a dashboard link
  carrying the token in the URL fragment, which browsers do not send to servers; the dashboard moves it
  to `sessionStorage` and clears the fragment.
- Every message is size-capped (16 KiB), schema-checked with unknown fields rejected, and rate-limited
  (burst 20, 10/s). Violations close the connection.
- `next dev` / `next start` bind to `127.0.0.1` (the Next default is `0.0.0.0`).
- One agent per port, so a second instance fails to start instead of fighting the first.

## Peer link (gaming PC ↔ laptop) — proposed

- Explicit pairing: the gaming PC shows a 6-digit one-time code (2 min expiry); the laptop user types it.
  Use a PAKE (e.g. SPAKE2 or CPace) so the short code cannot be brute-forced offline, then exchange and
  pin long-term Ed25519 keys and the Deskflow TLS fingerprints.
- Control and audio keys derived from the pinned keys; audio frames use an AEAD (ChaCha20-Poly1305 or
  AES-GCM) with sequence numbers as nonces.
- Bind to the private-network interface chosen in settings. Ask before adding a Windows Firewall rule
  (private profile only).

## Threat model (short)

- In scope: other devices on the LAN, other websites in the user's browser, a second local user account.
- Out of scope: malware already running as the same user (it can read the token and drive input anyway).
- Logs never contain audio content, keystrokes, or tokens.
