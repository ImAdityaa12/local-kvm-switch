# LAN KVM Switcher — Product Requirements & Build Specification

## 1. Project overview

Build a Windows desktop utility with a **Next.js + TypeScript dashboard** and native Windows agents. One physical keyboard and mouse remain connected to the gaming PC, and the user can select one of two targets:

- **Gaming PC** — keyboard and mouse stay local.
- **Laptop** — keyboard and mouse control the laptop over the local network.

The app should also support **two-way audio routing** so the user can keep their IEM/headset plugged into the gaming PC while using the laptop:

- Laptop system audio → LAN → gaming PC playback device → IEM.
- Gaming PC microphone input (the IEM mic) → LAN → laptop microphone endpoint → apps such as Discord.

The user wants one app to control these features. Avoid requiring the user to open and manually configure separate audio-routing software during normal operation. The app may use or package suitable native components, subject to licensing and installation requirements.

**Working name:** LAN KVM Switcher

## 2. Core user requirements

1. Keyboard and mouse remain physically connected to the gaming PC.
2. The user selects `Gaming PC` or `Laptop`.
3. In `Gaming PC` mode, physical input must remain direct/local. Do not intercept, relay, suppress, or inject keyboard/mouse input unnecessarily.
4. In `Laptop` mode, keyboard and mouse control the laptop over the LAN.
5. Audio output and microphone can be routed bidirectionally when enabled.
6. The IEM stays physically connected to the gaming PC.
7. One dashboard controls target selection, connection state, and audio routing.
8. The app works over the local network; no cloud service or internet connection is required for normal operation after installation.
9. The UI shows connection, input target, audio route, and microphone route status truthfully.
10. If a connection fails, stop/disable remote routing safely and provide a recovery path.
11. Do not claim a browser-only app can take ownership of USB devices, globally capture input, or create system-wide virtual audio endpoints.
12. Never attempt to evade or interfere with game anti-cheat software.

## 3. Architecture at a glance

```text
                 Next.js / React dashboard
            target switch • audio • devices • status
                              |
                   authenticated local IPC
                              |
       +----------------------+----------------------+
       |                                             |
Gaming PC native agent                         Laptop native agent
- input engine integration                    - input engine integration
- capture microphone                          - capture system audio
- play received laptop audio                   - expose remote mic endpoint
- manage audio routes                          - manage audio routes
       |                                             |
       +-------------- local LAN --------------------+
```

The dashboard is the control plane, not the audio engine. Real-time input and audio work must run in native components, not in a browser tab or Next.js server route.

## 4. Phase 0 — Feasibility spikes (must happen before polishing UI)

### 4.1 Input switching spike

Investigate maintained input-sharing engines:

- Input Leap: https://github.com/input-leap/input-leap
- Deskflow: https://github.com/deskflow/deskflow

Verify current Windows support, license, configuration, switching behavior, and documented CLI/IPC/hotkey control. Do not invent an API or rely on undocumented internals.

Test on two Windows devices:
- Switch to the laptop.
- Switch back to local gaming-PC input.
- Disconnect/sleep the laptop during remote mode.
- Confirm that gaming-PC mode leaves physical input direct/local.

Write a short decision record before selecting the integration.

### 4.2 Audio feasibility spike

Prove each direction independently before integrating it into the dashboard.

**A. Laptop audio to gaming PC/IEM**
- Capture laptop system output using a supported Windows API such as WASAPI loopback.
- Stream audio across the LAN.
- Play it through a selected playback device on the gaming PC.
- Confirm that the IEM receives the laptop audio and that the gaming PC's normal playback can still be used when desired.

**B. Gaming-PC IEM microphone to laptop**
- Capture the selected microphone/input endpoint on the gaming PC.
- Stream it across the LAN.
- Make it available to laptop applications as a selectable microphone device.
- Verify it appears in Windows sound settings and can be selected in a recording app/Discord.

**Critical Windows constraint:** Receiving microphone samples over the network is not enough. Laptop applications normally need a Windows audio capture endpoint. Investigate a suitable existing virtual audio driver/device and its license, signing, installation, architecture, and redistribution terms. Do not assume a normal user-mode WASAPI app can create a system-wide virtual microphone endpoint by itself. If a driver is needed, disclose the installation requirements and obtain explicit user consent. Do not silently install drivers or services.

Also investigate whether a maintained, redistributable component can provide these endpoints. Do not make a new kernel-mode audio driver the default plan.

### 4.3 Audio quality requirements and realistic guarantees

- Target 48 kHz audio, with configurable channel count and bit depth where supported.
- Prefer uncompressed PCM or a demonstrably transparent/high-quality mode when LAN bandwidth and CPU permit.
- Avoid unnecessary resampling, clipping, gain changes, noise suppression, or lossy encoding.
- Preserve independent controls for playback and microphone levels.
- Detect unsupported formats and fall back explicitly rather than silently degrading quality.
- Add a loopback/recording test to compare routed audio against the direct device path.
- Do not promise bit-for-bit or perceptually identical audio before testing the actual device and route. Audio quality depends on the capture endpoint, mixer, driver, resampling, transport, and playback endpoint.
- Latency and fidelity are separate: optimize quality as a requirement even if some buffering is acceptable.

