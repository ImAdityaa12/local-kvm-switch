//! Sample handling: peak metering and gain with a short ramp. At unity gain
//! the samples are left untouched, so the route stays bit-exact.

use crate::wire::Format;

fn read(fmt: &Format, b: &[u8]) -> f32 {
    match (fmt.float, fmt.bits) {
        (true, 32) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        (false, 16) => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
        (false, 24) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        (false, 32) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    }
}

fn write(fmt: &Format, b: &mut [u8], v: f32) {
    match (fmt.float, fmt.bits) {
        (true, 32) => b[..4].copy_from_slice(&v.to_le_bytes()),
        (false, 16) => b[..2].copy_from_slice(&((v.clamp(-1.0, 1.0) * 32_767.0).round() as i16).to_le_bytes()),
        (false, 24) => {
            let s = (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
            b[..3].copy_from_slice(&s.to_le_bytes()[..3]);
        }
        (false, 32) => b[..4].copy_from_slice(&((v.clamp(-1.0, 1.0) as f64 * 2_147_483_647.0).round() as i32).to_le_bytes()),
        _ => {}
    }
}

/// Peak absolute sample value, 0.0 to 1.0 (float can exceed 1.0).
pub fn peak(fmt: &Format, data: &[u8]) -> f32 {
    let step = fmt.bits as usize / 8;
    data.chunks_exact(step).fold(0.0f32, |m, s| m.max(read(fmt, s).abs()))
}

pub fn to_dbfs(peak: f32) -> f32 {
    if peak <= 1e-6 { -120.0 } else { 20.0 * peak.log10() }
}

/// Gain that moves to its target over `ramp_frames`, so changes do not click.
pub struct Gain {
    current: f32,
    target: f32,
    step: f32,
    ramp_frames: f32,
}

impl Gain {
    pub fn new(initial: f32, ramp_frames: u32) -> Self {
        Gain { current: initial, target: initial, step: 0.0, ramp_frames: ramp_frames.max(1) as f32 }
    }

    pub fn set_target(&mut self, target: f32) {
        if (target - self.target).abs() > f32::EPSILON {
            self.target = target;
            self.step = (self.target - self.current) / self.ramp_frames;
        }
    }

    pub fn is_unity(&self) -> bool {
        self.current == 1.0 && self.target == 1.0
    }

    pub fn is_silent(&self) -> bool {
        self.current == 0.0 && self.target == 0.0
    }

    pub fn apply(&mut self, fmt: &Format, data: &mut [u8]) {
        if self.is_unity() {
            return;
        }
        let frame = fmt.block_align();
        let sample = fmt.bits as usize / 8;
        for f in data.chunks_exact_mut(frame) {
            if self.current != self.target {
                self.current += self.step;
                if (self.step > 0.0 && self.current >= self.target) || (self.step < 0.0 && self.current <= self.target) {
                    self.current = self.target;
                }
            }
            if self.current == 1.0 {
                continue;
            }
            for s in f.chunks_exact_mut(sample) {
                let v = read(fmt, s) * self.current;
                write(fmt, s, v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F32: Format = Format { float: true, bits: 32, valid_bits: 32, rate: 48_000, channels: 2, mask: 3 };
    const S24: Format = Format { float: false, bits: 24, valid_bits: 24, rate: 48_000, channels: 1, mask: 4 };

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    #[test]
    fn unity_gain_is_bit_exact() {
        let original = f32_bytes(&[0.1, -0.2, 0.333, 0.999]);
        let mut d = original.clone();
        Gain::new(1.0, 48).apply(&F32, &mut d);
        assert_eq!(d, original);
    }

    #[test]
    fn gain_ramps_without_jumping() {
        let mut d = f32_bytes(&[1.0; 2 * 100]);
        let mut g = Gain::new(1.0, 10);
        g.set_target(0.0);
        g.apply(&F32, &mut d);
        let vals: Vec<f32> = d.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        // First frame already moved a little, last frames are silent, and no step exceeds 1/10.
        assert!(vals[0] < 1.0 && vals[0] > 0.85);
        assert_eq!(vals[vals.len() - 1], 0.0);
        for w in vals.windows(2) {
            assert!((w[0] - w[1]).abs() <= 0.1001);
        }
    }

    #[test]
    fn s24_round_trip_and_peak() {
        let s: i32 = -4_194_304; // -0.5
        let mut d = s.to_le_bytes()[..3].to_vec();
        assert!((peak(&S24, &d) - 0.5).abs() < 1e-6);
        let mut g = Gain::new(0.5, 1);
        g.apply(&S24, &mut d);
        assert!((peak(&S24, &d) - 0.25).abs() < 1e-6);
        assert!((to_dbfs(0.5) + 6.0206).abs() < 0.01);
    }
}
