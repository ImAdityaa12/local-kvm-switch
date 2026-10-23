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

## Peer link (gaming PC ↔ laptop) — implemented 2026-10-17

- **Pairing by numeric comparison** (as in Bluetooth LE Secure Connections), chosen over a typed code
  because it needs no PAKE library: X25519 keys, a commitment from the gaming PC before nonces are
  revealed, and a 6-digit code from both keys and nonces shown on both screens. Both users confirm.
  A machine in the middle wins with probability one in a million per attempt, and each attempt needs a
  person to confirm. The pairing window is open for 2 minutes on TCP 47822, one attempt at a time.
- **Link**: TLS 1.2 with the pre-shared key from pairing (HKDF-SHA256 over the X25519 secret and both
  nonces), cipher ECDHE-PSK-CHACHA20-POLY1305 (forward secrecy). Only Node's built-in TLS is used; no
  hand-made record protocol. TCP 47821 on the address given with `--bind` (or the first private IPv4).
  Revised 2026-10-23: on every adapter (0.0.0.0) unless `--bind` pins an address this PC still has,
  so a new DHCP lease needs no restart. Connections from outside loopback, RFC 1918 and link-local
  IPv4 are closed before TLS, here and on the pairing port.
- **Finding the gaming PC again** (2026-10-23): when its saved address stops answering, the laptop
  broadcasts on UDP 47823 a nonce with HMAC-SHA256(PSK) over it; only the paired gaming PC answers,
  with its own HMAC, straight back. Failing that, it resolves the gaming PC's computer name. The
  laptop saves the new address only after the PSK handshake succeeds there, so a forged answer can
  at most cost one failed connection.
- Messages are newline-delimited JSON, capped at 64 KiB per frame, validated, and rate-limited
  (50/s, burst 100). Heartbeat every 2 s; the link is down after 6.5 s of silence.
- **Tunnels**: separate PSK-authenticated TLS connections whose first frame names a loopback target on
  the gaming PC (only `deskflow` is allowed). Used for Deskflow (ADR 0001).
  Revised 2026-10-23 (ADR 0005): either machine opens streams to the other's registered targets
  (`files`, `clipboard`, and Deskflow and audio on the gaming PC). The gaming PC asks over the
  control session and the laptop dials back, so the laptop still never listens.
- Key storage: `%LOCALAPPDATA%\LanKvmSwitcher\peer.json`. TODO: DPAPI.
- Windows prompts for the firewall the first time Node listens; the guide says to allow private
  networks only. The agent adds no rule itself.
- Audio (Phase 2) will derive its own keys from the same PSK.

## Threat model (short)

- In scope: other devices on the LAN, other websites in the user's browser, a second local user account.
- **Known gap (Phase 1):** while Laptop mode is active, Deskflow's loopback ports (24810 on the gaming
  PC, 24811 on the laptop) accept any local process, including one run by another Windows user, and
  Deskflow's own TLS is off. Such a process could connect as the client and receive keystrokes. The
  ports exist only while Laptop mode is active. Fix planned: turn Deskflow TLS back on inside the
  tunnel with fingerprints exchanged over the peer link, so a second layer authenticates the client.
- Out of scope: malware already running as the same user (it can read the token and drive input anyway).
- Logs never contain audio content, keystrokes, or tokens. Deskflow runs at log level Debug, which
  excludes key events (those are Verbose); its output is parsed in memory and never written to disk.
- The Deskflow enter/exit notifier posts to `127.0.0.1:<agent>/notify` with a per-run random token;
  requests carrying an `Origin` header (any browser) are refused.
