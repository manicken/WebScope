//! Port of channels.js — the channels a capture uses.
//!
//! The start message may carry `channels: [0, 1, 2, 5]`, the device channel indexes to capture (the
//! `index` of the device info's channels), ascending. Without it every channel is captured.
//! The data sent to the browser: bit n of a sample = device channel n, whatever is captured; the bits of
//! the channels that are not captured are 0. A sample is 1, 2 or 4 bytes, little endian (up to channel 8,
//! 16, 32: the browser's Uint8/16/32Array). channel_packer() makes that from a device's own format.

use crate::device::js_int;
use serde_json::Value;

/// All channel indexes of a device: info.channels is a list of { index, ... } or a count.
fn all_channels(info: &Value) -> Vec<i64> {
    match &info["channels"] {
        Value::Array(list) => list.iter().enumerate().map(|(i, ch)| js_int(&ch["index"]).unwrap_or(i as i64)).collect(),
        c => (0..js_int(c).filter(|&n| n > 0).unwrap_or(0)).collect(),
    }
}

/// The validated channel list of a start message (all channels when it has none).
pub fn resolve_channels(msg: &Value, info: &Value) -> Result<Vec<u32>, String> {
    let all = all_channels(info);
    let Some(list) = msg.get("channels") else {
        return Ok(all.iter().map(|&c| c as u32).collect());
    };
    let list = match list.as_array() {
        Some(l) if !l.is_empty() => l,
        _ => return Err("channels must be a non-empty list of channel indexes".into()),
    };
    let mut out: Vec<u32> = Vec::with_capacity(list.len());
    for ch in list {
        let Some(n) = js_int(ch).filter(|n| all.contains(n)) else {
            return Err(format!("the device has no channel {}", crate::device::js_display(ch)));
        };
        if out.last().is_some_and(|&prev| n <= prev as i64) {
            return Err("channels must be ascending, without duplicates".into());
        }
        out.push(n as u32);
    }
    Ok(out)
}

/// Bytes per sample of the browser format for `channels` (device indexes, ascending): 1, 2 or 4.
pub fn sample_bytes(channels: &[u32]) -> usize {
    match channels.last().copied().unwrap_or(0) {
        0..=7 => 1,
        8..=15 => 2,
        _ => 4,
    }
}

/// Repacks whole samples: bit k of an output sample = bit bits[k] of the input sample (0 when bits[k] < 0).
pub struct Repacker {
    pub src_unit: usize,
    pub dst_unit: usize,
    identity: bool,
    luts: Vec<[u32; 256]>,
}

impl Repacker {
    pub fn new(src_unit: usize, bits: &[i32], dst_unit: usize) -> Self {
        let identity = dst_unit == src_unit && bits.len() == src_unit * 8 && bits.iter().enumerate().all(|(k, &b)| b == k as i32);
        // per input byte: its 256 values -> the output bits they set
        let mut luts = vec![[0u32; 256]; src_unit];
        for (k, &b) in bits.iter().enumerate() {
            if b < 0 {
                continue;
            }
            let (lut, m) = (&mut luts[(b >> 3) as usize], 1u32 << (b & 7));
            for v in 0..256u32 {
                if v & m != 0 {
                    lut[v as usize] |= 1 << k;
                }
            }
        }
        Self { src_unit, dst_unit, identity, luts }
    }

    pub fn run(&self, src: &[u8]) -> Vec<u8> {
        if self.identity {
            return src.to_vec();
        }
        let n = src.len() / self.src_unit;
        let mut out = vec![0u8; n * self.dst_unit];
        for (s, d) in src.chunks_exact(self.src_unit).zip(out.chunks_exact_mut(self.dst_unit)) {
            let mut w = 0u32;
            for (j, &byte) in s.iter().enumerate() {
                w |= self.luts[j][byte as usize];
            }
            for (j, o) in d.iter_mut().enumerate() {
                *o = (w >> (8 * j)) as u8;
            }
        }
        out
    }
}

