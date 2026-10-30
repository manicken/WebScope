//! Port of trigger.js — hardware-independent trigger + pre/post-trigger capture.
//!
//! Works on the sample bytes every device produces for the browser (channels.rs: 1, 2 or 4 bytes per
//! sample, channel n = bit (n & 7) of byte (n >> 3)).
//!   TriggerEngine    finds the trigger sample in a stream of chunks (state survives chunk boundaries):
//!                    an edge / pulse on one channel, optionally with "other channel conditions"
//!   TriggerCapture   ring buffer for the pre-trigger samples + collection of the post-trigger samples
//!   start_triggered  glue: runs a device continuously, feeds TriggerCapture, delivers the finished capture
//! Finished capture = preTrigger samples, the trigger sample, postTrigger samples; the trigger sample is at
//! index preTrigger.

use crate::channels::sample_bytes;
use crate::device::{get, js_int, DeviceKind, Events, EventsRef, Session};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};

pub const TRIGGER_TYPES: [&str; 4] = ["L2H", "H2L", "PulseH", "PulseL"];
const MAX_CAPTURE_BYTES: u64 = 512 * 1024 * 1024; // refuse absurd pre/post settings instead of running out of memory
const STREAM_SAMPLES: usize = 1 << 16; // the finished capture is sent to the client in pieces of this size

/* ============================== trigger detection ============================== */

pub struct TriggerEngine {
    unit: usize,
    byte_idx: usize,
    mask: u8,
    pulse_length: u64,
    edge: bool,
    from: i8,
    to: i8,
    level: i8,
    prev: i8,              // level of the previous sample, -1 = no sample seen yet
    run: u64,              // length of the current level, counted from an observed edge (0 = start unknown)
    pos: u64,              // global index of the next sample
    pub fire_index: i64,   // global index of the trigger sample once found
    cond: Vec<(usize, u8, u8)>, // [byte, mask, value] per byte of a sample that has conditions
}

#[derive(Clone, Debug)]
pub struct TriggerOptions {
    pub unit: usize,
    pub channel: u32,
    pub kind: String,
    pub pulse_length: u64,
    /// (channel, high?)
    pub conditions: Vec<(u32, bool)>,
    pub pre: u64,
    pub post: u64,
}

impl TriggerEngine {
    pub fn new(o: &TriggerOptions) -> Self {
        let (mut cm, mut cv) = (vec![0u8; o.unit], vec![0u8; o.unit]);
        for &(ch, hi) in &o.conditions {
            let (b, m) = ((ch >> 3) as usize, 1u8 << (ch & 7));
            cm[b] |= m;
            if hi {
                cv[b] |= m;
            }
        }
        let cond = (0..o.unit).filter(|&b| cm[b] != 0).map(|b| (b, cm[b], cv[b])).collect();
        let l2h = o.kind == "L2H";
        Self {
            unit: o.unit,
            byte_idx: (o.channel >> 3) as usize,
            mask: 1 << (o.channel & 7),
            pulse_length: o.pulse_length,
            edge: l2h || o.kind == "H2L",
            from: if l2h { 0 } else { 1 },
            to: if l2h { 1 } else { 0 },
            level: if o.kind == "PulseH" { 1 } else { 0 },
            prev: -1,
            run: 0,
            pos: 0,
            fire_index: -1,
            cond,
        }
    }

    /// Do the other channels match the conditions in the sample that starts at byte `s`?
    fn cond_ok(&self, chunk: &[u8], s: usize) -> bool {
        self.cond.iter().all(|&(b, m, v)| chunk[s + b] & m == v)
    }

