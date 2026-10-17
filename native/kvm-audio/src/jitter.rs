//! Jitter buffer between the network and the device clock.
//!
//! It fills to `target` before playing, plays silence and refills after an
//! underrun, and drops the oldest audio when it grows past `max` (the two
//! machines' clocks drift apart slowly; this keeps latency bounded).

use std::collections::VecDeque;

pub struct Jitter {
    buf: VecDeque<u8>,
    block: usize,
    target: usize,
    max: usize,
    primed: bool,
    pub underruns: u64,
    pub dropped_frames: u64,
}

impl Jitter {
    pub fn new(block_align: usize, target_frames: usize, max_frames: usize) -> Self {
        Jitter {
            buf: VecDeque::with_capacity(max_frames * block_align * 2),
            block: block_align,
            target: target_frames,
            max: max_frames.max(target_frames * 2),
            primed: false,
            underruns: 0,
            dropped_frames: 0,
        }
    }

    pub fn frames(&self) -> usize {
        self.buf.len() / self.block
    }

    #[cfg(test)]
    pub fn primed(&self) -> bool {
        self.primed
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend(data);
        if self.frames() > self.max {
            let drop = (self.frames() - self.target) * self.block;
            self.buf.drain(..drop);
            self.dropped_frames += (drop / self.block) as u64;
        }
    }

    /// Fills `out` with exactly `frames` frames, padding with silence when short.
    /// Returns true when `out` carries real audio.
    pub fn pull(&mut self, frames: usize, out: &mut Vec<u8>) -> bool {
        let want = frames * self.block;
        out.clear();
        if !self.primed {
            if self.frames() >= self.target {
                self.primed = true;
            } else {
                out.resize(want, 0);
                return false;
            }
        }
        let take = want.min(self.buf.len());
        out.extend(self.buf.drain(..take));
        if take < want {
            out.resize(want, 0);
            self.underruns += 1;
            self.primed = false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_target_then_plays() {
        let mut j = Jitter::new(4, 10, 40);
        let mut out = Vec::new();
        j.push(&[1u8; 4 * 5]);
        assert!(!j.pull(5, &mut out));
        assert_eq!(out, vec![0u8; 20]);
        j.push(&[1u8; 4 * 5]);
        assert!(j.pull(5, &mut out));
        assert_eq!(out, vec![1u8; 20]);
    }

    #[test]
    fn underrun_pads_and_reprimes() {
        let mut j = Jitter::new(2, 4, 16);
        let mut out = Vec::new();
        j.push(&[9u8; 2 * 4]);
        assert!(j.pull(6, &mut out));
        assert_eq!(&out[..8], &[9u8; 8]);
        assert_eq!(&out[8..], &[0u8; 4]);
        assert_eq!(j.underruns, 1);
        assert!(!j.primed());
    }

    #[test]
    fn drops_oldest_when_too_full() {
        let mut j = Jitter::new(1, 10, 20);
        let data: Vec<u8> = (0..25).collect();
        j.push(&data);
        assert_eq!(j.frames(), 10);
        assert_eq!(j.dropped_frames, 15);
        let mut out = Vec::new();
        j.pull(10, &mut out);
        assert_eq!(out, (15..25).collect::<Vec<u8>>());
    }
}