Record the chosen transport, format, endpoint strategy, measured quality, limitations, and dependencies in an architecture decision record.

## 5. Recommended implementation approach

Prefer maintained, documented components over custom low-level input handling or a custom virtual audio driver.

### Input

Wrap a proven input-sharing engine if it supports the required switch behavior. Use only documented configuration, hotkey, CLI, or IPC mechanisms. If a clickable target button cannot be reliably supported, ship a supported hotkey first and document the limitation.

### Audio

Use native Windows components for capture, playback, and device management. Investigate:
- WASAPI loopback for capturing laptop system audio.
- WASAPI capture for the physical microphone on the gaming PC.
- WASAPI playback for playing received laptop audio on the gaming PC.
- A suitable existing virtual audio capture endpoint on the laptop so applications can use the streamed mic.
- A suitable virtual playback endpoint on the gaming PC only if the selected design needs one; direct playback to a chosen physical output may be simpler.
- A LAN transport with framing, jitter buffering, format negotiation, authentication, and reconnection behavior.

Do not choose a library or protocol solely from its name. Verify current maintenance, Windows compatibility, license, redistributability, and actual API documentation before implementation. Avoid writing a custom driver unless the feasibility investigation shows no acceptable alternative and the user explicitly approves the added complexity.

### UI and app shell

- TypeScript, React, Next.js, shadcn/ui for the dashboard.
- A desktop shell such as Tauri or Electron may be needed for installation, local IPC, tray controls, and lifecycle management. Choose after the native-agent feasibility spike.
- Native Windows agent(s) run the real-time work. The UI sends authenticated commands and displays agent-reported state.
- Keep the audio engine out of Next.js API routes; HTTP request/response handling is not a real-time audio transport.

## 6. Phased roadmap

### Phase 0 — Research and feasibility
- Complete input-engine investigation.
- Prove local/remote input switching.
- Prove laptop audio → gaming PC playback.
- Prove gaming-PC microphone → laptop virtual microphone.
- Document licenses, installation requirements, known limits, and chosen architecture.
- Do not build a polished UI before the hard feasibility questions are answered.

### Phase 1 — Input-only MVP
- Configure/pair the laptop.
- Display connection state and active target.
- Switch between `Gaming PC` and `Laptop`.
- Include a configurable hotkey if supported.
- Add emergency return-to-local action.
- Confirm local input is not intercepted in Gaming PC mode.

### Phase 2 — One-way laptop audio
- Capture laptop system audio.
- Stream it to the gaming PC.
- Select the PC playback device.
- Add audio enable/disable, volume, format, and status controls.
- Measure stability and compare quality against direct playback.

### Phase 3 — Return microphone audio
- Capture the PC-connected IEM microphone.
- Stream it to the laptop.
- Expose it through a suitable virtual microphone endpoint.
- Verify it is selectable by normal Windows applications.
- Add mic mute, level meter, gain, and device selection.
- Obtain explicit consent for any driver/component installation.

### Phase 4 — Unified dashboard and reliability
- Integrate input and both audio directions into the dashboard.
- Show independent statuses: input target, laptop audio route, mic route.
- Reconnect after temporary network interruptions.
- Handle sleep/wake and device removal.
- Prevent duplicate background processes.
- Add logs, tray controls, startup options, and safe shutdown.
- Ensure the UI never claims a route is active until the native agent confirms it.

## 7. Dashboard requirements

Two main target cards:
- **Gaming PC — LOCAL INPUT**
- **Laptop — REMOTE INPUT**

Audio section:
- `Laptop audio → Gaming PC: On/Off`
- `Gaming PC microphone → Laptop: On/Off`
- Playback-device selector on the PC.
- Microphone selector on the PC.
- Remote virtual microphone status on the laptop.
- Independent playback volume and microphone gain/mute.
- Format/status display, e.g. sample rate and channel count when known.
- Clear errors for missing devices, unsupported formats, firewall blocks, or disconnected peers.

The UI must distinguish:
- Input sharing connection state.
- Laptop audio streaming state.
- Microphone streaming state.
- Whether the expected Windows audio endpoint exists and is selected.

Do not present a single “Connected” label as proof that every route works.

## 8. Network and security requirements

- Local network only by default; no cloud relay.
- Pair the two devices explicitly with a one-time pairing code or equivalent secure flow.
- Authenticate and encrypt control/audio transport where practical; document the threat model and key management.
- Do not accept control from every LAN device automatically.
- Bind services to the required interface only.
- Do not expose ports to the public internet or require router port forwarding.
- Windows Firewall may require an app-specific private-network allow rule; explain it and ask for consent when needed.
- Detect client isolation or unreachable peers and explain the likely cause.
- Validate messages, cap payload sizes, and rate-limit control messages.
- Do not hard-code secrets or store passwords in source control.