    /// Scan a chunk of whole samples; the trigger may not fire before global sample `armed_from`.
    /// Returns the index of the trigger sample inside the chunk.
    pub fn scan(&mut self, chunk: &[u8], armed_from: u64) -> Option<usize> {
        let n = chunk.len() / self.unit;
        let base = self.pos;
        let (mut prev, mut run) = (self.prev, self.run);
        let mut hit = None;
        for i in 0..n {
            let s = i * self.unit;
            let cur: i8 = if chunk[s + self.byte_idx] & self.mask != 0 { 1 } else { 0 };
            let armed = base + i as u64 >= armed_from;
            if self.edge {
                if prev == self.from && cur == self.to && armed && self.cond_ok(chunk, s) {
                    hit = Some(i);
                    break;
                }
            } else {
                // a pulse is measured from the edge that starts it: a level that was already there when the
                // capture started never counts. Fires once, when the run reaches exactly pulseLength samples.
                if prev == -1 {
                    run = 0;
                } else if cur != prev {
                    run = 1;
                } else if run > 0 {
                    run += 1;
                }
                if cur == self.level && run == self.pulse_length && armed && self.cond_ok(chunk, s) {
                    hit = Some(i);
                    break;
                }
            }
            prev = cur;
        }
        self.pos = base + n as u64;
        if let Some(h) = hit {
            self.fire_index = (base + h as u64) as i64;
            return hit;
        }
        self.prev = prev;
        self.run = run;
        None
    }
}

/* ============================== pre/post capture ============================== */

#[derive(PartialEq, Clone, Copy, Debug)]
pub enum CaptureState {
    Armed,
    Capturing,
    Done,
}

pub struct CaptureResult {
    pub data: Vec<u8>,
    pub samples: u64,
    pub trigger: u64,
}

pub struct TriggerCapture {
    unit: usize,
    pre: u64,
    post: u64,
    pub engine: TriggerEngine,
    ring: Vec<u8>,
    head: usize,
    filled: usize,
    pub state: CaptureState,
    out: Vec<u8>,
    out_filled: usize,
    carry: Vec<u8>, // incomplete sample left over from the last chunk
}

impl TriggerCapture {
    pub fn new(o: &TriggerOptions) -> Self {
        let cap = o.pre as usize * o.unit;
        Self {
            unit: o.unit,
            pre: o.pre,
            post: o.post,
            engine: TriggerEngine::new(o),
            ring: vec![0; cap],
            head: 0,
            filled: 0,
            state: CaptureState::Armed,
            out: Vec::new(),
            out_filled: 0,
            carry: Vec::new(),
        }
    }

    /// Feed raw bytes (any length). Returns true once the capture is complete.
    pub fn push(&mut self, chunk: &[u8]) -> bool {
        if self.state == CaptureState::Done {
            return true;
        }
        let merged;
        let mut chunk = chunk;
        if !self.carry.is_empty() {
            let mut m = std::mem::take(&mut self.carry);
            m.extend_from_slice(chunk);
            merged = m;
            chunk = &merged;
        }
        let rem = chunk.len() % self.unit;
        if rem != 0 {
            self.carry = chunk[chunk.len() - rem..].to_vec();
            chunk = &chunk[..chunk.len() - rem];
        }

        let mut start = 0;
        if self.state == CaptureState::Armed {
            let Some(j) = self.engine.scan(chunk, self.pre) else {
                self.ring_push(chunk);
                return false;
            };
            let jb = j * self.unit;
            self.ring_push(&chunk[..jb]); // everything before the trigger sample
            self.out = vec![0; (self.pre + 1 + self.post) as usize * self.unit];
            // oldest -> newest, exactly `pre` samples
            let cap = self.ring.len();
            self.out[..cap - self.head].copy_from_slice(&self.ring[self.head..]);
            self.out[cap - self.head..cap].copy_from_slice(&self.ring[..self.head]);
            self.out_filled = cap;
            self.state = CaptureState::Capturing;
            start = jb; // the trigger sample is the first post sample
        }
        let take = (self.out.len() - self.out_filled).min(chunk.len() - start);
        self.out[self.out_filled..self.out_filled + take].copy_from_slice(&chunk[start..start + take]);
        self.out_filled += take;
        if self.out_filled == self.out.len() {
            self.state = CaptureState::Done;
            return true;
        }
        false
    }

