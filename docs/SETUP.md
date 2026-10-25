# Setup: step by step

Two machines:

- **Gaming PC**: the keyboard, mouse and IEM are plugged in here.
- **Laptop**: the second computer. VB-CABLE is installed here.

Follow the parts in order. Parts 1–3 are done once; Part 4 is what you do each time you use it.

> **PowerShell note:** if `npm` says *"running scripts is disabled on this system"*, type `npm.cmd`
> instead of `npm` (or run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).

---

## Part 1: Install (once per machine)

### On both machines

1. **Node.js 22.18 or newer**: https://nodejs.org (LTS installer). Check with `node -v`.
2. **Git**: https://git-scm.com/download/win
3. **Deskflow 1.27.0**: https://github.com/deskflow/deskflow/releases/tag/v1.27.0, file
   `deskflow-1.27.0-win-x64.msi`. Use this stable release, **not** "continuous".
4. **Nothing to set up in Deskflow.** The agent starts Deskflow itself, only when needed. On the
   gaming PC the Deskflow service would block it, so the background install (Part 4) turns the
   service off. On the laptop the install turns the service **on**: the agent has it start Deskflow,
   because only Deskflow started by the service reaches windows that run as admin (Device Manager,
   Task Manager) and Windows permission prompts. Windows asks for admin permission once on each
   machine. If the Deskflow app is open, the agent closes it when you switch. You never need to open
   or configure the Deskflow app.

### On the gaming PC only (the monitor)

- **Plug the monitor's USB cable** (USB-B at the monitor, USB-A on the PC) **into the gaming PC**, and
  leave it there. The gaming PC switches the monitor between HDMI 1 (gaming PC) and HDMI 2 (laptop)
  through it.
- **Install Gigabyte OSD Sidekick** on the gaming PC (from the G24F 2 support page). The agent uses the
  USB driver it installs; you don't need to open Sidekick. To check: Device Manager → *libusb-win32
  devices* → **USB 2.0 BILLBOARD**.
- If the USB cable or Sidekick is missing, the agent tries the HDMI cable instead (DDC/CI), which may
  only work while the gaming PC is on screen. Otherwise switch the monitor with its own Input button.

### On the laptop only

5. **VB-CABLE** (makes the IEM mic appear as a microphone on the laptop):
   1. Download from https://vb-audio.com/Cable/ and **extract** the zip.
   2. Right-click `VBCABLE_Setup_x64.exe` → **Run as administrator** → **Install Driver**.
   3. **Reboot.**
   4. Settings → System → Sound → **Output**: do not leave it on "CABLE Input" or "CABLE In 16ch"
      (the installer may have chosen one). That cable carries your mic, so laptop sound there blocks
      the microphone and the laptop-audio route. Step 6 sets the output.
