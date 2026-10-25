# LAN KVM Switcher

One keyboard, mouse and IEM on the gaming PC; choose whether they work on the gaming PC or on a laptop
over the local network, and route audio both ways (laptop sound to the IEM, or the gaming PC's sound to
the laptop's speakers). Spec: [`docs/spec.md`](docs/spec.md).

**To set it up on your gaming PC and laptop, follow [`docs/SETUP.md`](docs/SETUP.md).**

**Status: Phase 3 (both audio directions), awaiting two-machine tests.** Pairing, the encrypted
link between the two agents, Deskflow-based input switching, laptop audio to the gaming PC, and the
gaming PC microphone to a selectable laptop microphone (via VB-CABLE) are built and tested on one
machine. On your two machines follow [`docs/phase1-testing.md`](docs/phase1-testing.md),
[`docs/phase2-testing.md`](docs/phase2-testing.md), then [`docs/phase3-testing.md`](docs/phase3-testing.md).
Background: [`docs/feasibility-report.md`](docs/feasibility-report.md).

## Layout

| Path | What it is |
| --- | --- |
| `app/`, `components/dashboard/` | Next.js dashboard. Renders only what the agent reports. |
| `lib/protocol/` | Wire contract and strict validation, shared by dashboard and agent. |
| `lib/use-agent.ts` | Dashboard connection: token handling, reconnect, command acks. |
| `agent/src/` | Agent control plane (Node 22.18+, runs TypeScript directly). |
| `agent/src/engines.ts` | Input and audio adapter interfaces; real engines plug in here. |
| `agent/src/peer/` | Pairing (numeric comparison), TLS-PSK peer link, tunnels, trust store. |
| `agent/src/deskflow/` | Deskflow settings, process supervision, server and client engines. |
| `agent/notify.mjs` | Run by Deskflow on enter/leave; tells the agent where the cursor is. |
| `agent/src/audio/` | Drives the native audio helper: player on the gaming PC, sender on the laptop. |
| `native/kvm-audio/` | Native audio helper (Rust, WASAPI): loopback capture, jitter buffer, playback. |
| `agent/src/sim/` | Simulated engines for development. |
| `docs/` | Feasibility report, ADRs, spec. |

## Run it

Simulated (one machine, no Deskflow needed):

```bash
npm install
npm run agent:sim     # terminal 1: prints a dashboard link with a one-time token
npm run dev           # terminal 2: dashboard on http://127.0.0.1:7999
```

Real (two machines, Deskflow 1.27 installed): see [`docs/phase1-testing.md`](docs/phase1-testing.md).

```bash
node agent/src/main.ts --machine gaming-pc --bind <this PC's LAN IP>
node agent/src/main.ts --machine laptop
```

Open the link the agent prints. The token travels in the URL fragment, is moved into this tab's
`sessionStorage`, and is removed from the address bar.

Agent options: `--port 47820`, `--dashboard http://localhost:7999`, `--unpaired` (start without a
paired laptop to try pairing), `--no-endpoint` (laptop without a virtual microphone).

The yellow bar in simulated mode can drop the laptop or remove its virtual microphone, so the failure
paths (return to Gaming PC, audio reconnect with backoff, missing endpoint) can be tried without hardware.

Audio needs the native helper on both machines: `npm run build:audio` (Rust required; see
[`docs/phase2-testing.md`](docs/phase2-testing.md)).

## Check it

```bash
npm test              # agent, protocol and audio-helper tests (node:test)
npm run test:audio    # Rust unit tests for the helper
npm run typecheck
npm run lint
```

## Safety rules the code enforces

- The dashboard never marks a target or route active until the agent's engine confirms it.
- Gaming PC mode means no input-sharing process and no global hooks (`hooksActive: false`).
- Audio and input are separate adapters; audio failures never touch input state.
- A missing audio device stops the route; the agent never switches to another device on its own.
- The control channel is loopback-only, origin-checked, token-authenticated, size-capped and rate-limited.
- The two agents trust each other only after pairing; Deskflow is reachable only through their encrypted link.
- Return to Gaming PC cancels a switch in progress instead of waiting behind it.