/// Default output size: just enough bytes for the bits.
#[cfg(test)]
pub fn repacker(src_unit: usize, bits: &[i32]) -> Repacker {
    Repacker::new(src_unit, bits, ((bits.len() + 7) / 8).max(1))
}

/// To the browser format: bit n = device channel n for the captured `channels`, the other bits 0.
/// `src_bit_of(ch)`: the bit of channel ch in the device's format (None: bit ch).
pub fn channel_packer(src_unit: usize, channels: &[u32], src_bit_of: Option<&dyn Fn(u32) -> i32>) -> Repacker {
    let top = channels.last().copied().unwrap_or(0) as usize;
    let mut bits = vec![-1i32; top + 1];
    for &ch in channels {
        bits[ch as usize] = src_bit_of.map_or(ch as i32, |f| f(ch));
    }
    Repacker::new(src_unit, &bits, sample_bytes(channels))
}

/// channel_packer() for a device that sends the captured channels as bits 0, 1, ..: bit k = channels[k].
pub fn packed_channel_packer(src_unit: usize, channels: &[u32]) -> Repacker {
    let index = |ch: u32| channels.iter().position(|&c| c == ch).map_or(-1, |i| i as i32);
    channel_packer(src_unit, channels, Some(&index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn device() -> Value {
        json!({ "channels": (0..8).map(|i| json!({ "index": i, "name": format!("D{i}"), "type": "logic" })).collect::<Vec<_>>() })
    }

    #[test]
    fn resolve_channels_all_or_valid_list() {
        assert_eq!(resolve_channels(&json!({}), &device()).unwrap(), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(resolve_channels(&json!({ "channels": [0, 3, 5] }), &device()).unwrap(), vec![0, 3, 5]);
        for bad in [json!([]), json!([8]), json!([3, 1]), json!([1, 1]), json!(["D0"]), json!("all"), json!([0.5])] {
            assert!(resolve_channels(&json!({ "channels": bad }), &device()).is_err(), "{bad}");
        }
    }

    #[test]
    fn repacker_bits() {
        // 2-byte input samples; take channels 1, 9 and 15 -> 3 bits in 1 byte
        let r = repacker(2, &[1, 9, 15]);
        assert_eq!(r.dst_unit, 1);
        let src = [0x02, 0x00, 0x00, 0x02, 0x00, 0x80, 0xFF, 0xFF, 0xFD, 0x7D];
        assert_eq!(r.run(&src), vec![0b001, 0b010, 0b100, 0b111, 0b000]);
        // raw 4-byte samples with the first 9 channels -> 2 bytes, other bits cleared
        let r = repacker(4, &[0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(r.dst_unit, 2);
        assert_eq!(r.run(&[0xAB, 0xFF, 0xFF, 0xFF]), vec![0xAB, 0x01]);
        // 32 channels, bit 31 survives
        let bits: Vec<i32> = (0..32).map(|i| 31 - i).collect();
        let r = repacker(4, &bits);
        assert_eq!(r.run(&[0, 0, 0, 0x80]), vec![1, 0, 0, 0]);
        assert_eq!(r.run(&[1, 0, 0, 0]), vec![0, 0, 0, 0x80]);
        // identity
        assert_eq!(repacker(1, &[0, 1, 2, 3, 4, 5, 6, 7]).run(&[1, 2, 3]), vec![1, 2, 3]);
    }

    #[test]
    fn channel_packer_positions() {
        let r = channel_packer(2, &[5, 6, 7, 8, 9, 10, 11, 12], None);
        assert_eq!(r.dst_unit, 2);
        assert_eq!(r.run(&[0xFF, 0xFF]), vec![0xE0, 0x1F]);
        let s = packed_channel_packer(1, &[2, 9]);
        assert_eq!(s.run(&[0b01, 0b10, 0b11]), vec![0x04, 0x00, 0x00, 0x02, 0x04, 0x02]);
        assert_eq!(sample_bytes(&[0]), 1);
        assert_eq!(sample_bytes(&[5, 12]), 2);
        assert_eq!(sample_bytes(&[16]), 4);
    }
}
