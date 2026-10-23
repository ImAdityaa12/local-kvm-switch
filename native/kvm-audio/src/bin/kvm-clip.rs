// LAN KVM clipboard helper. The agent starts this and owns it:
//   clip -> agent (stdout, one JSON object per line):
//     {"event":"ready"}
//     {"event":"copied","content":{...}}       something new was copied here
//     {"event":"skipped","reason":"private"}  a password manager asked for it not to be shared
//     {"event":"set","ok":bool,"error":"..."}  answer to a set
//   agent -> clip (stdin, one JSON object per line):
//     {"set":{...}}                            put the other machine's copy on this clipboard
// Content: {"text":"...","html":B64,"rtf":B64,"png":B64,"dib":B64,"files":["C:\\..."],"tooLarge":["dib"]}.
// What this helper puts on the clipboard carries a marker format, so it is not reported back.
// When stdin closes (the agent stopped) the helper exits.

#![windows_subsystem = "windows"]

use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, Ordering};

use serde_json::{Map, Value, json};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::Shell::{DROPFILES, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE, KillTimer, MSG,
    PostMessageW, PostQuitMessage, RegisterClassW, SetTimer, TranslateMessage, WINDOW_EX_STYLE, WM_APP,
    WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY, WM_TIMER, WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::{PCWSTR, w};

const WM_SET: u32 = WM_APP + 1;
const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;
const DEBOUNCE_TIMER: usize = 1;
/// Apps often set the clipboard several times in a row; read it once they are done.
const DEBOUNCE_MS: u32 = 150;
/// Larger items are left out (a 4K screenshot as a bitmap is about 33 MB).
const MAX_ITEM: usize = 48 * 1024 * 1024;

static HWND_MAIN: AtomicIsize = AtomicIsize::new(0);
static PENDING: Mutex<Option<Value>> = Mutex::new(None);

struct Formats {
    marker: u32,
    html: u32,
    rtf: u32,
    png: u32,
    drop_effect: u32,
    exclude: u32,
    history: u32,
    cloud: u32,
}

fn formats() -> Formats {
    unsafe {
        Formats {
            marker: RegisterClipboardFormatW(w!("LanKvmFromPeer")),
            html: RegisterClipboardFormatW(w!("HTML Format")),
            rtf: RegisterClipboardFormatW(w!("Rich Text Format")),
            png: RegisterClipboardFormatW(w!("PNG")),
            drop_effect: RegisterClipboardFormatW(w!("Preferred DropEffect")),
            // Password managers set these so clipboard tools leave their copies alone.
            exclude: RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
            history: RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")),
            cloud: RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")),
        }
    }
}

fn send(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&b| b == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The clipboard is shared by every app; another one may hold it for a moment.
fn open(hwnd: HWND) -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(Some(hwnd)) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

fn has(format: u32) -> bool {
    unsafe { IsClipboardFormatAvailable(format) }.is_ok()
}

/// The bytes of one format, while the clipboard is open.
fn bytes(format: u32) -> Option<Vec<u8>> {
    unsafe {
        let h = GetClipboardData(format).ok()?;
        let g = HGLOBAL(h.0);
        let size = GlobalSize(g);
        let p = GlobalLock(g) as *const u8;
        if p.is_null() {
            return None;
        }
        let v = std::slice::from_raw_parts(p, size).to_vec();
        let _ = GlobalUnlock(g);
        Some(v)
    }
}

fn dword_is_zero(format: u32) -> bool {
    has(format) && bytes(format).is_some_and(|b| b.len() >= 4 && b[..4] == [0, 0, 0, 0])
}

fn read_text() -> Option<String> {
    let b = bytes(CF_UNICODETEXT)?;
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

fn read_files() -> Vec<String> {
    let Ok(h) = (unsafe { GetClipboardData(CF_HDROP) }) else { return vec![] };
    let drop = HDROP(h.0);
    let n = unsafe { DragQueryFileW(drop, u32::MAX, None) };
    (0..n)
        .filter_map(|i| {
            let len = unsafe { DragQueryFileW(drop, i, None) } as usize;
            let mut buf = vec![0u16; len + 1];
            let got = unsafe { DragQueryFileW(drop, i, Some(&mut buf)) } as usize;
            (got > 0).then(|| String::from_utf16_lossy(&buf[..got]))
        })
        .collect()
}

/// Reads what was just copied. None when the copy came from this helper.
fn read(hwnd: HWND, f: &Formats) -> Option<Value> {
    if !open(hwnd) {
        return Some(json!({"event": "error", "message": "Another app is holding the clipboard"}));
    }
    let result = (|| {
        if has(f.marker) {
            return None;
        }
        if has(f.exclude) || dword_is_zero(f.history) || dword_is_zero(f.cloud) {
            return Some(json!({"event": "skipped", "reason": "private"}));
        }
        let mut c = Map::new();
        let mut too_large = vec![];
        if has(CF_HDROP) {
            let files = read_files();
            if !files.is_empty() {
                c.insert("files".into(), json!(files));
            }
        }
        if has(CF_UNICODETEXT)
            && let Some(t) = read_text()
        {
            if t.len() <= MAX_ITEM {
                c.insert("text".into(), json!(t));
            } else {
                too_large.push("text");
            }
        }
        for (key, format) in [("html", f.html), ("rtf", f.rtf), ("png", f.png), ("dib", CF_DIB)] {
            if !has(format) {
                continue;
            }
            match bytes(format) {
                Some(b) if b.len() <= MAX_ITEM => {
                    // HTML Format and RTF end with a NUL that is not part of the text.
                    let end = if key == "html" || key == "rtf" { b.iter().position(|&x| x == 0).unwrap_or(b.len()) } else { b.len() };
                    c.insert(key.into(), json!(b64_encode(&b[..end])));
                }
                Some(_) => too_large.push(key),
                None => {}
            }
        }
        if !too_large.is_empty() {
            c.insert("tooLarge".into(), json!(too_large));
        }
        Some(json!({"event": "copied", "content": c}))
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

/// Copies `data` into a movable global block for SetClipboardData, which then owns it.
fn put(format: u32, data: &[u8]) -> bool {
    unsafe {
        let Ok(g) = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1)) else { return false };
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(g));
            return false;
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
        let _ = GlobalUnlock(g);
        if SetClipboardData(format, Some(HANDLE(g.0))).is_err() {
            let _ = GlobalFree(Some(g));
            return false;
        }
        true
    }
}

fn drop_files(paths: &[String]) -> Vec<u8> {
    let header = DROPFILES { pFiles: std::mem::size_of::<DROPFILES>() as u32, pt: POINT::default(), fNC: false.into(), fWide: true.into() };
    let mut out = unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, std::mem::size_of::<DROPFILES>()) }.to_vec();
    for p in paths {
        for u in wide(p) {
            out.extend_from_slice(&u.to_le_bytes());
        }
    }
    out.extend_from_slice(&[0, 0]);
    out
}

fn write(hwnd: HWND, f: &Formats, c: &Value) -> Result<(), String> {
    let b64 = |k: &str| c.get(k).and_then(|v| v.as_str()).and_then(b64_decode);
    if !open(hwnd) {
        return Err("Another app is holding the clipboard".into());
    }
    let mut ok = unsafe { EmptyClipboard() }.is_ok();
    if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
        let units: Vec<u8> = wide(t).iter().flat_map(|u| u.to_le_bytes()).collect();
        ok &= put(CF_UNICODETEXT, &units);
    }
    for (key, format) in [("html", f.html), ("rtf", f.rtf)] {
        if let Some(mut b) = b64(key) {
            b.push(0);
            ok &= put(format, &b);
        }
    }
    for (key, format) in [("png", f.png), ("dib", CF_DIB)] {
        if let Some(b) = b64(key) {
            ok &= put(format, &b);
        }
    }
    if let Some(files) = c.get("files").and_then(|v| v.as_array()) {
        let paths: Vec<String> = files.iter().filter_map(|p| p.as_str().map(String::from)).collect();
        if !paths.is_empty() {
            ok &= put(CF_HDROP, &drop_files(&paths));
            // Paste copies; a cut on the other machine never moves its files from here.
            ok &= put(f.drop_effect, &1u32.to_le_bytes());
        }
    }
    ok &= put(f.marker, &[1]);
    unsafe {
        let _ = CloseClipboard();
    }
    if ok { Ok(()) } else { Err("Windows did not take every format".into()) }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            unsafe { SetTimer(Some(hwnd), DEBOUNCE_TIMER, DEBOUNCE_MS, None) };
            LRESULT(0)
        }
        WM_TIMER if wparam.0 == DEBOUNCE_TIMER => {
            unsafe {
                let _ = KillTimer(Some(hwnd), DEBOUNCE_TIMER);
            }
            if let Some(v) = read(hwnd, &formats()) {
                send(v);
            }
            LRESULT(0)
        }
        WM_SET => {
            if let Some(c) = PENDING.lock().unwrap().take() {
                match write(hwnd, &formats(), &c) {
                    Ok(()) => send(json!({"event": "set", "ok": true})),
                    Err(e) => send(json!({"event": "set", "ok": false, "error": e})),
                }
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn main() {
    unsafe {
        let instance = GetModuleHandleW(None).expect("module handle");
        let class = w!("LanKvmClip");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        // A message-only window: it is never shown and only hears about clipboard changes.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            PCWSTR::null(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        )
        .expect("clipboard window");
        HWND_MAIN.store(hwnd.0 as isize, Ordering::SeqCst);
        if let Err(e) = AddClipboardFormatListener(hwnd) {
            send(json!({"event": "error", "message": format!("Could not watch the clipboard: {e}")}));
            return;
        }

        std::thread::spawn(|| {
            let post = |msg: u32| {
                let hwnd = HWND(HWND_MAIN.load(Ordering::SeqCst) as *mut _);
                let _ = PostMessageW(Some(hwnd), msg, WPARAM(0), LPARAM(0));
            };
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(c) = v.get("set") {
                    *PENDING.lock().unwrap() = Some(c.clone());
                    post(WM_SET);
                }
            }
            post(WM_CLOSE);
        });
        send(json!({"event": "ready"}));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
