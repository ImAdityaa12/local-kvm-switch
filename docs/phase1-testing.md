# Phase 1: testing input switching on two machines

What is built: pairing, the encrypted peer link, and Deskflow driven by the agents. What still needs
your two machines: everything that involves real input.

## 1. Install

On **both** machines:

1. Node.js 22.18 or newer, and this repository with `npm install`.
2. Deskflow **1.27.0** from https://github.com/deskflow/deskflow/releases. The MSI installs
   `C:\Program Files\Deskflow\deskflow-core.exe` and also an auto-start **Deskflow service**
   (it runs the core on secure desktops). You can stop and disable that service in
   `services.msc`; the agent starts `deskflow-core` itself. If you use the portable zip instead, pass
   `--deskflow <path to deskflow-core.exe>` to the agent.
   Deskflow is GPL-2.0; we run it as a separate program and do not link or modify it.

## 2. Start

Gaming PC (find its address with `ipconfig`, the IPv4 of your Ethernet or Wi-Fi adapter):

```bash
node agent/src/main.ts --machine gaming-pc --bind 192.168.1.20
npm run dev
```

Laptop:

```bash
node agent/src/main.ts --machine laptop
npm run dev
```

Open the link each agent prints, on its own machine.

**Windows Firewall:** the first time, Windows asks whether Node.js may accept connections on the gaming
PC. Allow it for **private networks only**. The agent needs inbound TCP 47821 (peer link) and 47822
(only while pairing is open). Deskflow's own port (24810) stays on loopback and needs no rule.

## 3. Pair

1. Gaming PC dashboard: **Open pairing for two minutes**. It shows its address.
2. Laptop dashboard: type that address, **Pair**.
3. Both show six digits. If they match, press **The codes match** on both. If they differ, press
   **They differ**: something else answered.

## 4. Test plan (from the feasibility report)

| # | Do | Expect |
| --- | --- | --- |
| 1 | Click **Laptop** on the gaming PC dashboard | Steps: asking the laptop, starting Deskflow, then "Press Ctrl+Alt+Right". Press it: the cursor moves to the laptop and the Laptop half lights up. |
| 2 | Type and move the mouse | The laptop responds. |
| 3 | Press **Ctrl+Alt+Left** | Cursor returns; within a second "Input engine: Not running", "Global input hooks: None installed". Task Manager shows no `deskflow-core.exe` on the gaming PC. |
| 4 | Switch to the laptop, then **Return to Gaming PC** | Same as 3. |
| 5 | While on the laptop, hold Shift and unplug the laptop's network | Within ~10 s input is back on the gaming PC. Check for a stuck Shift on both machines. |
| 6 | Sleep the laptop while it has input, then wake it | Same as 5; the link reconnects without restarting agents. |
| 7 | Click Laptop and do not press the hotkey | After 60 s it gives up and returns to Gaming PC. |
| 8 | Click Laptop, then **Return to Gaming PC** before pressing the hotkey | Cancels at once. |

Please note anything that differs, especially items 3 and 5. The open questions they answer are in
`docs/feasibility-report.md` §7.

## Known limits

- Moving to the laptop takes the hotkey; a click alone cannot do it yet (Deskflow has no documented
  API for it).
- Clipboard sharing is off.
- The paired key is stored in `%LOCALAPPDATA%\LanKvmSwitcher\peer.json`, protected by your user
  profile's permissions, not yet by DPAPI.
- Audio is Phase 2.
- While Laptop mode is active, another program on either machine could connect to Deskflow's loopback
  port and receive keystrokes (see ADR 0003, "Known gap"). Don't use Laptop mode on a machine shared
  with other Windows users until that is fixed.
