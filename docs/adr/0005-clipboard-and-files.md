# ADR 0005: Shared clipboard and each machine's drives on the other

Status: accepted; implemented, tested on one machine over a loopback link, two-machine tests pending
Date: 2026-10-23

## Context

The user wants every file and folder of each machine reachable from the other "in anything", and
whatever is copied on one machine pasteable on the other. Deskflow can share the clipboard, but only
while it runs (Laptop mode or edge switching) and only when the cursor crosses; its clipboard stays
off (`enableClipboard=false`).

## Decision

- **Files: the other machine's drives as one network drive letter**, chosen by the user over Windows
  file sharing (SMB, which would need the Windows password and port 445 open outside the paired link)
  and over a browser-only file list (which other apps cannot open from).
  - **rclone** serves the machine's local and removable drives as WebDAV on `127.0.0.1:24840`
    (combine backend, one folder per drive letter). Network drives are left out, so a machine never
    serves the other's drive back.
  - The other machine reaches it only through the peer link (stream target `files`, local listener
    `127.0.0.1:24841`) and mounts it with **rclone + WinFsp** (`--network-mode`, VFS cache `full`,
    write-back 1 s, directory cache 2 s; the server's 1 s).
  - **Password:** HMAC-SHA256(PSK, "lan-kvm files"), derived on both sides, never sent. It keeps other
    local Windows users off both loopback ports (closing for files the gap ADR 0003 notes for
    Deskflow). Passed to rclone in environment variables, not the command line.
  - Both rclone processes run as the signed-in user, so they open what that user can open.
  - Installed with winget (`npm run setup:files`): rclone is one program; WinFsp is a driver, which
    asks for admin once.
  - The drive is removed 20 s after the link drops: an unreachable WebDAV drive blocks every caller
    (Explorer, and a 56 s `existsSync` in testing).
  - **The agent never touches the drive synchronously.** The tunnel behind it runs on the agent's own
    event loop, so a blocking call on the drive waits for itself; Windows then cancels it (seen as
    `ECANCELED`). Drive letters are checked with async `access` and a time limit.
- **Clipboard: a native helper and one stream per copy.**
  - `kvm-clip` (`native/kvm-audio/src/bin/kvm-clip.rs`) listens with `AddClipboardFormatListener`
    (150 ms debounce) and reads Unicode text, HTML Format, Rich Text Format, PNG, CF_DIB and CF_HDROP.
    Items over 48 MB are left out. What it sets carries a private marker format, so it is never sent
    back.
  - **Private copies stay:** skipped when `ExcludeClipboardContentFromMonitorProcessing` is present
    or `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` is 0 (password managers set
    these).
  - Each copy crosses as gzipped JSON on its own stream (`clipboard` target), capped at 64 MB on the
    wire and 200 MB unpacked, validated field by field. Only the newest unsent copy is kept.
  - **Copied files cross as paths, not bytes.** `C:\x` on the gaming PC becomes `G:\C\x` on the
    laptop, and a file on the laptop's `G:` goes back as the gaming PC's own `C:\x`. Explorer then
    copies the file over the drive on paste. Paste always copies; a cut never moves the other
    machine's files. Paths with `..` are refused.
  - Content is never logged; the dashboard shows only what kind of thing crossed ("text", "2 files").
- **Streams both ways on the peer link.** The laptop never listens, so the gaming PC asks over the
  control session (`{t:"open", id, target}`) and the laptop dials a new PSK-authenticated connection
  back (`{t:"back", id}`). Only targets the laptop registered are served; unanswered asks time out
  after 10 s; at most 32 wait at once.
- **Each machine decides for itself**, saved in `settings.json`: *Share the clipboard* (send and
  take) and *Share this PC's drives* (serve). Both default to on.

## Consequences

- Two more native dependencies (rclone, WinFsp), installed per machine. Without WinFsp the machine
  can still serve its drives; without rclone it can neither serve nor mount. The dashboard says
  which is missing.
- Whoever holds the pairing key can read and write every local drive of a machine that shares them,
  as its user. Pairing already needed both people to confirm a code; turning off *Share this PC's
  drives* removes it.
- Large copies (screenshots) cross on every copy, even if never pasted; images up to 48 MB each.
