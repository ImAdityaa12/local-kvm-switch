//! kvm-display: monitor input and display layout for LAN KVM Switcher. One command per run, one
//! JSON line on stdout ({"ok":true,...} or {"ok":false,"error":"..."}), exit code 0 or 1.
//!
//!   kvm-display monitor probe              which control paths answer, and the current input
//!   kvm-display monitor get                current input (VCP 0x60)
//!   kvm-display monitor set hdmi1|hdmi2    switch input, then read it back
//!   kvm-display topology get               this PC's display layout (extend, internal, ...)
//!   kvm-display topology set extend|internal
//!
//! Monitor control speaks standard DDC/CI (MCCS VCP 0x60: 0x11 HDMI 1, 0x12 HDMI 2) over one of:
//!   usb   the monitor's own USB connection: the VIA "billboard" device (2109:8886) Gigabyte
//!         monitors expose, through the libusb-win32 driver OSD Sidekick installs. DDC/CI messages
//!         travel in vendor control transfers (request format from community reverse engineering
//!         of OSD Sidekick; see docs/feasibility-display-switching.md). It works whatever input
//!         the monitor is showing, so it is tried first.
//!   hdmi  DDC/CI over the video cable (Dxva2), which may only work while this PC's input is shown.
//! Only input 0x60 is ever written, and only the two HDMI values.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_TOPOLOGY_CLONE, DISPLAYCONFIG_TOPOLOGY_EXTEND,
    DISPLAYCONFIG_TOPOLOGY_EXTERNAL, DISPLAYCONFIG_TOPOLOGY_ID, DISPLAYCONFIG_TOPOLOGY_INTERNAL, DestroyPhysicalMonitors,
    GetCapabilitiesStringLength, GetDisplayConfigBufferSizes, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, PHYSICAL_MONITOR, QDC_DATABASE_CURRENT,
    QueryDisplayConfig, SDC_APPLY, SDC_TOPOLOGY_EXTEND, SDC_TOPOLOGY_INTERNAL, SetDisplayConfig, SetVCPFeature,
};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::core::{BOOL, PCSTR, w};

const VCP_INPUT: u8 = 0x60;
const HDMI1: u32 = 0x11;
const HDMI2: u32 = 0x12;
/// How long to wait for the monitor to report the new input after a switch.
const READ_BACK_FOR: Duration = Duration::from_secs(4);

fn input_name(v: u32) -> Option<&'static str> {
    match v & 0xff {
        0x11 => Some("hdmi1"),
        0x12 => Some("hdmi2"),
        0x0f => Some("dp1"),
        _ => None,
    }
}

