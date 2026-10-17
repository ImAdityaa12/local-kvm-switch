# Phase 3: the gaming PC microphone on the laptop

Your IEM's microphone stays plugged into the gaming PC. Its sound goes over the encrypted link to the
laptop, where it plays into VB-CABLE, and apps such as Discord record it as a normal microphone.

```text
IEM mic → gaming PC (capture) → link → laptop → CABLE Input → CABLE Output → Discord
```

## 1. Set up the laptop (once)

1. Install VB-CABLE from https://vb-audio.com/Cable/: extract the zip, right-click
   `VBCABLE_Setup_x64.exe` → **Run as administrator** → **Install Driver**, then reboot. It is
   donationware (free for personal use; organisations need a licence).
2. The installer may make **CABLE Input** your default playback device. Set **Output** back to your
   speakers or headphones in Settings → System → Sound. Otherwise you hear nothing on the laptop, and
   the laptop-audio route refuses to start, because it would send your own voice back to your IEM.
3. Leaving **CABLE Output** as the default recording device is fine; it is the one apps should use.
4. Restart the laptop agent. The gaming PC dashboard then shows "Laptop microphone endpoint: CABLE
   Output (VB-Audio Virtual Cable)".

## 2. Use it

On the gaming PC dashboard, under **Gaming PC microphone to Laptop**:

1. **Microphone on this PC**: choose your IEM's microphone (often the USB DAC or the 3.5 mm input).
2. Turn the route on. **Streaming** means audio is arriving on the laptop.
3. **Mute** works on the gaming PC: while muted, only silence leaves the PC.
4. **Level on the laptop** turns the mic down on the laptop side (it never boosts).
5. In Discord on the laptop: Settings → Voice & Video → Input Device → **CABLE Output (VB-Audio
   Virtual Cable)**. Turn off Discord's noise suppression and echo cancellation if you want the mic
   untouched; leave them on if you prefer how they sound.

## 3. Test plan

| # | Do | Expect |
| --- | --- | --- |
| 1 | Speak; watch the level meter on the gaming PC | Meter moves with your voice. |
| 2 | Windows Sound settings on the laptop → Recording → CABLE Output | Its level bar moves when you speak. |
| 3 | Discord → Voice & Video → **Let's Check** | You hear yourself clearly, without crackle or clipping. |
| 4 | Record 30 s in Windows Voice Recorder on the laptop with CABLE Output | Clear, normal level, no dropouts. |
| 5 | Mute on the gaming PC dashboard | Discord's input meter goes flat. |
| 6 | Unplug the IEM mic on the gaming PC | Route stops: "The microphone device is not available". It does **not** switch to another mic. |
| 7 | Unplug the laptop's network for 5 s | "Reconnecting", then "Streaming" again once the link returns. |
| 8 | Turn on both audio routes together | Both stream; you do not hear your own voice from the laptop audio route. |

## Known limits

- Same clock-drift limit as Phase 2: an occasional short dropout or skip over long sessions.
- VB-CABLE adds no processing itself, but Windows and Discord can. "No format conversion" on the
  dashboard is about our part of the path only.
- If you rename VB-CABLE's devices in Windows, the laptop will not find them (it looks for
  "CABLE Input" and "CABLE Output").