## 9. Gaming-PC safety requirements

- When `Gaming PC` is selected, do not activate a global keyboard/mouse interception, suppression, or forwarding path.
- Do not send keyboard/mouse events over the network in local mode.
- Do not attempt to evade or interfere with Valorant/Vanguard or other anti-cheat software.
- Keep audio streaming independent of input switching. Audio features must not add hooks to the gaming input path.
- Include an immediate action to disable remote input and return to local mode.
- Handle held keys/buttons on disconnect where supported by the selected engine.
- Never report local mode as restored until the engine confirms it.

## 10. Failure handling

### Laptop disconnects during remote input
1. Stop remote input forwarding where possible.
2. Release held keys/buttons where supported.
3. Show the disconnected state.
4. Provide a recovery action to return to Gaming PC.
5. Do not claim recovery succeeded without confirmation.

### Audio peer/device disconnects
1. Stop or safely mute the affected stream.
2. Show which direction failed.
3. Retry/reconnect with bounded backoff.
4. Avoid loud pops when reconnecting or changing devices.
5. Do not silently switch to an unexpected microphone or playback device.

## 11. Testing checklist

### Input
- Local mode passes keyboard/mouse input directly.
- Remote mode controls the laptop.
- Hotkey/dashboard state matches actual engine state.
- Laptop sleep, disconnect, IP change, and reconnect.
- No stuck keys/buttons after switching or disconnect.
- Confirm no anti-cheat bypass behavior.

### Audio output
- Laptop system audio is audible through the IEM connected to the PC.
- Test speech, music, and game/system sounds.
- Check for dropouts, crackling, clipping, channel swap, sample-rate mismatch, and unexpected gain changes.
- Compare the same source played directly and through the network route.
- Verify that disabling the route returns the PC output to its previous state.

### Microphone
- The laptop sees a usable microphone endpoint.
- Test recording and a real-time communication app.
- Check intelligibility, background noise, clipping, level, channel count, and dropouts.
- Verify mute/unmute and device removal/reconnection.
- Confirm microphone privacy permissions and driver requirements are explained.

### Security and lifecycle
- Unpaired devices cannot control or stream to the agent.
- No public-internet exposure or router port forwarding is required.
- App shutdown releases resources.
- Logs avoid recording audio content or sensitive input.
- Driver/service installation is explicit and reversible.

## 12. Instructions to the coding agent (Claude Code)

Before writing the full implementation:

1. Inspect the repository and report its current stack and structure.
2. Read this specification fully.
3. Create a short implementation plan and architecture decision records.
4. Perform the input and audio feasibility spikes first.
5. Check official documentation and current source code for every proposed dependency/API. Never invent CLI flags, IPC interfaces, APIs, or driver capabilities.
6. Separate confirmed facts from assumptions and open questions.
7. Build the smallest working vertical slice before broad refactoring.
8. Add tests and clear setup instructions as each component is implemented.
9. Ask before adding dependencies with restrictive licenses, installing services/drivers, requiring administrator privileges, or making major architecture changes.
10. Keep input switching and audio routing as separate modules so audio failure cannot compromise local gaming input.
11. Update this file when feasibility results change the architecture or requirements.
12. Do not claim the project is complete until it has been tested on two real Windows machines.

**First task:** Produce a feasibility report and proposed architecture for (a) safe input switching, (b) laptop system audio to gaming PC playback, and (c) gaming-PC microphone to a selectable laptop microphone endpoint. Include dependency/license findings, driver requirements, documented APIs, a minimal test plan, and the smallest next implementation step. Do not begin the polished UI yet.

## 13. Feasibility updates (2026-10-17)

Desk research results; see `docs/feasibility-report.md` and `docs/adr/`. Not yet verified on two machines.

- **Input Leap is archived** (read-only since 2026-07-26). Deskflow v1.27.0 is the candidate engine.
- **Deskflow's server keeps global low-level keyboard/mouse hooks for its whole lifetime**, even when the
  cursor is on the server. Gaming PC mode is therefore defined as "the Deskflow server process is not
  running", not "the cursor is on the gaming PC". This tightens §2.3 and §9.
- Deskflow has **no documented API to switch screens**. Phase 1 ships the `switchToScreen` hotkey as the
  supported control; an automated dashboard button is a spike (§5 already allows this).
- No user-mode API creates a capture endpoint. Default laptop mic endpoint: **VB-CABLE, installed by the
  user** (donationware; bundling allowed with conditions). Voicemeeter is an accepted alternative.
- Laptop → PC audio needs no driver (WASAPI loopback / process loopback).
- Native audio helper language is open (Rust `wasapi` crate proposed); needs a toolchain install.
- Phase 1 (2026-10-17): pairing uses numeric comparison (both screens show a code; both users
  confirm) rather than typing a code, which satisfies §8's "equivalent secure flow". Deskflow runs on
  loopback and is tunnelled through the TLS-PSK peer link instead of using its own TLS.
