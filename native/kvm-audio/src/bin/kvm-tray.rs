// LAN KVM tray icon. The agent starts this and owns it:
//   agent -> tray (stdin, one JSON object per line):
//     {"icon":"local"|"remote"|"busy"|"problem","status":"...","canSwitch":bool,"canReturn":bool,"switchLabel":"...","resetAudio":bool,"edgeSwitch":bool|null,
//      "pcAudio":bool|null,"pcAudioLabel":"..."}
//   tray -> agent (stdout, one JSON object per line):
//     {"action":"switch"} | {"action":"return"} | {"action":"dashboard"} | {"action":"resetAudio"} | {"action":"edge"} | {"action":"pcAudio"}
//     {"event":"icon","ok":bool}   whether Windows accepted the icon
// When stdin closes (the agent stopped) the icon is removed and the tray exits.

#![windows_subsystem = "windows"]

use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu,
    DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, GetSystemMetrics, HICON, ICONINFO, MF_CHECKED, MF_GRAYED,
    MF_SEPARATOR, MF_STRING, MSG, PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW,
    SM_CXSMICON, SetForegroundWindow, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    TranslateMessage, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_DESTROY, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP,
    WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::{PCWSTR, w};

const WM_TRAY: u32 = WM_APP + 1;
const WM_STATE: u32 = WM_APP + 2;
const ID_SWITCH: usize = 2;
const ID_RETURN: usize = 3;
const ID_DASHBOARD: usize = 4;
const ID_RESET_AUDIO: usize = 5;
const ID_EDGE: usize = 6;
const ID_PC_AUDIO: usize = 7;

#[derive(Clone)]
struct State {
    icon: String,
    status: String,
    switch_label: String,
    can_switch: bool,
    can_return: bool,
    /// Offer "Reset mic and speaker" (the laptop).
    reset_audio: bool,
    /// "Switch at screen edges", ticked when on; None hides it.
    edge_switch: Option<bool>,
    /// The gaming PC's sound on the laptop, ticked when on; None hides it.
    pc_audio: Option<bool>,
    pc_audio_label: String,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static HWND_MAIN: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static ICON: AtomicIsize = AtomicIsize::new(0);
static ADDED: AtomicIsize = AtomicIsize::new(0);

fn send_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn send(action: &str) {
    send_line(&format!("{{\"action\":\"{action}\"}}"));
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A filled dot with a soft edge and a dark rim, so it reads on light and dark taskbars.
fn make_icon(kind: &str) -> HICON {
    let (r, g, b) = match kind {
        "remote" => (0x3d, 0xd6, 0x8c),
        "busy" => (0xf5, 0xb8, 0x3d),
        "problem" => (0xf0, 0x6a, 0x5e),
        _ => (0xa7, 0xb0, 0xba),
    };
    let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64);
    let n = size as usize;
    let c = (n as f32 - 1.0) / 2.0;
    let outer = n as f32 * 0.44;
    let rim = (n as f32 / 16.0).max(1.0);
    let mut px = vec![0u8; n * n * 4];
    for y in 0..n {
        for x in 0..n {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let a = (outer + 0.5 - d).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let rim_mix = ((d - (outer - rim)) / rim).clamp(0.0, 1.0) * 0.55;
            let mix = |v: u8| ((v as f32) * (1.0 - rim_mix) + 20.0 * rim_mix) as u8;
            let i = (y * n + x) * 4;
            px[i] = mix(b);
            px[i + 1] = mix(g);
            px[i + 2] = mix(r);
            px[i + 3] = (a * 255.0) as u8;
        }
    }
    unsafe {
        let color = CreateBitmap(size, size, 1, 32, Some(px.as_ptr() as *const _));
        let mask_bits = vec![0u8; n.div_ceil(16) * 2 * n];
        let mask = CreateBitmap(size, size, 1, 1, Some(mask_bits.as_ptr() as *const _));
        let info = ICONINFO { fIcon: true.into(), xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
        let icon = CreateIconIndirect(&info).unwrap_or_default();
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
        icon
    }
}

fn notify_data(hwnd: HWND, state: &State, icon: HICON) -> NOTIFYICONDATAW {
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: icon,
        ..Default::default()
    };
    let tip: Vec<u16> = format!("LAN KVM: {}", state.status).encode_utf16().take(nid.szTip.len() - 1).collect();
    nid.szTip[..tip.len()].copy_from_slice(&tip);
    nid
}

/// Shows the current state, adding the icon the first time (and again after Explorer restarts).
fn refresh(hwnd: HWND, readd: bool) {
    let Some(state) = STATE.lock().unwrap().clone() else { return };
    let icon = make_icon(&state.icon);
    let nid = notify_data(hwnd, &state, icon);
    unsafe {
        if readd || ADDED.load(Ordering::SeqCst) == 0 {
            let ok = Shell_NotifyIconW(NIM_ADD, &nid).as_bool();
            if ok {
                ADDED.store(1, Ordering::SeqCst);
            }
            send_line(&format!("{{\"event\":\"icon\",\"ok\":{ok}}}"));
        } else {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &nid);
        }
        let old = ICON.swap(icon.0 as isize, Ordering::SeqCst);
        if old != 0 {
            let _ = DestroyIcon(HICON(old as *mut _));
        }
    }
}