    /// The complete capture (state Done).
    pub fn result(&mut self) -> CaptureResult {
        let data = std::mem::take(&mut self.out);
        CaptureResult { samples: (data.len() / self.unit) as u64, data, trigger: self.pre }
    }

    /// What has been collected after the trigger fired (when the capture is stopped early).
    pub fn partial(&mut self) -> Option<CaptureResult> {
        if self.state == CaptureState::Armed {
            return None;
        }
        let bytes = self.out_filled - self.out_filled % self.unit;
        let mut data = std::mem::take(&mut self.out);
        data.truncate(bytes);
        Some(CaptureResult { samples: (bytes / self.unit) as u64, data, trigger: self.pre })
    }

    fn ring_push(&mut self, src: &[u8]) {
        let (cap, len) = (self.ring.len(), src.len());
        if cap == 0 || len == 0 {
            return;
        }
        if len >= cap {
            // the chunk alone fills the ring
            self.ring.copy_from_slice(&src[len - cap..]);
            self.head = 0;
            self.filled = cap;
            return;
        }
        let first = len.min(cap - self.head);
        self.ring[self.head..self.head + first].copy_from_slice(&src[..first]);
        if len > first {
            self.ring[..len - first].copy_from_slice(&src[first..]);
        }
        self.head = (self.head + len) % cap;
        self.filled = cap.min(self.filled + len);
    }
}

/* ============================== validation ============================== */

#[derive(Debug)]
pub struct TriggerConfig {
    pub opts: TriggerOptions,
    pub channel_count: u32,
    pub samplerate: Option<Value>,
}

/// Device indexes of the captured channels, ascending: msg.channels (or info.channels) as a list of indexes;
/// a count or a list of names / channel objects gives channels 0 .. n-1.
fn captured_channels(msg: &Value, info: &Value) -> Vec<u32> {
    let c = get(msg, "channels").unwrap_or(&info["channels"]);
    match c {
        Value::Array(a) => match a.iter().map(js_int).collect::<Option<Vec<_>>>() {
            Some(list) => list.into_iter().map(|n| n as u32).collect(),
            None => (0..a.len() as u32).collect(),
        },
        c => (0..js_int(c).filter(|&n| n > 0).unwrap_or(0) as u32).collect(),
    }
}

pub fn parse_trigger_config(msg: &Value, info: &Value) -> Result<TriggerConfig, String> {
    let t = match get(msg, "triggerOn") {
        Some(t @ Value::Object(_)) => t,
        _ => return Err("triggerOn is missing".into()),
    };
    // the trigger channel and the conditions name device channels, which are their bit in the stream
    let captured = captured_channels(msg, info);
    let Some(&last) = captured.last() else { return Err("cannot determine the number of captured channels".into()) };
    let is_captured = |ch: i64| ch >= 0 && captured.contains(&(ch as u32));
    let channel = js_int(&t["channel"]).filter(|&c| is_captured(c)).ok_or("bad trigger channel: it is not captured")?;
    let kind = t["type"].as_str().filter(|k| TRIGGER_TYPES.contains(k)).ok_or("bad trigger type")?.to_string();
    let mut pulse_length = 0;
    if kind == "PulseH" || kind == "PulseL" {
        pulse_length = js_int(&t["pulseLength"]).filter(|&n| n >= 1).ok_or("bad pulseLength")? as u64;
    }
    let mut conditions = Vec::new();
    if let Some(c) = t.get("conditions") {
        let Value::Object(map) = c else { return Err("bad trigger conditions".into()) };
        for (key, level) in map {
            let ch = key.trim().parse::<f64>().ok().filter(|f| f.fract() == 0.0 && !key.trim().is_empty()).map(|f| f as i64);
            let Some(ch) = ch.filter(|&c| is_captured(c) && c != channel) else {
                return Err("bad trigger condition channel: it is not captured or it is the trigger channel".into());
            };
            let hi = match level.as_str() {
                Some("hi") => true,
                Some("lo") => false,
                _ => return Err("bad trigger condition level".into()),
            };
            conditions.push((ch as u32, hi));
        }
    }
    let count = |key: &str| -> Result<u64, String> {
        match get(msg, key) {
            None => Ok(0),
            Some(v) => js_int(v).filter(|&n| n >= 0).map(|n| n as u64).ok_or(format!("bad {key}")),
        }
    };
    let (pre, post) = (count("preTrigger")?, count("postTrigger")?);
    if let Some(r) = msg.get("samplerate") {
        if !r.as_f64().is_some_and(|f| f > 0.0) {
            return Err("bad samplerate".into());
        }
    }
    let unit = sample_bytes(&captured);
    if (pre as u128 * 2 + 1 + post as u128) * unit as u128 > MAX_CAPTURE_BYTES as u128 {
        return Err("pre/post trigger too large".into());
    }
    Ok(TriggerConfig {
        opts: TriggerOptions { unit, channel: channel as u32, kind, pulse_length, conditions, pre, post },
        channel_count: last + 1,
        samplerate: msg.get("samplerate").cloned(),
    })
}