fn json_str(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

fn out(fields: &[(&str, String)]) {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
    println!("{{\"ok\":true,{}}}", body.join(","));
}

// ---- DDC/CI over USB (VIA billboard, libusb-win32) ----

mod usb {
    use super::*;

    pub const VID: u16 = 0x2109;
    pub const PID: u16 = 0x8886;

    /// DDC/CI "get VCP" as the billboard bridge takes it (no checksum; the bridge adds it).
    pub fn get_request(code: u8) -> [u8; 5] {
        [0x6e, 0x51, 0x82, 0x01, code]
    }

    /// DDC/CI "set VCP" with a 16-bit value.
    pub fn set_request(code: u8, value: u16) -> [u8; 7] {
        [0x6e, 0x51, 0x84, 0x03, code, (value >> 8) as u8, value as u8]
    }

    /// Reads a "VCP feature reply" (6F 6E 88 02 <result> <code> <type> <max hi lo> <cur hi lo> <chk>).
    pub fn parse_reply(code: u8, b: &[u8]) -> Result<u32, String> {
        if b.len() < 11 || b[3] != 0x02 || b[5] != code {
            return Err(format!("unexpected reply {}", hex(b)));
        }
        if b[4] != 0x00 {
            return Err(format!("the monitor does not support VCP 0x{code:02X} (result {:#04x})", b[4]));
        }
        Ok(((b[9] as u32) << 8) | b[10] as u32)
    }

    pub fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
    }

    type UsbInit = unsafe extern "C" fn();
    type UsbFind = unsafe extern "C" fn() -> i32;
    type UsbGetBusses = unsafe extern "C" fn() -> *mut c_void;
    type UsbOpen = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    type UsbClose = unsafe extern "C" fn(*mut c_void) -> i32;
    type UsbControlMsg = unsafe extern "C" fn(*mut c_void, i32, i32, i32, i32, *mut u8, i32, i32) -> i32;

    // libusb-win32 0.1 structs (x64): usb_bus { next, prev, dirname[512], devices, ... } and
    // usb_device { next, prev, filename[512], bus, descriptor { ..., idVendor @+8, idProduct @+10 } }.
    const PATH_MAX: usize = 512;
    const BUS_DEVICES: usize = 16 + PATH_MAX;
    const DEV_DESCRIPTOR: usize = 16 + PATH_MAX + 8;

    pub struct Monitor {
        handle: *mut c_void,
        close: UsbClose,
        control: UsbControlMsg,
    }

    unsafe fn sym<T>(lib: windows::Win32::Foundation::HMODULE, name: &[u8]) -> Result<T, String> {
        let p = unsafe { GetProcAddress(lib, PCSTR(name.as_ptr())) }.ok_or("libusb0.dll is missing a function")?;
        Ok(unsafe { std::mem::transmute_copy(&p) })
    }

    impl Monitor {
        /// Opens the billboard device, or says why it cannot.
        pub fn open() -> Result<Monitor, String> {
            let lib = unsafe { LoadLibraryW(w!("libusb0.dll")) }
                .map_err(|_| "libusb0.dll not found (install OSD Sidekick, which brings the libusb-win32 driver)".to_string())?;
            unsafe {
                let init: UsbInit = sym(lib, b"usb_init\0")?;
                let find_busses: UsbFind = sym(lib, b"usb_find_busses\0")?;
                let find_devices: UsbFind = sym(lib, b"usb_find_devices\0")?;
                let get_busses: UsbGetBusses = sym(lib, b"usb_get_busses\0")?;
                let open: UsbOpen = sym(lib, b"usb_open\0")?;
                let close: UsbClose = sym(lib, b"usb_close\0")?;
                let control: UsbControlMsg = sym(lib, b"usb_control_msg\0")?;
                init();
                find_busses();
                find_devices();
                let mut bus = get_busses() as *const u8;
                while !bus.is_null() {
                    let mut dev = *(bus.add(BUS_DEVICES) as *const *const u8);
                    while !dev.is_null() {
                        let vid = std::ptr::read_unaligned(dev.add(DEV_DESCRIPTOR + 8) as *const u16);
                        let pid = std::ptr::read_unaligned(dev.add(DEV_DESCRIPTOR + 10) as *const u16);
                        if vid == VID && pid == PID {
                            let handle = open(dev as *mut c_void);
                            if handle.is_null() {
                                return Err("the monitor's USB device would not open".into());
                            }
                            return Ok(Monitor { handle, close, control });
                        }
                        dev = *(dev as *const *const u8);
                    }
                    bus = *(bus as *const *const u8);
                }
            }
            Err("the monitor's USB device (2109:8886) is not connected to this PC, or has no libusb-win32 driver".into())
        }

        fn write(&self, msg: &[u8]) -> Result<(), String> {
            let mut buf = msg.to_vec();
            let n = unsafe { (self.control)(self.handle, 0x40, 178, 0, 0, buf.as_mut_ptr(), buf.len() as i32, 1000) };
            std::thread::sleep(Duration::from_millis(50));
            if n == buf.len() as i32 { Ok(()) } else { Err(format!("USB write failed ({n})")) }
        }

        pub fn get(&self, code: u8) -> Result<u32, String> {
            self.write(&get_request(code))?;
            let mut buf = [0u8; 12];
            let n = unsafe { (self.control)(self.handle, 0xc0, 162, 0, 111, buf.as_mut_ptr(), buf.len() as i32, 1000) };
            std::thread::sleep(Duration::from_millis(50));
            if n < 11 {
                return Err(format!("USB read failed ({n})"));
            }
            parse_reply(code, &buf)
        }

        pub fn set(&self, code: u8, value: u16) -> Result<(), String> {
            self.write(&set_request(code, value))
        }
    }

    impl Drop for Monitor {
        fn drop(&mut self) {
            unsafe { (self.close)(self.handle) };
        }
    }
}

// ---- DDC/CI over the video cable (Dxva2) ----

mod hdmi {
    use super::*;

    unsafe extern "system" fn collect(hm: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        unsafe { (*(data.0 as *mut Vec<HMONITOR>)).push(hm) };
        true.into()
    }

    /// Physical monitors on this PC's desktop that answer an input-source read, with the value read.
    pub struct Monitors(Vec<PHYSICAL_MONITOR>);