fn show_menu(hwnd: HWND) {
    let Some(state) = STATE.lock().unwrap().clone() else { return };
    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        let status = wide(&state.status);
        let _ = AppendMenuW(menu, MF_STRING | MF_GRAYED, 1, PCWSTR(status.as_ptr()));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let switch_label = wide(&state.switch_label);
        if !state.switch_label.is_empty() {
            let flags = if state.can_switch { MF_STRING } else { MF_STRING | MF_GRAYED };
            let _ = AppendMenuW(menu, flags, ID_SWITCH, PCWSTR(switch_label.as_ptr()));
        }
        let flags = if state.can_return { MF_STRING } else { MF_STRING | MF_GRAYED };
        let _ = AppendMenuW(menu, flags, ID_RETURN, w!("Return to Gaming PC"));
        if let Some(on) = state.edge_switch {
            let flags = if on { MF_STRING | MF_CHECKED } else { MF_STRING };
            let _ = AppendMenuW(menu, flags, ID_EDGE, w!("Switch at screen edges"));
        }
        let pc_audio_label = wide(&state.pc_audio_label);
        if let Some(on) = state.pc_audio.filter(|_| !state.pc_audio_label.is_empty()) {
            let flags = if on { MF_STRING | MF_CHECKED } else { MF_STRING };
            let _ = AppendMenuW(menu, flags, ID_PC_AUDIO, PCWSTR(pc_audio_label.as_ptr()));
        }
        if state.reset_audio {
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
            let _ = AppendMenuW(menu, MF_STRING, ID_RESET_AUDIO, w!("Reset mic and speaker"));
        }
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_STRING, ID_DASHBOARD, w!("Open dashboard"));
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        // Without this the menu does not close when you click elsewhere.
        let _ = SetForegroundWindow(hwnd);
        let id = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, None, hwnd, None);
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        match id.0 as usize {
            ID_SWITCH => send("switch"),
            ID_RETURN => send("return"),
            ID_DASHBOARD => send("dashboard"),
            ID_RESET_AUDIO => send("resetAudio"),
            ID_EDGE => send("edge"),
            ID_PC_AUDIO => send("pcAudio"),
            _ => {}
        }
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            match lparam.0 as u32 {
                WM_LBUTTONUP => send("dashboard"),
                WM_RBUTTONUP => show_menu(hwnd),
                _ => {}
            }
            LRESULT(0)
        }
        WM_STATE => {
            refresh(hwnd, false);
            LRESULT(0)
        }
        WM_CLOSE => {
            if let Some(state) = STATE.lock().unwrap().clone() {
                let nid = notify_data(hwnd, &state, HICON::default());
                unsafe {
                    let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
                }
            }
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        m if m != 0 && m == TASKBAR_CREATED.load(Ordering::SeqCst) => {
            refresh(hwnd, true);
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn parse(line: &str) -> Option<State> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(State {
        icon: text("icon"),
        status: text("status"),
        switch_label: text("switchLabel"),
        can_switch: v.get("canSwitch").and_then(|x| x.as_bool()).unwrap_or(false),
        can_return: v.get("canReturn").and_then(|x| x.as_bool()).unwrap_or(false),
        reset_audio: v.get("resetAudio").and_then(|x| x.as_bool()).unwrap_or(false),
        edge_switch: v.get("edgeSwitch").and_then(|x| x.as_bool()),
        pc_audio: v.get("pcAudio").and_then(|x| x.as_bool()),
        pc_audio_label: text("pcAudioLabel"),
    })
}

fn main() {
    unsafe {
        let instance = GetModuleHandleW(None).expect("module handle");
        let class = w!("LanKvmTray");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::SeqCst);
        // A plain window that is never shown: it receives the icon's clicks.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("LAN KVM"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .expect("tray window");
        HWND_MAIN.store(hwnd.0 as isize, Ordering::SeqCst);

        std::thread::spawn(|| {
            let post = |msg: u32| {
                let hwnd = HWND(HWND_MAIN.load(Ordering::SeqCst) as *mut _);
                let _ = PostMessageW(Some(hwnd), msg, WPARAM(0), LPARAM(0));
            };
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if let Some(state) = parse(&line) {
                    *STATE.lock().unwrap() = Some(state);
                    post(WM_STATE);
                }
            }
            post(WM_CLOSE);
        });

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
