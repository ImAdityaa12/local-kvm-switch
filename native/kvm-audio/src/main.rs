//! kvm-audio: the native audio helper for LAN KVM Switcher.
//!
//!   kvm-audio list
//!   kvm-audio send --connect 127.0.0.1:24821 [--device ID | --tone HZ]
//!   kvm-audio play --listen 127.0.0.1:24820 [--device ID | --wav PATH --seconds N] [--volume 0.8] [--muted]
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
            let addr = loopback_addr(arg(args, "--connect"), "--connect")?;
            let source = match arg(args, "--tone") {
                Some(hz) => send::Source::Tone { hz: hz.parse().map_err(|_| "--tone must be a number")? },
                None => send::Source::Loopback { device: arg(args, "--device") },
            };
            let ctl = Control::new(1.0, false);
            ctl.spawn_reader();
            send::run(addr, source, ctl)
        }
        Some("play") => {
            let addr = loopback_addr(arg(args, "--listen"), "--listen")?;
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
            play::run(addr, sink, ctl)
        }
        _ => Err("usage: kvm-audio list | send --connect ADDR [--device ID | --tone HZ] | play --listen ADDR [--device ID | --wav PATH --seconds N] [--volume V] [--muted]".into()),
    }
}