6. **Voicemeeter** (free; so laptop sound plays only in your IEM, not on the laptop's speakers).
   Optional: without it, set Output to your speakers or headphones and the laptop plays its sound
   there too. Only its virtual output is used; you never open the Voicemeeter app.
   1. On https://vb-audio.com/Voicemeeter/ download **Voicemeeter** (the standard one) and
      **extract** the zip.
   2. Right-click `VoicemeeterSetup.exe` → **Run as administrator** → **Install**.
   3. **Reboot.**
   4. Nothing to choose in Sound settings: **Laptop mode sets the laptop's Output to Voicemeeter
      Input (VB-Audio Voicemeeter VAIO) and its Input to CABLE Output (VB-Audio Virtual Cable)**,
      and remembers your own speakers and microphone. The laptop's speakers go quiet; the agent
      sends what plays there to your IEM. **Reset mic and speaker** (right-click the laptop's LAN
      KVM tray icon, or the button on its dashboard) sets them again if something changed them in
      Laptop mode, and puts back the laptop's own speakers and microphone otherwise.
   5. **Do not start the Voicemeeter app** (and if it shows in the tray, right-click → Exit): while
      it runs, it can play the sound on the speakers again. VB-CABLE A+B's **CABLE-A Input** works
      the same way if you have it.

---

## Part 2: Get the project (once per machine)

### Laptop

The project is already in `C:\Users\Lenovo\Desktop\local-kvm-switcher`. Update it:

```
cd C:\Users\Lenovo\Desktop\local-kvm-switcher
git pull
npm.cmd install
```

The audio helper is already built here:
`native\kvm-audio\target\release\kvm-audio.exe`. If it is missing, see "Building the audio helper"
at the end.

### Gaming PC

```
git clone https://github.com/ImAdityaa12/local-kvm-switch.git
cd local-kvm-switch
npm.cmd install
```

(If you cloned it before, run `git pull` and `npm.cmd install` inside the folder instead.)

**Copy the audio helper from the laptop.** It is not in Git; it only uses DLLs that come with Windows,
so no Rust is needed on the gaming PC.

1. On the laptop, copy
   `C:\Users\Lenovo\Desktop\local-kvm-switcher\native\kvm-audio\target\release\kvm-audio.exe`
   to a USB stick or shared folder.
2. On the gaming PC, inside `local-kvm-switch`, create the folders `native\kvm-audio\target\release`
   and put `kvm-audio.exe` there.

---

## Part 3: Pair the two machines (once)

1. **Gaming PC: find its address.** The gaming PC dashboard shows it under **Pair your laptop** once
   pairing is open (or run `ipconfig` and note the **IPv4 Address**, for example `192.168.1.20`).
   Both machines must be on the same network. You type it only this once: if the gaming PC's
   address changes later, the laptop finds it again on its own.
2. **Gaming PC: start the agent and the dashboard** (Part 4, steps 1–2).
3. **Laptop: start the agent and the dashboard** (Part 4, steps 3–4).
4. **Gaming PC dashboard:** scroll to **Pair your laptop** → **Open pairing for two minutes**.
5. **Laptop dashboard:** **Pair your gaming PC** → type the gaming PC's address → **Pair**.
6. **Both screens show six digits.** If they are the same, click **The codes match** on **both**. If
   they differ, click **They differ** and try again.
7. Both dashboards now show the other machine as **Reachable**. Pairing is remembered.

---

## Part 4: Start it

### Recommended: in the background, every time you sign in (once per machine)

No terminals, no Next.js server, no browser tab left open. Close any agent or `npm run dev` you
started in a terminal first, then:

- **Gaming PC** (no address needed; it listens on every network adapter, so a new address from the
  router needs nothing from you):
  ```
  cd local-kvm-switch
  npm.cmd install
  npm.cmd run build
  npm.cmd run build:audio
  npm.cmd run autostart -- install --machine gaming-pc
  ```
  If you installed it before with `--bind`, run this install once more without it.
- **Laptop:**
  ```
  cd C:\Users\Lenovo\Desktop\local-kvm-switcher
  npm.cmd install
  npm.cmd run build
  npm.cmd run build:audio
  npm.cmd run autostart -- install --machine laptop
  ```

On the gaming PC the install also turns off the Deskflow service, which would otherwise start its own
Deskflow at every boot and block switching. On the laptop it turns the service on, so the keyboard and
mouse also work in admin windows and permission prompts there. Click **Yes** when Windows asks. The
service starts nothing by itself; the agent asks it to run Deskflow only while the laptop is in use. The agent starts right away and again at
every sign-in, hidden. If it stops (for example when the
network is not up yet just after sign-in) it starts again within 10 seconds. It uses about 70–80 MB
of RAM, plus about 25 MB for Deskflow only while the laptop is in use.

A **LAN KVM** dot appears in the notification area (bottom right; at first it may be hidden under
the **^** arrow, so drag it onto the taskbar to keep it in view). Its colour says who has the keyboard
and mouse: **grey** the gaming PC, **green** the laptop, **amber** switching, **red** the other
machine is not reachable. Hover it for the details. Right-click it for **Switch to laptop** (on the
laptop: **Take keyboard and mouse**), **Return to Gaming PC** and **Open dashboard**; left-click it to open the dashboard. The icon needs
`npm.cmd run build:audio` (it is built with the audio helper) and goes away when the agent stops.

You can also open the dashboard with the **LAN KVM** shortcut on the desktop or in the Start menu. It opens
in a small window of its own; close it when you are done, and the agent keeps running. On the laptop
it is where you take the keyboard and mouse from the laptop's side.

After `git pull`, run `npm.cmd run build` (and `npm.cmd run build:audio` if anything under `native/`
changed) again, then run
`npm.cmd run autostart -- stop` and the install line again (or sign out and back in).

- Stop it until the next sign-in: `npm.cmd run autostart -- stop`
- Turn it off for good: `npm.cmd run autostart -- remove`
- Its output: `%LOCALAPPDATA%\LanKvmSwitcher\agent.log`

### Or: in terminals, by hand

1. **Agent:** `node agent/src/main.ts --machine gaming-pc` on the gaming PC, or
   `node agent/src/main.ts --machine laptop` on the laptop. The first time, Windows Firewall asks
   about Node.js: tick **Private networks** only → **Allow**.
2. Open the link it prints. If you ran `npm.cmd run build`, the agent serves the dashboard itself.
   Otherwise run `npm.cmd run dev` in a second terminal (it uses about 450 MB more) and the link
   points there.

To stop, press **Ctrl+C**.

---

## Part 5: Use it

Audio routes, devices, volume and mute can be set from either dashboard: the gaming PC runs them, and
the laptop's dashboard shows and changes the same routes while the gaming PC is reachable. Switching
modes works from either machine.

### Laptop mode and Gaming PC mode

**Laptop mode** does five things, in this order, and the dashboard lists each one with what happened
(*Done*, *Sent, not confirmed*, *Failed* or *Skipped*, with the reason):

1. The laptop's display layout → **Extend**.
2. The monitor → **HDMI 2**. *Done* means the monitor itself reported HDMI 2.
3. Keyboard and mouse → the laptop.
4. Laptop audio → your IEM on the gaming PC.
5. Gaming PC microphone → the laptop.

If step 1, 2 or 3 fails, the switch stops there. If the keyboard and mouse can't move, the monitor
goes back to HDMI 1, so the gaming PC keeps its screen. Audio problems are shown but don't stop the
switch.

**Gaming PC mode** reverses it:

1. Keyboard and mouse back.
2. Both audio routes off.
3. Monitor → HDMI 1.
4. The laptop → **PC screen only**. This happens only once the monitor has confirmed HDMI 1;
   otherwise the laptop stays in Extend, so the monitor still shows something. The laptop's own
   screen stays on in both modes.

**To switch:**

1. On the gaming PC, click **Laptop** (or **Switch to laptop** in the tray menu). The cursor moves to
   the laptop on its own; the Laptop half turns green.

   **From the laptop:** use its own touchpad to click **Switch to Laptop mode** on the laptop's
   dashboard (or **Take keyboard and mouse** in the laptop's tray menu). The gaming PC runs the same
   switch, and the laptop's dashboard shows the same steps.
2. If it stops at **Press Ctrl+Alt+Left**, press it on the gaming PC keyboard, or move the cursor off
   the left edge of the gaming PC's screen (the laptop sits to its left). This happens when a window
   that runs as admin has focus on the gaming PC, because Windows then ignores the key press the agent
   sends for you.
3. Press **Ctrl+Alt+Right**, or click **Gaming PC mode** (top right, on either dashboard), or
   **Return to Gaming PC** in the tray menu. Each one runs the whole of Gaming PC mode, monitor
   included. If the laptop disconnects, the gaming PC does the same on its own. Moving to the edge of
   the laptop's screen switches back only with **Switch at the screen edges** on (below). The dashboard shows
   **Input engine: Not running** and **Global input hooks: None installed**, and the log says
   *Local input confirmed. Input sharing stopped, no hooks installed.* That message is normal here.

Switch back to the Gaming PC before starting a game with anti-cheat.

### Switching at the screen edges (optional)

Turn on **Switch at the screen edges** on either dashboard, or tick it in either tray menu. The
gaming PC keeps the setting, so it stays on after a restart.

- **Off the left edge of the gaming PC's screen:** the keyboard and mouse move to the laptop. Only
  the input moves: the monitor stays on the gaming PC and you use the laptop on its own screen.
- **Off the right edge of the laptop's screen:** they come back.
- **In Laptop mode** the laptop's right edge does the whole of Gaming PC mode, monitor included, as
  Ctrl+Alt+Right does.

While it is on, Deskflow keeps running on the gaming PC **in Gaming PC mode too**, waiting at the
edge with the laptop connected. The dashboard then shows **Global input hooks: Installed by the
engine**. Turn it off before starting a game with anti-cheat. Also, in games with a visible cursor,
a quick move to the left edge sends the keyboard and mouse to the laptop.

### Laptop sound in your IEM

1. **Laptop audio to Gaming PC → Play on**: choose the gaming PC device your IEM is plugged into.
   (This is the gaming PC's device; the laptop's own output is set in its Windows Sound settings,
   Part 1 step 6.)
2. Turn the switch on. It shows **Streaming** once sound arrives.
3. Play something on the laptop.

### Gaming PC sound on the laptop

The other way round: hear the gaming PC (a game, Discord, music) on the laptop's own speakers or
headphones. Nothing needs installing; it uses the same audio helper.

1. **Gaming PC audio to Laptop → Send the sound of**: choose the gaming PC output whose sound you
   want (normally its Windows default, the one apps play on). That output keeps playing on the
   gaming PC too.
2. Turn the switch on, from either dashboard, or tick **Hear the gaming PC on this laptop** in the
   laptop's tray menu (**Play this PC's sound on the laptop** on the gaming PC's).
3. **Volume** sets how loud it is on the laptop; **Mute** silences it before it leaves the gaming PC.

Sound goes one way at a time: turning this on turns off **Laptop audio to Gaming PC**, and turning
that on (or switching to Laptop mode) turns this off. Otherwise the laptop would record the gaming
PC's sound and send it straight back. The laptop always plays it on its own speakers or headphones,
never on Voicemeeter or a CABLE device, and leaves its Windows output as it is.

### IEM microphone on the laptop

1. **Gaming PC microphone to Laptop → Microphone on this PC**: choose your IEM's microphone.
2. Turn the switch on.
3. On the laptop, in Discord: **Settings → Voice & Video → Input Device → CABLE Output (VB-Audio
   Virtual Cable)** → **Let's Check**.
4. **Mute** (on either dashboard) silences the mic before it leaves the gaming PC.

### Clipboard and files

Both are on by default, in both directions, and everything goes over the paired link only.

1. **Once on each machine**, in the project folder: `npm.cmd run setup:files`. It installs rclone
   and WinFsp with winget; Windows asks for permission once (WinFsp is a file-system driver). Also
   run `npm.cmd run build:audio` once after updating; it builds the clipboard helper
   (`kvm-clip.exe`). The agent notices both within 15 s; restart it after the build.
2. **Files:** the other machine's drives appear in Explorer under **This PC** as one network drive:
   **Gaming PC (G:)** on the laptop and **Laptop (L:)** on the gaming PC (another letter if that one
   is taken). Each drive is a folder named by its letter: `G:\C\Users\…`, `G:\D\Games\…`. Every app
   can open and save there. Files open as the signed-in Windows user of the other machine.
3. **Clipboard:** copy on one machine, paste on the other: text, formatted text and images. Copied
   files paste too (Explorer copies them from the other machine's drive), so the drive must be
   connected.
4. **Turn either off** in the dashboard's **Clipboard and files** section. *Share this PC's drives*
   decides whether the other machine sees this PC's drives; *Share the clipboard* covers both
   directions on this PC.

Copies a password manager marks as private (KeePass does, for example) never leave the machine. A file saved through the drive reaches the other machine about a second after the app
closes it, and new files there show within a few seconds. If the link drops for more than 20 s the
drive is removed, so Explorer does not hang on it; it comes back with the link.

---

## Troubleshooting

| You see | Do this |
| --- | --- |
| `npm.ps1 cannot be loaded because running scripts is disabled` | Use `npm.cmd` instead of `npm`. |
| "Deskflow was not found at …" | Install `deskflow-1.27.0-win-x64.msi` on **that** machine. If installed elsewhere, add `--deskflow "C:\path\to\deskflow-core.exe"` to the agent command. A message starting with the other machine's name came from the other machine. |
| "The Deskflow service is already running Deskflow" (often right after a restart; gaming PC) | In the project folder run `npm.cmd run autostart -- disable-deskflow` and click **Yes**. Or by hand: `services.msc` → **Deskflow** → **Stop**, and **Startup type** → **Disabled**. |
| On the laptop the keyboard and mouse stop working in Device Manager, Task Manager, an admin window, a permission (UAC) prompt or the lock screen, or the laptop's log says *The Deskflow service is off* | On the laptop, in the project folder, run `npm.cmd run autostart -- enable-deskflow` and click **Yes**. Or by hand: `services.msc` → **Deskflow** → **Startup type** → **Automatic**, then **Start**. It takes effect from the next switch to the laptop. |
| Laptop mode shows **Monitor input: Skipped** ("This PC cannot switch the monitor") | The gaming PC found neither the monitor's USB device nor a DDC/CI answer. Check the monitor's USB cable is in the gaming PC and OSD Sidekick is installed (Part 1, gaming PC only), then restart the gaming PC agent. Meanwhile, switch the monitor with its Input button. |
| **Monitor input: Failed** or *Sent, not confirmed* | Use the monitor's Input button. In Gaming PC mode the laptop stays in Extend so the monitor still has a picture. Send the gaming PC's log (`--source display` shows the monitor commands and answers). |
| "The display helper is not built" | Run `npm.cmd run build:audio` on that machine (it builds `kvm-display.exe` with the audio helper), then restart the agent. |
| "The Deskflow app is already running Deskflow" | The agent closes the app by itself, so this means it could not. Right-click the Deskflow tray icon → **Quit**, and Task Manager → **Startup apps** → **Deskflow** → **Disable**. |
| Clicking **Laptop** never reaches *Press Ctrl+Alt+Left* (or Ctrl+Alt+Left does nothing), and the laptop's log says *Local input confirmed…* right after the switch starts | The laptop is running an older version that stopped its own Deskflow straight away. Update the laptop (`git pull`, Part 2) and restart the laptop agent. |
| Laptop shows **Unreachable** | Same network? Allowed Node.js through the firewall for **Private** networks (both TCP and UDP; the laptop finds a gaming PC whose address changed over UDP 47823)? Network set to **Private**, not Public, in Windows settings? If the gaming PC's address changed, the laptop's log says *Found … at its new address* within about 15 s; if it never does, pair again with the new address. |
| The other machine's drive does not appear | Its dashboard must show **Share this PC's drives** on, with *Offering C:, …*. Both machines need `npm.cmd run setup:files`; the one showing the drive needs WinFsp. rclone's own messages are in `%LOCALAPPDATA%\LanKvmSwitcher\files-mount.log` (and `files-serve.log` on the other machine). |
| Pasted files do nothing, or paste is greyed out | Files copied on the other machine paste only while its drive is connected here, and only from drives it offers. Text and images do not need the drive. |
| Pairing: "Could not reach …" | Open pairing on the gaming PC first; it stays open for two minutes. Check the address. |
| "The laptop's sound output is "CABLE …", the microphone's cable", or the microphone fails with *0x8889000A* | On the laptop: right-click the LAN KVM tray icon → **Reset mic and speaker** while in Laptop mode, or Settings → System → Sound → Output → **Voicemeeter Input** (Part 1, step 6), or your speakers or headphones. Sound sent to "CABLE In 16ch" keeps the microphone from opening "CABLE Input". |
| "The laptop has no virtual microphone" | Install VB-CABLE on the laptop (Part 1, step 5), reboot, restart the laptop agent. |
| "The audio helper is not built" | Put `kvm-audio.exe` in `native\kvm-audio\target\release\` (Part 2), restart the agent. |
| Dashboard says **No agent** | The agent window was closed. Start it again and open the new link. |
| Port 47820 is busy | An agent is already running. Close the other window first. |

When asking for help, send from the machine that shows the error:

1. The **WARN** / **ERROR** lines the agent prints (in its terminal, or in `%LOCALAPPDATA%\LanKvmSwitcher\agent.log`
   when it runs in the background). Errors are printed there as text, so you can copy them.
2. Deskflow's log from its last run. Press **Win+R**, paste
   `%LOCALAPPDATA%\LanKvmSwitcher\deskflow` and press Enter. Send `deskflow-server.log` (gaming PC)
   or `deskflow-client.log` (laptop). Each switch overwrites it, so copy it before trying again.
   The log has no keystrokes in it.

A *"Deskflow stopped unexpectedly (exit code …)"* error includes Deskflow's last error line, which
usually says what went wrong.

### Sending logs to a database (optional)

With a log database set, both agents send everything they log (agent events, Deskflow's output,
audio helper crashes) to one Postgres database, so problems on either machine can be read from one
place. Set it once per machine, either way:

- Put `DATABASE_URL=postgresql://…` in a `.env` file in the project folder. Git ignores `.env`, so
  `git pull` does not bring it to the other machine; create it there too.
- Or run the agent once with `--log-db "postgresql://…"`. It is saved in
  `%LOCALAPPDATA%\LanKvmSwitcher\log-database-url`.

After that, start the agent as usual. The agent window says *"Logs are also sent to the log
database"*. To read them: `node scripts\logs.mjs --since 2h --level warn` (also `--machine laptop`,
`--source deskflow`, `--grep text`, `--runs`). If the network drops, logs wait in memory and are sent
when it is back. Like the Deskflow log file, nothing sent contains keystrokes or the dashboard token.

---

## Building the audio helper (only if `kvm-audio.exe` or `kvm-display.exe` is missing)

1. Install Rust: https://rustup.rs (per user, no admin).
2. Either install Visual Studio Build Tools (MSVC), **or** download the WinLibs MinGW-w64 UCRT zip from
   https://winlibs.com and extract it so that
   `%LOCALAPPDATA%\Programs\winlibs\mingw64\bin\dlltool.exe` exists.
3. In the project folder: `npm.cmd run build:audio`.
