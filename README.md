# LAN KVM Switcher

One keyboard, mouse and IEM on the gaming PC; choose whether they work on the gaming PC or on a laptop
over the local network, and route audio both ways. Spec: [`docs/spec.md`](docs/spec.md).

**Status: Phase 0.** The dashboard and the agent's control plane are built and tested against
**simulated** engines. No real keyboard, mouse or audio is routed yet. Read
[`docs/feasibility-report.md`](docs/feasibility-report.md) before building the real engines.

## Layout

| Path | What it is |
| --- | --- |
| `app/`, `components/dashboard/` | Next.js dashboard. Renders only what the agent reports. |
| `lib/protocol/` | Wire contract and strict validation, shared by dashboard and agent. |
| `lib/use-agent.ts` | Dashboard connection: token handling, reconnect, command acks. |
| `agent/src/` | Agent control plane (Node 22.18+, runs TypeScript directly). |
| `agent/src/engines.ts` | Input and audio adapter interfaces; real engines plug in here. |
| `agent/src/sim/` | Simulated engines for development. |
| `docs/` | Feasibility report, ADRs, spec. |

## Run it

```bash
npm install
npm run agent:sim     # terminal 1: prints a dashboard link with a one-time token
npm run dev           # terminal 2: dashboard on http://127.0.0.1:3000
```

Open the link the agent prints. The token travels in the URL fragment, is moved into this tab's
`sessionStorage`, and is removed from the address bar.

Agent options: `--port 47820`, `--dashboard http://localhost:3000`, `--unpaired` (start without a
paired laptop to try pairing), `--no-endpoint` (laptop without a virtual microphone).

The yellow bar in simulated mode can drop the laptop or remove its virtual microphone, so the failure
paths (return to Gaming PC, audio reconnect with backoff, missing endpoint) can be tried without hardware.

## Check it

```bash
npm test              # agent and protocol tests (node:test)
npm run typecheck
npm run lint
```

## Safety rules the code enforces

- The dashboard never marks a target or route active until the agent's engine confirms it.
- Gaming PC mode means no input-sharing process and no global hooks (`hooksActive: false`).
- Audio and input are separate adapters; audio failures never touch input state.
- A missing audio device stops the route; the agent never switches to another device on its own.
- The control channel is loopback-only, origin-checked, token-authenticated, size-capped and rate-limited.
