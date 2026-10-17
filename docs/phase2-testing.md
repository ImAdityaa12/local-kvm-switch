# Phase 2: laptop audio to the gaming PC

The laptop's sound (everything it plays) comes out of a device you choose on the gaming PC, such as
the DAC your IEM is plugged into. Phase 1 must work first (pairing and the peer link).

## 1. Build the audio helper (both machines)

The helper is a small Rust program in `native/kvm-audio` that does the real-time work with WASAPI.

1. Install Rust from https://rustup.rs (per user, no admin).
2. Build:

   ```bash
   npm run build:audio
   ```

   With the **MSVC** toolchain (needs Visual Studio Build Tools) that is all. With the **GNU**
   toolchain (no Visual Studio), the `windows` crate also needs GNU binutils: download the WinLibs
   MinGW-w64 UCRT zip from https://winlibs.com, check its SHA-256, and extract it so that
   `%LOCALAPPDATA%\Programs\winlibs\mingw64\bin\dlltool.exe` exists. The build script finds it there.

3. Restart the agents. The gaming PC dashboard now lists your playback devices.

## 2. Use it

On the gaming PC dashboard, under **Laptop audio to Gaming PC**:

1. Choose **Play on**: the device your IEM uses.
2. Turn the route on. It shows **Starting**, then **Streaming** once audio actually arrives.
3. **Format** shows what the laptop sends. "No format conversion" means the samples reach the Windows
   mixer unchanged (at 100% volume). If the device runs at a different rate or channel count, it says
   so: "Windows converts it to …". Matching the laptop's and the device's format in Windows Sound
   settings (Device properties → Advanced) removes the conversion.
4. **Buffer** is the receive buffer (target 40 ms); **dropouts** counts moments it ran empty.

## 3. Test plan

| # | Do | Expect |
| --- | --- | --- |
| 1 | Play music on the laptop | Heard in the IEM; level meter moves. |
| 2 | Play a 1 kHz test tone on the laptop at a known level | Peak on the dashboard matches the laptop's own meter within ~0.5 dB. |
| 3 | Play speech, music and a game/system sound | No crackle, clipping or channel swap (left/right test file). |
| 4 | Change volume and mute while playing | Smooth change, no click. |
| 5 | Unplug the laptop's network for 5 s, plug back | "Reconnecting", then "Streaming" within a few seconds of the link returning. |
| 6 | Unplug the gaming PC's USB DAC while streaming | Route stops with "playback device is not available"; it does **not** move to another device. |
| 7 | Leave it running for an hour | Note the dropout count (see Known limits). |
| 8 | Turn the route off | Laptop helper stops; gaming PC's normal playback is unaffected. |

To compare quality (spec §4.3): record the gaming PC output with any loopback recorder while playing
the same file (a) directly on the gaming PC and (b) on the laptop through the route, then compare level,
spectrum and a null test after aligning. At 100% volume with "No format conversion", the samples given
to Windows are the laptop's mix samples unchanged; any difference comes from the two machines' mixers
and devices.

## Known limits

- **Clock drift:** the two machines' audio clocks differ slightly. The buffer absorbs it, but at a
  typical 20–100 ppm mismatch expect one short dropout or one skip roughly every 10–60 minutes (the
  dashboard counts them). Proper drift correction (WASAPI rate adjustment) is planned once test 7
  shows the real numbers.
- Transport is TCP through the encrypted peer link: on a lossy Wi-Fi network a retransmission can
  delay audio and cause a dropout. Wired or good 5 GHz Wi-Fi is recommended.
- Uncompressed: 48 kHz stereo float is about 3.1 Mbit/s.
- DRM-protected audio (some streaming apps) is silent in loopback capture; that is a Windows rule.
- Bluetooth headphones on the laptop: loopback captures the laptop's default playback device only.