/* ============================== glue to a device ============================== */

struct TrigInner {
    cap: TriggerCapture,
    finished: bool,
    user_stopped: bool,
}

struct Triggered {
    inner: Mutex<TrigInner>,
    events: EventsRef,
    kind: Arc<dyn DeviceKind>,
    unit: usize,
    channel_count: u32,
    samplerate: Option<Value>,
}

impl Triggered {
    /// Sends the capture like an ordinary one. Called without the lock held (the device's stop() may call back).
    fn deliver(&self, res: CaptureResult, stopped: bool) {
        self.kind.stop();
        for (k, piece) in res.data.chunks(STREAM_SAMPLES * self.unit).enumerate() {
            self.events.data(piece, (k * STREAM_SAMPLES) as u64);
        }
        let mut info = Map::new();
        info.insert("samples".into(), res.samples.into());
        if let Some(r) = &self.samplerate {
            info.insert("samplerate".into(), r.clone());
        }
        info.insert("channels".into(), self.channel_count.into());
        info.insert("trigger".into(), res.trigger.into());
        info.insert("stopped".into(), stopped.into());
        info.insert("ok".into(), true.into());
        self.events.done(Value::Object(info));
    }

    fn stop(&self) {
        let partial = {
            let mut g = self.inner.lock().unwrap();
            if g.finished {
                return;
            }
            g.user_stopped = true;
            g.finished = true;
            g.cap.partial() // keep what we have: pre + trigger + partial post
        };
        match partial {
            Some(p) => self.deliver(p, true),
            None => self.kind.stop(), // never triggered: nothing to deliver
        }
    }
}

/// The device's events during a triggered capture.
struct TrigEvents(Arc<Triggered>);

impl Events for TrigEvents {
    fn data(&self, chunk: &[u8], _offset: u64) -> bool {
        let t = &self.0;
        let (fired, result) = {
            let mut g = t.inner.lock().unwrap();
            if g.finished {
                return true; // the device may still flush data after stop()
            }
            let was_armed = g.cap.state == CaptureState::Armed;
            let complete = g.cap.push(chunk);
            let fired = (was_armed && g.cap.state != CaptureState::Armed).then_some(g.cap.engine.fire_index);
            let result = complete.then(|| {
                g.finished = true;
                g.cap.result()
            });
            (fired, result)
        };
        if let Some(sample) = fired {
            t.events.status(json!({ "state": "triggered", "sample": sample }));
        }
        if let Some(res) = result {
            t.deliver(res, false);
        }
        true
    }

