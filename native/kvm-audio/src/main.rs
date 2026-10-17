//! kvm-audio: the native audio helper for LAN KVM Switcher.
//!
//!   kvm-audio list
//!   kvm-audio send (--connect | --listen) ADDR [--device ID | --capture [ID] | --tone HZ] [--muted]
//!   kvm-audio play (--listen | --connect) ADDR [--device ID | --wav PATH --seconds N] [--volume 0.8] [--muted]
//!
//! send: --device loops back a playback device (laptop audio); --capture records a microphone.
//!
//! It is driven by the agent: JSON events on stdout, JSON commands on stdin
//! ({"cmd":"volume","value":0.5}, {"cmd":"mute","value":true}, {"cmd":"stop"}).
//! It never logs audio content.

mod devices;
mod dsp;
mod io;
mod jitter;
mod play;
mod send;
mod wire;

use io::{emit, emit_error, Control};
use std::net::SocketAddr;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn loopback_addr(s: Option<String>, what: &str) -> Result<SocketAddr, String> {
    let s = s.ok_or_else(|| format!("{what} is required"))?;
    let a: SocketAddr = s.parse().map_err(|_| format!("{what} must be ip:port"))?;
    // The helper only ever talks to its own agent's tunnel on this machine.
    if !a.ip().is_loopback() {
        return Err(format!("{what} must be a loopback address"));
    }
    Ok(a)
}

/// `--connect ADDR` or `--listen ADDR`, both loopback only.
fn link<T>(args: &[String], connect: fn(SocketAddr) -> T, listen: fn(SocketAddr) -> T) -> Result<T, String> {
    match (arg(args, "--connect"), arg(args, "--listen")) {
        (Some(c), None) => Ok(connect(loopback_addr(Some(c), "--connect")?)),
        (None, Some(l)) => Ok(listen(loopback_addr(Some(l), "--listen")?)),
        _ => Err("give exactly one of --connect or --listen".into()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(()) => 0,
        Err(e) => {
            let msg = e.to_string();
            let code = if msg.contains("0x88890004") || msg.contains("0x80070490") {
                "device-missing" // AUDCLNT_E_DEVICE_INVALIDATED / element not found
            } else if msg.contains("0x88890008") {
                "format-unsupported" // AUDCLNT_E_UNSUPPORTED_FORMAT
            } else if msg.contains("refused") || msg.contains("os error 10061") {
                "peer-unreachable"
            } else {
                "internal"
            };
            emit_error(code, msg);
            1
        }
    };
    emit(serde_json::json!({ "event": "ended" }));
    std::process::exit(code);
}

fn run(args: &[String]) -> devices::Res<()> {
    match args.first().map(String::as_str) {
        Some("list") => {
            devices::com_init()?;
            emit(devices::list()?);
            Ok(())
        }
        Some("send") => {
            let link = link(args, send::Link::Connect, send::Link::Listen)?;
            let source = if let Some(hz) = arg(args, "--tone") {
                send::Source::Tone { hz: hz.parse().map_err(|_| "--tone must be a number")? }
            } else if args.iter().any(|a| a == "--capture") {
                send::Source::Capture { device: arg(args, "--capture").filter(|d| !d.starts_with("--")) }
            } else {
                send::Source::Loopback { device: arg(args, "--device") }
            };
            let ctl = Control::new(1.0, args.iter().any(|a| a == "--muted"));
            ctl.spawn_reader();
            send::run(link, source, ctl)
        }
        Some("play") => {
            let link = link(args, play::Link::Connect, play::Link::Listen)?;
            let volume: f32 = arg(args, "--volume").map(|v| v.parse()).transpose().map_err(|_| "--volume must be a number")?.unwrap_or(1.0);
            let ctl = Control::new(volume, args.iter().any(|a| a == "--muted"));
            ctl.spawn_reader();
            let sink = match arg(args, "--wav") {
                Some(path) => play::Sink::Wav {
                    path,
                    seconds: arg(args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(2.0),
                },
                None => play::Sink::Device { id: arg(args, "--device") },
            };
            play::run(link, sink, ctl)
        }
        _ => Err("usage: kvm-audio list | send (--connect|--listen) ADDR [--device ID | --capture [ID] | --tone HZ] [--muted] | play (--listen|--connect) ADDR [--device ID | --wav PATH --seconds N] [--volume V] [--muted]".into()),
    }
}
