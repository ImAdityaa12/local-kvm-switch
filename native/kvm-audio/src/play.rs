//! Gaming PC side: receive the laptop's audio and play it on a chosen device.

use crate::devices::{self, Res};
use crate::dsp::{self, Gain};
use crate::io::{emit, emit_error, Control};
use crate::jitter::Jitter;
use crate::wire::{self, Format};
use std::io::{BufReader, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wasapi::{Direction, StreamMode};

/// Buffer this much before playing; keep at most `MAX_MS` (older audio is dropped).
const TARGET_MS: u32 = 40;
const MAX_MS: u32 = 200;
const RAMP_MS: u32 = 10;

pub enum Sink {
    Device { id: Option<String> },
    /// Write to a WAV file instead of a device (tests); stops after `seconds`.
    Wav { path: String, seconds: f32 },
}

struct Shared {
    jitter: Mutex<Option<Jitter>>,
}

/// Accepts the laptop's sender (and later reconnects) and feeds the buffer.
fn network(listener: TcpListener, shared: Arc<Shared>, fmt_tx: mpsc::Sender<Format>, ctl: Arc<Control>) {
    let mut format: Option<Format> = None;
    for conn in listener.incoming() {
        if ctl.stopping() {
            return;
        }
        let Ok(stream) = conn else { continue };
        let _ = stream.set_nodelay(true);
        let mut r = BufReader::with_capacity(64 * 1024, stream);
        let f = match wire::read_header(&mut r) {
            Ok(f) => f,
            Err(e) => {
                emit_error("bad-request", format!("rejected a stream: {e}"));
                continue;
            }
        };
        match format {
            None => {
                format = Some(f);
                let _ = fmt_tx.send(f);
            }
            Some(old) if !old.same_audio(&f) => {
                // The device stream is set up for the old format; let the agent restart us.
                emit_error("format-unsupported", "the laptop changed its audio format");
                ctl.request_stop();
                return;
            }
            Some(_) => {}
        }
        emit(serde_json::json!({ "event": "connected" }));
        let mut buf = Vec::new();
        loop {
            match wire::read_frame(&mut r, f.block_align(), &mut buf) {
                Ok(_) => {
                    if let Some(j) = shared.jitter.lock().unwrap().as_mut() {
                        j.push(&buf);
                    }
                }
                Err(_) => break,
            }
            if ctl.stopping() {
                return;
            }
        }
        emit(serde_json::json!({ "event": "disconnected" }));
    }
}

pub fn run(addr: SocketAddr, sink: Sink, ctl: Arc<Control>) -> Res<()> {
    let listener = TcpListener::bind(addr)?;
    emit(serde_json::json!({ "event": "listening", "port": listener.local_addr()?.port() }));
    let shared = Arc::new(Shared { jitter: Mutex::new(None) });
    let (fmt_tx, fmt_rx) = mpsc::channel();
    {
        let (s, c) = (Arc::clone(&shared), Arc::clone(&ctl));
        std::thread::spawn(move || network(listener, s, fmt_tx, c));
    }

    // Wait for the first stream to learn its format.
    let fmt = loop {
        if ctl.stopping() {
            return Ok(());
        }
        match fmt_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(f) => break f,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => return Ok(()),
        }
    };
    *shared.jitter.lock().unwrap() =
        Some(Jitter::new(fmt.block_align(), (fmt.rate * TARGET_MS / 1000) as usize, (fmt.rate * MAX_MS / 1000) as usize));

    match sink {
        Sink::Device { id } => play_device(fmt, id.as_deref(), shared, ctl),
        Sink::Wav { path, seconds } => play_wav(fmt, &path, seconds, shared, ctl),
    }
}

struct Stats {
    last: Instant,
    peak: f32,
    announced: bool,
}

impl Stats {
    fn new() -> Self {
        Stats { last: Instant::now(), peak: 0.0, announced: false }
    }

    fn tick(&mut self, j: &Jitter, fmt: &Format) {
        if self.last.elapsed() < Duration::from_millis(250) {
            return;
        }
        emit(serde_json::json!({
            "event": "stats",
            "peakDb": (dsp::to_dbfs(self.peak) * 10.0).round() / 10.0,
            "bufferMs": j.frames() as u64 * 1000 / fmt.rate as u64,
            "underruns": j.underruns,
            "droppedFrames": j.dropped_frames,
        }));
        self.peak = 0.0;
        self.last = Instant::now();
    }
}