    impl Monitors {
        pub fn find() -> Monitors {
            let mut hms: Vec<HMONITOR> = Vec::new();
            unsafe {
                let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut hms as *mut _ as isize));
            }
            let mut found = Vec::new();
            for hm in hms {
                let mut n = 0u32;
                if unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(hm, &mut n) }.is_err() || n == 0 {
                    continue;
                }
                let mut pm = vec![PHYSICAL_MONITOR::default(); n as usize];
                if unsafe { GetPhysicalMonitorsFromHMONITOR(hm, &mut pm) }.is_err() {
                    continue;
                }
                for p in pm {
                    let mut len = 0u32;
                    // Internal laptop panels do not speak DDC/CI.
                    if unsafe { GetCapabilitiesStringLength(p.hPhysicalMonitor, &mut len) } != 0 {
                        found.push(p);
                    } else {
                        let _ = unsafe { DestroyPhysicalMonitors(&[p]) };
                    }
                }
            }
            Monitors(found)
        }

        pub fn first(&self) -> Option<&PHYSICAL_MONITOR> {
            self.0.first()
        }

        pub fn get(p: &PHYSICAL_MONITOR, code: u8) -> Result<u32, String> {
            let mut cur = 0u32;
            if unsafe { GetVCPFeatureAndVCPFeatureReply(p.hPhysicalMonitor, code, None, &mut cur, None) } != 0 {
                Ok(cur)
            } else {
                Err(format!("no DDC/CI reply for VCP 0x{code:02X}"))
            }
        }

        pub fn set(p: &PHYSICAL_MONITOR, code: u8, value: u32) -> Result<(), String> {
            if unsafe { SetVCPFeature(p.hPhysicalMonitor, code, value) } != 0 {
                Ok(())
            } else {
                Err(format!("DDC/CI set VCP 0x{code:02X} failed"))
            }
        }
    }

    impl Drop for Monitors {
        fn drop(&mut self) {
            if !self.0.is_empty() {
                let _ = unsafe { DestroyPhysicalMonitors(&self.0) };
            }
        }
    }
}

// ---- commands ----

fn monitor_probe() -> Result<(), String> {
    let mut fields = Vec::new();
    match usb::Monitor::open().and_then(|m| m.get(VCP_INPUT)) {
        Ok(v) => {
            fields.push(("usb", "true".to_string()));
            fields.push(("input", input_name(v).map_or("null".into(), json_str)));
            fields.push(("raw", v.to_string()));
        }
        Err(e) => {
            fields.push(("usb", "false".to_string()));
            fields.push(("usbError", json_str(&e)));
        }
    }
    let mons = hdmi::Monitors::find();
    let hdmi_input = mons.first().and_then(|p| hdmi::Monitors::get(p, VCP_INPUT).ok());
    fields.push(("hdmi", hdmi_input.is_some().to_string()));
    if !fields.iter().any(|(k, _)| *k == "input") {
        fields.push(("input", hdmi_input.and_then(input_name).map_or("null".into(), json_str)));
    }
    out(&fields);
    Ok(())
}

/// Reads the input over USB, else over HDMI.
fn read_input(usb_mon: Option<&usb::Monitor>, mons: &hdmi::Monitors) -> Option<(u32, &'static str)> {
    if let Some(v) = usb_mon.and_then(|m| m.get(VCP_INPUT).ok()) {
        return Some((v, "usb"));
    }
    mons.first().and_then(|p| hdmi::Monitors::get(p, VCP_INPUT).ok()).map(|v| (v, "hdmi"))
}

fn monitor_get() -> Result<(), String> {
    let usb_mon = usb::Monitor::open().ok();
    let mons = hdmi::Monitors::find();
    let (v, via) = read_input(usb_mon.as_ref(), &mons).ok_or("the monitor did not answer over USB or HDMI DDC/CI")?;
    out(&[("input", input_name(v).map_or("null".into(), json_str)), ("raw", v.to_string()), ("via", json_str(via))]);
    Ok(())
}

fn monitor_set(target: &str) -> Result<(), String> {
    let value = match target {
        "hdmi1" => HDMI1,
        "hdmi2" => HDMI2,
        _ => return Err("monitor set takes hdmi1 or hdmi2".into()),
    };
    let start = Instant::now();
    let usb_mon = usb::Monitor::open();
    let mons = hdmi::Monitors::find();
    let via = match &usb_mon {
        Ok(m) => m.set(VCP_INPUT, value as u16).map(|_| "usb"),
        Err(usb_err) => match mons.first() {
            Some(p) => hdmi::Monitors::set(p, VCP_INPUT, value).map(|_| "hdmi"),
            None => Err(format!("{usb_err}; and no monitor answers DDC/CI over the video cable")),
        },
    }?;
    // The monitor reports its selected input; it may take a moment after switching.
    let mut read_back: Option<u32> = None;
    while start.elapsed() < READ_BACK_FOR {
        std::thread::sleep(Duration::from_millis(300));
        if let Some((v, _)) = read_input(usb_mon.as_ref().ok(), &mons) {
            read_back = Some(v);
            if v & 0xff == value {
                break;
            }
        }
    }
    out(&[
        ("sent", json_str(target)),
        ("via", json_str(via)),
        ("readBack", read_back.and_then(input_name).map_or("null".into(), json_str)),
        ("raw", read_back.map_or("null".into(), |v| v.to_string())),
        ("ms", start.elapsed().as_millis().to_string()),
    ]);
    Ok(())
}

