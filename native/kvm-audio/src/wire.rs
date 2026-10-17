//! Stream format on the wire. One header, then length-prefixed frames of
//! interleaved PCM, all little-endian. The transport (the agents' TLS tunnel)
//! provides integrity and confidentiality.

use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 4] = b"KVMA";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 20;
pub const MAX_PAYLOAD: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub float: bool,
    /// Container bits per sample (16, 24 or 32).
    pub bits: u16,
    /// Meaningful bits per sample (e.g. 24 in a 32-bit container).
    pub valid_bits: u16,
    pub rate: u32,
    pub channels: u16,
    pub mask: u32,
}

impl Format {
    pub fn block_align(&self) -> usize {
        self.channels as usize * self.bits as usize / 8
    }

    pub fn same_audio(&self, other: &Format) -> bool {
        self.float == other.float
            && self.bits == other.bits
            && self.valid_bits == other.valid_bits
            && self.rate == other.rate
            && self.channels == other.channels
    }

    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.bits, 16 | 24 | 32) {
            return Err(format!("unsupported sample size {} bits", self.bits));
        }
        if self.float && self.bits != 32 {
            return Err("float samples must be 32-bit".into());
        }
        if self.valid_bits == 0 || self.valid_bits > self.bits {
            return Err("invalid valid-bits value".into());
        }
        if !(8_000..=384_000).contains(&self.rate) {
            return Err(format!("unsupported sample rate {}", self.rate));
        }
        if !(1..=8).contains(&self.channels) {
            return Err(format!("unsupported channel count {}", self.channels));
        }
        Ok(())
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sampleRate": self.rate,
            "channels": self.channels,
            "bitDepth": self.valid_bits,
            "sample": if self.float { "f32" } else { match self.valid_bits { 16 => "s16", 24 => "s24", _ => "s32" } },
        })
    }
}

pub fn write_header(w: &mut impl Write, f: &Format) -> io::Result<()> {
    let mut b = [0u8; HEADER_LEN];
    b[0..4].copy_from_slice(MAGIC);
    b[4] = VERSION;
    b[5] = f.float as u8;
    b[6..8].copy_from_slice(&f.bits.to_le_bytes());
    b[8..10].copy_from_slice(&f.valid_bits.to_le_bytes());
    b[10..14].copy_from_slice(&f.rate.to_le_bytes());
    b[14..16].copy_from_slice(&f.channels.to_le_bytes());
    b[16..20].copy_from_slice(&f.mask.to_le_bytes());
    w.write_all(&b)
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

pub fn read_header(r: &mut impl Read) -> io::Result<Format> {
    let mut b = [0u8; HEADER_LEN];
    r.read_exact(&mut b)?;
    if &b[0..4] != MAGIC {
        return Err(invalid("not a kvm-audio stream"));
    }
    if b[4] != VERSION {
        return Err(invalid(format!("stream version {} not supported", b[4])));
    }
    let f = Format {
        float: b[5] == 1,
        bits: u16::from_le_bytes([b[6], b[7]]),
        valid_bits: u16::from_le_bytes([b[8], b[9]]),
        rate: u32::from_le_bytes([b[10], b[11], b[12], b[13]]),
        channels: u16::from_le_bytes([b[14], b[15]]),
        mask: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
    };
    f.validate().map_err(invalid)?;
    Ok(f)
}

pub fn write_frame(w: &mut impl Write, seq: u64, payload: &[u8]) -> io::Result<()> {
    assert!(payload.len() <= MAX_PAYLOAD);
    let mut head = [0u8; 12];
    head[0..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    head[4..12].copy_from_slice(&seq.to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)
}

/// Reads one frame into `buf` and returns its sequence number.
pub fn read_frame(r: &mut impl Read, block_align: usize, buf: &mut Vec<u8>) -> io::Result<u64> {
    let mut head = [0u8; 12];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
    let seq = u64::from_le_bytes(head[4..12].try_into().unwrap());
    if len > MAX_PAYLOAD || len % block_align != 0 {
        return Err(invalid("bad frame length"));
    }
    buf.resize(len, 0);
    r.read_exact(buf)?;
    Ok(seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt() -> Format {
        Format { float: true, bits: 32, valid_bits: 32, rate: 48_000, channels: 2, mask: 3 }
    }

    #[test]
    fn header_round_trip() {
        let mut v = Vec::new();
        write_header(&mut v, &fmt()).unwrap();
        assert_eq!(v.len(), HEADER_LEN);
        assert_eq!(read_header(&mut v.as_slice()).unwrap(), fmt());
    }

    #[test]
    fn rejects_bad_headers() {
        let mut v = Vec::new();
        write_header(&mut v, &Format { channels: 0, ..fmt() }).unwrap();
        assert!(read_header(&mut v.as_slice()).is_err());
        let mut v = Vec::new();
        write_header(&mut v, &fmt()).unwrap();
        v[0] = b'X';
        assert!(read_header(&mut v.as_slice()).is_err());
    }

    #[test]
    fn frame_round_trip_and_limits() {
        let mut v = Vec::new();
        write_frame(&mut v, 7, &[1, 2, 3, 4, 5, 6, 7, 8]).unwrap();
        let mut buf = Vec::new();
        assert_eq!(read_frame(&mut v.as_slice(), 8, &mut buf).unwrap(), 7);
        assert_eq!(buf, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        // A length that is not whole frames is refused.
        assert!(read_frame(&mut v.as_slice(), 3, &mut buf).is_err());
        // An oversized length is refused before allocating.
        let mut big = Vec::new();
        big.extend_from_slice(&((MAX_PAYLOAD as u32) + 8).to_le_bytes());
        big.extend_from_slice(&0u64.to_le_bytes());
        assert!(read_frame(&mut big.as_slice(), 8, &mut buf).is_err());
    }
}
