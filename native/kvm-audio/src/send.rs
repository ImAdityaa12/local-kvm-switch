//! Laptop side: capture what the laptop plays (WASAPI loopback, at the mix
//! format, no conversion) and send it.

use crate::devices::{self, Res};
use crate::io::{emit, Control};
use crate::wire::{self, Format};
use std::collections::VecDeque;
use std::io::{BufWriter, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasapi::{Direction, StreamMode};

/// Audio is sent in chunks of about this long.
const CHUNK_MS: u32 = 10;

pub enum Source {
    Loopback { device: Option<String> },
    /// A sine tone at -12 dBFS, for testing without playing anything.
    Tone { hz: f32 },
}

struct Sender {
    out: BufWriter<TcpStream>,
    fmt: Format,
    seq: u64,
    sent_frames: u64,
    started: Instant,
}

impl Sender {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
        for chunk in data.chunks(wire::MAX_PAYLOAD - wire::MAX_PAYLOAD % self.fmt.block_align()) {
            wire::write_frame(&mut self.out, self.seq, chunk)?;
            self.seq += 1;
            self.sent_frames += (chunk.len() / self.fmt.block_align()) as u64;
        }
        self.out.flush()
    }

    /// Frames we are behind real time. Loopback delivers nothing while the
    /// laptop is silent, so the gap is filled with silence to keep the
    /// receiver's buffer steady.
    fn behind(&self) -> i64 {
        let due = (self.started.elapsed().as_secs_f64() * self.fmt.rate as f64) as i64;
        due - self.sent_frames as i64
    }
}

fn connect(addr: SocketAddr, fmt: Format) -> Res<Sender> {
    let s = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    s.set_nodelay(true)?;
    let mut out = BufWriter::new(s);
    wire::write_header(&mut out, &fmt)?;
    out.flush()?;
    Ok(Sender { out, fmt, seq: 0, sent_frames: 0, started: Instant::now() })
}

pub fn run(addr: SocketAddr, source: Source, ctl: Arc<Control>) -> Res<()> {
    match source {
        Source::Tone { hz } => tone(addr, hz, ctl),
        Source::Loopback { device } => loopback(addr, device.as_deref(), ctl),
    }
}

fn tone(addr: SocketAddr, hz: f32, ctl: Arc<Control>) -> Res<()> {
    let fmt = Format { float: true, bits: 32, valid_bits: 32, rate: 48_000, channels: 2, mask: 3 };
    let mut tx = connect(addr, fmt)?;
    emit(serde_json::json!({ "event": "streaming", "format": fmt.to_json(), "source": "tone" }));
    let per_chunk = (fmt.rate * CHUNK_MS / 1000) as usize;
    let amp = 10f32.powf(-12.0 / 20.0);
    let mut n: u64 = 0;
    let mut buf = Vec::with_capacity(per_chunk * fmt.block_align());
    while !ctl.stopping() {
        buf.clear();
        for _ in 0..per_chunk {
            let v = amp * (2.0 * std::f32::consts::PI * hz * n as f32 / fmt.rate as f32).sin();
            n += 1;
            buf.extend_from_slice(&v.to_le_bytes());
            buf.extend_from_slice(&v.to_le_bytes());
        }
        tx.send(&buf)?;
        let ahead = -tx.behind();
        if ahead > 0 {
            std::thread::sleep(Duration::from_secs_f64(ahead as f64 / fmt.rate as f64));
        }
    }
    Ok(())
}

fn loopback(addr: SocketAddr, device: Option<&str>, ctl: Arc<Control>) -> Res<()> {
    devices::com_init()?;
    let dev = devices::open(Direction::Render, device)?;
    let mut client = dev.get_iaudioclient()?;
    let mix = client.get_mixformat()?;
    let fmt = devices::to_format(&mix)?;
    fmt.validate()?;
    // The mix format is what the audio engine already produces: no conversion here.
    client.initialize_client(&mix, &Direction::Capture, &StreamMode::EventsShared { autoconvert: false, buffer_duration_hns: 200_000 })?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;

    let mut tx = connect(addr, fmt)?;
    client.start_stream()?;
    emit(serde_json::json!({ "event": "streaming", "format": fmt.to_json(), "source": "loopback" }));

    let block = fmt.block_align();
    let mut q: VecDeque<u8> = VecDeque::with_capacity(fmt.rate as usize * block);
    let chunk_bytes = (fmt.rate * CHUNK_MS / 1000) as usize * block;
    let mut out = Vec::with_capacity(chunk_bytes);
    let silence_after = fmt.rate as i64 * 30 / 1000;

    while !ctl.stopping() {
        let _ = event.wait_for_event(20);
        loop {
            match capture.get_next_packet_size()? {
                Some(0) | None => break,
                Some(_) => {}
            }
            let before = q.len();
            let info = capture.read_from_device_to_deque(&mut q)?;
            if info.flags.silent {
                for b in q.range_mut(before..) {
                    *b = 0;
                }
            }
        }
        while q.len() >= chunk_bytes {
            out.clear();
            out.extend(q.drain(..chunk_bytes));
            tx.send(&out)?;
        }
        // Nothing playing on the laptop: keep the stream going with silence.
        let behind = tx.behind();
        if q.is_empty() && behind > silence_after {
            let frames = (behind - silence_after / 3) as usize;
            out.clear();
            out.resize(frames * block, 0);
            tx.send(&out)?;
        }
    }
    client.stop_stream()?;
    Ok(())
}