    /// The device ended by itself (or after our stop()).
    fn done(&self, _info: Value) {
        let t = &self.0;
        let (partial, user_stopped) = {
            let mut g = t.inner.lock().unwrap();
            if g.finished {
                return;
            }
            g.finished = true;
            (g.cap.partial(), g.user_stopped)
        };
        match partial {
            Some(p) => t.deliver(p, user_stopped),
            None if !user_stopped => t.events.error("capture ended before the trigger fired", None),
            None => {}
        }
    }

    fn error(&self, message: &str, details: Option<&str>) {
        let t = &self.0;
        {
            let mut g = t.inner.lock().unwrap();
            if g.finished {
                return;
            }
            g.finished = true;
        }
        t.events.error(message, details);
    }
}

/// Runs `kind` continuously, waits for the trigger and delivers the finished capture through `events`
/// like an ordinary capture (done: { samples, samplerate?, channels, trigger, stopped, ok }).
/// None when the config was rejected (events.error has been called).
pub fn start_triggered(info: &Value, kind: Arc<dyn DeviceKind>, msg: &Value, events: EventsRef) -> Option<Session> {
    let cfg = match parse_trigger_config(msg, info) {
        Ok(c) => c,
        Err(e) => {
            events.error(&e, None);
            return None;
        }
    };
    // the device runs until we stop it: it must not be given a sample count
    let mut device_msg = msg.clone();
    if let Some(m) = device_msg.as_object_mut() {
        for k in ["samplecount", "triggerOn", "preTrigger", "postTrigger"] {
            m.remove(k);
        }
    }
    let t = Arc::new(Triggered {
        inner: Mutex::new(TrigInner { cap: TriggerCapture::new(&cfg.opts), finished: false, user_stopped: false }),
        events: events.clone(),
        kind: kind.clone(),
        unit: cfg.opts.unit,
        channel_count: cfg.channel_count,
        samplerate: cfg.samplerate,
    });
    events.status(json!({ "state": "armed" }));
    kind.start(&device_msg, Arc::new(TrigEvents(t.clone())));
    Some(Box::new(move || t.stop()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(unit: usize, channel: u32, kind: &str, len: u64, pre: u64, post: u64) -> TriggerOptions {
        TriggerOptions { unit, channel, kind: kind.into(), pulse_length: len, conditions: vec![], pre, post }
    }

    /// xorshift, so the random tests need no dependency
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn chance(&mut self, p: f64) -> bool {
            (self.next() % 1_000_000) as f64 / 1e6 < p
        }
    }

    fn bit(s: &[u8], unit: usize, ch: u32, i: usize) -> u8 {
        (s[i * unit + (ch >> 3) as usize] >> (ch & 7)) & 1
    }

    /// Brute-force reference: first sample g >= pre where the trigger condition holds.
    fn reference(s: &[u8], unit: usize, ch: u32, kind: &str, len: u64, pre: u64) -> Option<usize> {
        let n = s.len() / unit;
        for g in (pre as usize).max(1)..n {
            let (cur, prev) = (bit(s, unit, ch, g), bit(s, unit, ch, g - 1));
            match kind {
                "L2H" if prev == 0 && cur == 1 => return Some(g),
                "H2L" if prev == 1 && cur == 0 => return Some(g),
                "PulseH" | "PulseL" => {
                    let lvl = (kind == "PulseH") as u8;
                    if cur != lvl || (g as i64 - len as i64 + 1) < 1 {
                        continue;
                    }
                    let st = g + 1 - len as usize;
                    if bit(s, unit, ch, st - 1) != lvl && (st..=g).all(|k| bit(s, unit, ch, k) == lvl) {
                        return Some(g);
                    }
                }
                _ => {}
            }
        }
        None
    }

    #[test]
    fn random_streams_against_reference() {
        let mut r = Rng(0x9E3779B97F4A7C15);
        let mut checked = 0;
        for iter in 0..1500 {
            let unit = 1 + iter % 4;
            let ch = r.below(unit as u64 * 8) as u32;
            let kind = TRIGGER_TYPES[r.below(4) as usize];
            let len = 1 + r.below(6);
            let (pre, post) = (r.below(40), r.below(40));
            let mut cur: Vec<u8> = (0..unit).map(|_| r.below(256) as u8).collect();
            let mut s = Vec::new();
            for _ in 0..400 {
                if r.chance(0.06) {
                    let b = r.below(unit as u64) as usize;
                    cur[b] ^= 1 << r.below(8);
                }
                s.extend_from_slice(&cur);
            }
            let g = reference(&s, unit, ch, kind, len, pre);
            let mut cap = TriggerCapture::new(&opts(unit, ch, kind, len, pre, post));
            let mut pos = 0;
            let mut done = false;
            while pos < s.len() && !done {
                let n = match iter % 3 {
                    0 => 1,
                    1 => unit * (1 + r.below(30) as usize),
                    _ => 1 + r.below(90) as usize,
                };
                let end = (pos + n).min(s.len());
                done = cap.push(&s[pos..end]);
                pos = end;
            }
            let enough = g.is_some_and(|g| g + (post as usize) < s.len() / unit);
            if !enough {
                assert!(!done, "iter {iter}: should not be complete");
                continue;
            }
            let g = g.unwrap();
            assert!(done, "iter {iter} {kind}: not complete");
            let res = cap.result();
            assert_eq!(res.samples, pre + 1 + post);
            assert_eq!(res.trigger, pre);
            assert_eq!(res.data, s[(g - pre as usize) * unit..(g + post as usize + 1) * unit].to_vec(), "iter {iter} {kind}");
            assert_eq!(cap.engine.fire_index, g as i64);
            checked += 1;
        }
        assert!(checked > 300, "only {checked} captures were checked");
    }

    #[test]
    fn trigger_before_pre_window_is_ignored() {
        let lv = [0u8, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        let mut cap = TriggerCapture::new(&opts(1, 0, "L2H", 0, 5, 2));
        assert!(cap.push(&lv));
        assert_eq!(cap.result().data, lv[5..13].to_vec());
        assert_eq!(cap.engine.fire_index, 10);
    }

    #[test]
    fn pulses() {
        let mut cap = TriggerCapture::new(&opts(1, 0, "PulseH", 4, 1, 1));
        let mut done = false;
        for v in [0u8, 1, 1, 1, 1, 0, 0] {
            done = cap.push(&[v]);
        }
        assert!(done);
        assert_eq!(cap.engine.fire_index, 4);
        assert_eq!(cap.result().data, vec![1, 1, 0]);

        let mut cap = TriggerCapture::new(&opts(1, 0, "PulseH", 3, 0, 0));
        assert!(!cap.push(&[1, 1, 1, 1, 1, 0, 0])); // high from the start: length unknown
        assert!(cap.push(&[1, 1, 1]));

        let mut cap = TriggerCapture::new(&opts(1, 2, "H2L", 0, 0, 0));
        assert!(cap.push(&[4, 4, 0, 0]));
        assert_eq!(cap.result().data, vec![0]);
    }

    #[test]
    fn conditions() {
        let lv = [0u8, 0, 1, 0, 0, 3, 0, 0, 7, 0];
        for (conds, want) in [(vec![(1, true)], 5), (vec![(1, true), (2, true)], 8), (vec![(1, false)], 2)] {
            let mut o = opts(1, 0, "L2H", 0, 0, 0);
            o.conditions = conds;
            let mut cap = TriggerCapture::new(&o);
            cap.push(&lv);
            assert_eq!(cap.engine.fire_index, want);
        }
        // 2 bytes per sample, PulseL 2 on ch0, condition ch12 (bit 4 of byte 1) high
        let bytes = [1u8, 0, 0, 0, 0, 0, 1, 0, 0, 0x10, 0, 0x10, 1, 0];
        let mut o = opts(2, 0, "PulseL", 2, 1, 0);
        o.conditions = vec![(12, true)];
        let mut cap = TriggerCapture::new(&o);
        assert!(cap.push(&bytes));
        assert_eq!(cap.engine.fire_index, 5);
    }

    #[test]
    fn config_validation() {
        let dev = json!({ "channels": 8 });
        let ok = parse_trigger_config(&json!({ "triggerOn": { "channel": 0, "type": "L2H", "conditions": { "3": "hi", "4": "lo" } } }), &dev).unwrap();
        assert_eq!(ok.opts.conditions, vec![(3, true), (4, false)]);
        for c in [json!({ "0": "hi" }), json!({ "8": "hi" }), json!({ "1": "high" }), json!({ "x": "lo" }), json!([]), json!(null)] {
            assert!(parse_trigger_config(&json!({ "triggerOn": { "channel": 0, "type": "L2H", "conditions": c } }), &dev).is_err(), "{c}");
        }
        for m in [
            json!({ "channels": 8, "triggerOn": { "channel": 8, "type": "L2H" } }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "Rising" } }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "PulseH" } }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "PulseL", "pulseLength": 0 } }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "L2H" }, "preTrigger": -1 }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "L2H" }, "postTrigger": 1.5 }),
            json!({ "channels": 8, "triggerOn": { "channel": 0, "type": "L2H" }, "preTrigger": 1e12 }),
        ] {
            assert!(parse_trigger_config(&m, &dev).is_err(), "{m}");
        }
        assert!(parse_trigger_config(&json!({ "triggerOn": { "channel": 1, "type": "H2L" }, "channels": ["D0", "D1"] }), &dev).is_ok());
        // device indexes: the trigger channel is its bit in the stream
        let d8 = json!({ "channels": (0..8).map(|i| json!({ "index": i })).collect::<Vec<_>>() });
        let cfg = parse_trigger_config(&json!({ "channels": [0, 3, 5], "triggerOn": { "channel": 5, "type": "L2H", "conditions": { "3": "hi" } } }), &d8).unwrap();
        assert_eq!((cfg.opts.channel, cfg.channel_count), (5, 6));
        let mut cap = TriggerCapture::new(&TriggerOptions { pre: 0, post: 0, ..cfg.opts });
        cap.push(&[0, 0, 0b100000, 0, 0b101000, 0]);
        assert_eq!(cap.engine.fire_index, 4);
        assert!(parse_trigger_config(&json!({ "channels": [0, 3], "triggerOn": { "channel": 5, "type": "L2H" } }), &d8).unwrap_err().contains("not captured"));
    }

    /* ---------- glue with a fake device ---------- */

    #[derive(Default)]
    struct Rec {
        data: Mutex<Vec<(Vec<u8>, u64)>>,
        done: Mutex<Option<Value>>,
        errors: Mutex<Vec<String>>,
        status: Mutex<Vec<Value>>,
    }
    impl Events for Rec {
        fn data(&self, c: &[u8], off: u64) -> bool {
            self.data.lock().unwrap().push((c.to_vec(), off));
            true
        }
        fn done(&self, i: Value) {
            *self.done.lock().unwrap() = Some(i);
        }
        fn error(&self, m: &str, _d: Option<&str>) {
            self.errors.lock().unwrap().push(m.into());
        }
        fn status(&self, s: Value) {
            self.status.lock().unwrap().push(s);
        }
    }

    #[derive(Default)]
    struct Fake {
        started: Mutex<Option<(Value, EventsRef)>>,
        stops: Mutex<u32>,
    }
    impl DeviceKind for Fake {
        fn start(&self, msg: &Value, ev: EventsRef) -> Option<Session> {
            *self.started.lock().unwrap() = Some((msg.clone(), ev));
            None
        }
        fn stop(&self) {
            *self.stops.lock().unwrap() += 1;
        }
    }
    fn ev_of(f: &Fake) -> EventsRef {
        f.started.lock().unwrap().as_ref().unwrap().1.clone()
    }

    #[test]
    fn whole_capture_delivered_with_status() {
        let lv: Vec<u8> = (0..200).map(|i| (i >= 120) as u8).collect();
        let fake = Arc::new(Fake::default());
        let rec = Arc::new(Rec::default());
        let msg = json!({ "samplerate": 1000, "channels": 8, "samplecount": 999, "triggerOn": { "channel": 0, "type": "L2H" }, "preTrigger": 30, "postTrigger": 20 });
        let h = start_triggered(&json!({ "channels": 8 }), fake.clone(), &msg, rec.clone());
        assert!(h.is_some());
        assert!(fake.started.lock().unwrap().as_ref().unwrap().0.get("samplecount").is_none());
        let ev = ev_of(&fake);
        ev.data(&lv[..77], 0);
        ev.data(&lv[77..], 77);
        assert_eq!(*fake.stops.lock().unwrap(), 1);
        let st = rec.status.lock().unwrap().clone();
        assert_eq!(st, vec![json!({ "state": "armed" }), json!({ "state": "triggered", "sample": 120 })]);
        let all: Vec<u8> = rec.data.lock().unwrap().iter().flat_map(|d| d.0.clone()).collect();
        assert_eq!(all, lv[90..141].to_vec());
        let done = rec.done.lock().unwrap().clone().unwrap();
        assert_eq!((done["samples"].as_u64(), done["trigger"].as_u64(), done["samplerate"].as_u64(), done["channels"].as_u64()), (Some(51), Some(30), Some(1000), Some(8)));
        ev.done(json!({ "stopped": true })); // the device's own "done" after stop() is ignored
        assert!(rec.errors.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_before_and_after_trigger() {
        let fake = Arc::new(Fake::default());
        let rec = Arc::new(Rec::default());
        let msg = json!({ "samplerate": 1000, "channels": 8, "triggerOn": { "channel": 0, "type": "L2H" }, "preTrigger": 3, "postTrigger": 10 });
        let h = start_triggered(&json!({}), fake.clone(), &msg, rec.clone()).unwrap();
        ev_of(&fake).data(&[0, 0, 0, 0], 0);
        h();
        assert_eq!(*fake.stops.lock().unwrap(), 1);
        assert!(rec.done.lock().unwrap().is_none() && rec.errors.lock().unwrap().is_empty());

        let fake = Arc::new(Fake::default());
        let rec = Arc::new(Rec::default());
        let h = start_triggered(&json!({}), fake.clone(), &msg, rec.clone()).unwrap();
        ev_of(&fake).data(&[0, 0, 0, 0, 1, 1, 1], 0); // trigger at 4, 2 more samples after it
        h();
        let done = rec.done.lock().unwrap().clone().unwrap();
        assert_eq!((done["samples"].as_u64(), done["stopped"].as_bool(), done["trigger"].as_u64()), (Some(6), Some(true), Some(3)));
        let all: Vec<u8> = rec.data.lock().unwrap().iter().flat_map(|d| d.0.clone()).collect();
        assert_eq!(all, vec![0, 0, 0, 1, 1, 1]);
    }

    #[test]
    fn twelve_channels_two_bytes() {
        let mut bytes = Vec::new();
        for i in 0..50 {
            bytes.extend_from_slice(&[0x00, if i >= 25 { 0x08 } else { 0 }]);
        }
        let fake = Arc::new(Fake::default());
        let rec = Arc::new(Rec::default());
        start_triggered(&json!({}), fake.clone(), &json!({ "channels": 12, "triggerOn": { "channel": 11, "type": "L2H" }, "preTrigger": 5, "postTrigger": 4 }), rec.clone());
        ev_of(&fake).data(&bytes, 0);
        assert_eq!(rec.done.lock().unwrap().as_ref().unwrap()["samples"].as_u64(), Some(10));
        assert_eq!(rec.data.lock().unwrap()[0].0, bytes[40..60].to_vec());
    }
}
