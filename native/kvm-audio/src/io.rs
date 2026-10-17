//! Talking to the agent: JSON events on stdout, JSON commands on stdin.
//! When stdin closes (the agent went away), the helper stops.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static OUT: OnceLock<Mutex<std::io::Stdout>> = OnceLock::new();

pub fn emit(v: serde_json::Value) {
    let lock = OUT.get_or_init(|| Mutex::new(std::io::stdout()));
    if let Ok(mut out) = lock.lock() {
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    }
}

pub fn emit_error(code: &str, message: impl Into<String>) {
    emit(serde_json::json!({ "event": "error", "code": code, "message": message.into() }));
}

pub struct Control {
    volume: AtomicU32,
    muted: AtomicBool,
    stop: AtomicBool,
}

impl Control {
    pub fn new(volume: f32, muted: bool) -> Arc<Self> {
        Arc::new(Control {
            volume: AtomicU32::new(volume.clamp(0.0, 1.0).to_bits()),
            muted: AtomicBool::new(muted),
            stop: AtomicBool::new(false),
        })
    }

    /// Effective gain: volume, or zero when muted.
    pub fn gain(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(self.volume.load(Ordering::Relaxed)) }
    }

    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Reads commands until stdin closes; then asks everything to stop.
    pub fn spawn_reader(self: &Arc<Self>) {
        let c = Arc::clone(self);
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line.len() > 1024 {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match v.get("cmd").and_then(|c| c.as_str()) {
                    Some("volume") => {
                        if let Some(x) = v.get("value").and_then(|x| x.as_f64()) {
                            c.volume.store((x as f32).clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
                        }
                    }
                    Some("mute") => {
                        if let Some(m) = v.get("value").and_then(|x| x.as_bool()) {
                            c.muted.store(m, Ordering::Relaxed);
                        }
                    }
                    Some("stop") => break,
                    _ => {}
                }
            }
            c.request_stop();
        });
    }
}