fn play_device(fmt: Format, id: Option<&str>, shared: Arc<Shared>, ctl: Arc<Control>) -> Res<()> {
    devices::com_init()?;
    let dev = devices::open(Direction::Render, id)?;
    let mut client = dev.get_iaudioclient()?;
    let mix = devices::mix_format(&client)?;
    // Same format as the device mix: hand samples over untouched. Otherwise ask
    // Windows to convert, and say so instead of hiding it.
    let convert = !fmt.same_audio(&mix);
    client.initialize_client(
        &devices::to_waveformat(&fmt),
        &Direction::Render,
        &StreamMode::EventsShared { autoconvert: convert, buffer_duration_hns: 200_000 },
    )?;
    let event = client.set_get_eventhandle()?;
    let render = client.get_audiorenderclient()?;
    emit(serde_json::json!({
        "event": "format",
        "format": fmt.to_json(),
        "device": mix.to_json(),
        "conversion": if convert { Some("windows") } else { None },
    }));

    let mut gain = Gain::new(ctl.gain(), fmt.rate * RAMP_MS / 1000);
    let mut out = Vec::new();
    let mut stats = Stats::new();
    let mut fading_out = false;
    client.start_stream()?;
    loop {
        if ctl.stopping() && !fading_out {
            fading_out = true;
            gain.set_target(0.0);
        } else if !fading_out {
            gain.set_target(ctl.gain());
        }
        let frames = client.get_available_space_in_frames()? as usize;
        if frames > 0 {
            let mut guard = shared.jitter.lock().unwrap();
            let j = guard.as_mut().unwrap();
            let real = j.pull(frames, &mut out);
            if real {
                stats.peak = stats.peak.max(dsp::peak(&fmt, &out));
                if !stats.announced {
                    stats.announced = true;
                    emit(serde_json::json!({ "event": "streaming" }));
                }
            }
            stats.tick(j, &fmt);
            drop(guard);
            gain.apply(&fmt, &mut out);
            render.write_to_device(frames, &out, None)?;
        }
        if fading_out && gain.is_silent() {
            // Let the silent tail reach the speakers, then stop.
            std::thread::sleep(Duration::from_millis(30));
            break;
        }
        if event.wait_for_event(1000).is_err() {
            return Err("the playback device stopped responding".into());
        }
    }
    client.stop_stream()?;
    Ok(())
}

fn play_wav(fmt: Format, path: &str, seconds: f32, shared: Arc<Shared>, ctl: Arc<Control>) -> Res<()> {
    let total = (seconds * fmt.rate as f32) as usize;
    let mut data = Vec::with_capacity(total * fmt.block_align());
    let mut out = Vec::new();
    let per_tick = (fmt.rate / 100) as usize;
    let mut stats = Stats::new();
    let mut gain = Gain::new(ctl.gain(), fmt.rate * RAMP_MS / 1000);
    while data.len() < total * fmt.block_align() && !ctl.stopping() {
        std::thread::sleep(Duration::from_millis(10));
        let mut guard = shared.jitter.lock().unwrap();
        let j = guard.as_mut().unwrap();
        if j.pull(per_tick, &mut out) {
            if !stats.announced {
                stats.announced = true;
                emit(serde_json::json!({ "event": "streaming" }));
            }
            stats.peak = stats.peak.max(dsp::peak(&fmt, &out));
            gain.set_target(ctl.gain());
            gain.apply(&fmt, &mut out);
            data.extend_from_slice(&out);
        }
        stats.tick(j, &fmt);
    }
    write_wav(path, &fmt, &data)?;
    emit(serde_json::json!({ "event": "wav", "path": path, "frames": data.len() / fmt.block_align() }));
    Ok(())
}

fn write_wav(path: &str, fmt: &Format, data: &[u8]) -> std::io::Result<()> {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let tag: u16 = if fmt.float { 3 } else { 1 };
    let align = fmt.block_align() as u16;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data.len() as u32).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&tag.to_le_bytes())?;
    f.write_all(&fmt.channels.to_le_bytes())?;
    f.write_all(&fmt.rate.to_le_bytes())?;
    f.write_all(&(fmt.rate * align as u32).to_le_bytes())?;
    f.write_all(&align.to_le_bytes())?;
    f.write_all(&fmt.bits.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&(data.len() as u32).to_le_bytes())?;
    f.write_all(data)?;
    f.flush()
}