fn topology_now() -> Result<(DISPLAYCONFIG_TOPOLOGY_ID, u32), String> {
    let (mut np, mut nm) = (0u32, 0u32);
    let rc = unsafe { GetDisplayConfigBufferSizes(QDC_DATABASE_CURRENT, &mut np, &mut nm) };
    if rc.0 != 0 {
        return Err(format!("GetDisplayConfigBufferSizes failed ({})", rc.0));
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
    let mut topo = DISPLAYCONFIG_TOPOLOGY_ID::default();
    let rc = unsafe { QueryDisplayConfig(QDC_DATABASE_CURRENT, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), Some(&mut topo)) };
    if rc.0 != 0 {
        return Err(format!("QueryDisplayConfig failed ({})", rc.0));
    }
    Ok((topo, np))
}

fn topology_name(t: DISPLAYCONFIG_TOPOLOGY_ID) -> &'static str {
    match t {
        DISPLAYCONFIG_TOPOLOGY_INTERNAL => "internal",
        DISPLAYCONFIG_TOPOLOGY_CLONE => "clone",
        DISPLAYCONFIG_TOPOLOGY_EXTEND => "extend",
        DISPLAYCONFIG_TOPOLOGY_EXTERNAL => "external",
        _ => "unknown",
    }
}

fn topology_get() -> Result<(), String> {
    let (t, paths) = topology_now()?;
    out(&[("topology", json_str(topology_name(t))), ("paths", paths.to_string())]);
    Ok(())
}

fn topology_set(target: &str) -> Result<(), String> {
    let (flag, want) = match target {
        "extend" => (SDC_TOPOLOGY_EXTEND, DISPLAYCONFIG_TOPOLOGY_EXTEND),
        "internal" => (SDC_TOPOLOGY_INTERNAL, DISPLAYCONFIG_TOPOLOGY_INTERNAL),
        _ => return Err("topology set takes extend or internal".into()),
    };
    let start = Instant::now();
    let rc = unsafe { SetDisplayConfig(None, None, SDC_APPLY | flag) };
    if rc != 0 {
        return Err(match rc {
            5 => "Windows refused the display change (no access to the desktop; is the agent running in your session?)".into(),
            1610 => "Windows has no saved layout for that (connect the monitor and choose the layout once with Win+P)".into(),
            _ => format!("SetDisplayConfig failed ({rc})"),
        });
    }
    // Confirm from what Windows reports, not from the call returning.
    loop {
        let (t, paths) = topology_now()?;
        if t == want {
            out(&[("topology", json_str(topology_name(t))), ("paths", paths.to_string()), ("ms", start.elapsed().as_millis().to_string())]);
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(5) {
            return Err(format!("Windows still reports the {} layout", topology_name(t)));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn run(args: &[String]) -> Result<(), String> {
    match (args.first().map(String::as_str), args.get(1).map(String::as_str), args.get(2).map(String::as_str)) {
        (Some("monitor"), Some("probe"), None) => monitor_probe(),
        (Some("monitor"), Some("get"), None) => monitor_get(),
        (Some("monitor"), Some("set"), Some(t)) => monitor_set(t),
        (Some("topology"), Some("get"), None) => topology_get(),
        (Some("topology"), Some("set"), Some(t)) => topology_set(t),
        _ => Err("usage: kvm-display monitor probe|get|set hdmi1|hdmi2, or topology get|set extend|internal".into()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        println!("{{\"ok\":false,\"error\":{}}}", json_str(&e));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::usb::*;

    #[test]
    fn requests_match_the_bridge_format() {
        assert_eq!(get_request(0x60), [0x6e, 0x51, 0x82, 0x01, 0x60]);
        assert_eq!(set_request(0x60, 0x11), [0x6e, 0x51, 0x84, 0x03, 0x60, 0x00, 0x11]);
    }

    #[test]
    fn replies_read_as_recorded_from_the_g24f_2() {
        // Recorded on the real monitor over USB (docs/feasibility-display-switching.md, F6).
        let input = [0x6f, 0x6e, 0x88, 0x02, 0x00, 0x60, 0x00, 0x00, 0xff, 0x00, 0x12, 0x39];
        assert_eq!(parse_reply(0x60, &input), Ok(0x12));
        let brightness = [0x6f, 0x6e, 0x88, 0x02, 0x00, 0x10, 0x01, 0x00, 0x64, 0x00, 0x1c, 0xdd];
        assert_eq!(parse_reply(0x10, &brightness), Ok(0x1c));
        assert!(parse_reply(0x60, &brightness).is_err(), "a reply for another code is rejected");
        let mut unsupported = input;
        unsupported[4] = 0x01;
        assert!(parse_reply(0x60, &unsupported).is_err());
        assert!(parse_reply(0x60, &[0; 4]).is_err());
    }
}
