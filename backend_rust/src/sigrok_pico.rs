//! Port of PicoCoderSigrokPicoDevice.js - Raspberry Pi Pico boards running pico-coder's sigrok-pico firmware
//! (https://github.com/pico-coder/sigrok-pico), talking the board's own serial protocol (no sigrok-cli).
//!
//!   scan() -> one device per board: the Pico SDK USB serial ports (2e8a:000a) that answer the identify command
//!
//! The board streams: with a sample count it runs a fixed capture ('F'), without one it runs until it is
//! stopped ('C'), so Looping, One shot and the trigger (trigger.rs, on the stream) all work. It has no trigger
//! of its own. Protocol (TECHNICAL.md and sr_device.c in the firmware):
//!   '*' reset, '+' stop a capture: single characters. Other commands end with '\n':
//!   i -> "SRPICO,A<nn><s>D<nn>,<vv>"    R<rate> / L<count> / D<en><ch> / A<en><ch> -> '*' (nothing when refused)
//!   F / C start a fixed / continuous capture. Data: see SampleDecoder. The end: "$<byte count>+";
//!   an overflow: "!!!" then "$0+".

use crate::channels::channel_packer;
use crate::device::{get, js_int, latin1, DeviceKind, EventsRef, Session};
use crate::link::{usb_ports, Link};
use regex_lite::Regex;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const USB_ID: (u16, u16) = (0x2e8a, 0x000a); // Raspberry Pi, Pico SDK USB serial
const REPLY_TIMEOUT: Duration = Duration::from_millis(1000);
const SETTLE: Duration = Duration::from_millis(100); // after a stop / reset before the board is talked to
const STOP_WAIT: Duration = Duration::from_millis(2000); // a stopped board may take this long to send the rest
const DATA_TIMEOUT_MS: f64 = 5000.0; // more than the board needs to fill its buffer before it is given up
const MIN_RATE: u64 = 5000;
const MAX_RATE: u64 = 120_000_000;
const DMA_BUF_SIZE: u64 = 220_000; // bytes, RP2040 (an RP2350 has 476000; the board does not say which it is)
const OUT_SAMPLES: usize = 65536; // samples per on_samples() call at most
// Always enabled, at least: with only D0-D3 enabled the board uses its 4-bit mode, which sends wrong data.
const MIN_HIGHEST: u32 = 4;

/* ============================== protocol ============================== */

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Dev {
    pub analog_count: u32,
    pub channel_count: u32,
    pub version: String,
}

/// The answer to 'i', e.g. "SRPICO,A031D21,02" (3 analog channels, 21 digital). None when it is not one.
pub fn parse_identity(text: &str) -> Option<Dev> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let m = RE.get_or_init(|| Regex::new(r"SRPICO,A(\d\d)\dD(\d\d),(\d\d)").unwrap()).captures(text)?;
    Some(Dev { analog_count: m[1].parse().ok()?, channel_count: m[2].parse().ok()?, version: m[3].to_string() })
}

/// The GPIO pin of each digital channel, as the firmware's builds map them.
pub fn pin_names(channel_count: u32) -> Vec<String> {
    (0..channel_count)
        .map(|i| format!("GP{}", if channel_count == 21 { i + 2 } else if channel_count == 26 && i > 22 { i + 3 } else { i }))
        .collect()
}

/// Bytes the board stores per sample, from the highest enabled channel.
fn stored_bytes(highest: u32) -> u64 {
    if highest < 8 { 1 } else if highest < 16 { 2 } else { 4 }
}

/// The longest fixed capture that fits the board's buffer, in samples (the firmware's own calculation).
pub fn buffer_samples(highest: u32, buf_size: u64) -> u64 {
    let nibbles = stored_bytes(highest) * 2;
    let chunk_bytes = 32 * nibbles * nibbles;
    let chunk_samples = chunk_bytes * 2 / nibbles;
    let chunks = (buf_size / chunk_bytes) & !1;
    (chunks - 2) * chunk_samples - 4
}

/// 1-2-5 steps from 5 kHz to 100 MHz, and 120 MHz (the firmware takes any even rate in between).
pub fn samplerates() -> Vec<u64> {
    let mut list = Vec::new();
    let mut decade = 1000;
    while decade <= MAX_RATE {
        for f in [decade, 2 * decade, 5 * decade] {
            if (MIN_RATE..=MAX_RATE).contains(&f) {
                list.push(f);
            }
        }
        decade *= 10;
    }
    list.push(MAX_RATE);
    list
}

#[derive(Debug, PartialEq)]
pub struct End {
    pub aborted: bool,
    pub byte_count: u64,
    pub received: u64,
}

/// Decodes the board's data (its byte mode): a sample is `bytes` bytes >= 0x80 of 7 bits each, low bits first;
/// 48..79 = (b - 47) repeats of the previous sample, 80..127 = (b - 78) * 32 repeats.
/// '!' = the board aborted (overflow); '$' starts the end mark "$<byte count>+".
pub struct SampleDecoder {
    bytes: u32,
    last: Option<u32>,
    acc: u32,
    acc_bytes: u32,
    out: Vec<u32>,
    received: u64,
    aborted: bool,
    count: Option<String>,
    pub ended: bool,
}

impl SampleDecoder {
    pub fn new(bytes: u32) -> Self {
        Self { bytes, last: None, acc: 0, acc_bytes: 0, out: Vec::with_capacity(OUT_SAMPLES), received: 0, aborted: false, count: None, ended: false }
    }

    fn emit(&mut self, v: u32, times: u64, on_samples: &mut dyn FnMut(&[u32])) {
        for _ in 0..times {
            self.out.push(v);
            if self.out.len() == OUT_SAMPLES {
                self.flush(on_samples);
            }
        }
    }

    fn flush(&mut self, on_samples: &mut dyn FnMut(&[u32])) {
        if !self.out.is_empty() {
            on_samples(&self.out);
            self.out.clear();
        }
    }

    /// The samples go to on_samples (at most OUT_SAMPLES at a time); Some(end) at the end mark.
    pub fn push(&mut self, buf: &[u8], on_samples: &mut dyn FnMut(&[u32])) -> Option<End> {
        let mut end = None;
        for &b in buf {
            if self.ended {
                break;
            }
            if let Some(digits) = &mut self.count {
                // in the end mark
                if b == b'+' {
                    let byte_count = digits.parse().unwrap_or(0);
                    self.ended = true;
                    self.flush(on_samples);
                    end = Some(End { aborted: self.aborted, byte_count, received: self.received });
                } else if b.is_ascii_digit() {
                    digits.push(b as char);
                }
                continue;
            }
            match b {
                b'$' => self.count = Some(String::new()),
                b'!' => self.aborted = true,
                0..=47 => {} // reserved
                _ => {
                    self.received += 1;
                    if b >= 0x80 {
                        self.acc |= u32::from(b & 0x7f) << (7 * self.acc_bytes);
                        self.acc_bytes += 1;
                        if self.acc_bytes == self.bytes {
                            let v = self.acc;
                            self.last = Some(v);
                            self.emit(v, 1, on_samples);
                            self.acc = 0;
                            self.acc_bytes = 0;
                        }
                    } else if let Some(v) = self.last {
                        let times = if b < 80 { u64::from(b) - 47 } else { (u64::from(b) - 78) * 32 };
                        self.emit(v, times, on_samples);
                    }
                }
            }
        }
        self.flush(on_samples);
        end
    }
}

#[derive(Debug)]
pub struct Plan {
    pub commands: Vec<String>,
    pub start: &'static str,
    pub count: Option<u64>,
    pub bytes: u32,
    pub first_data_ms: f64,
}

/// The board's settings for a start message (msg.channels is resolved). The board's channels must be enabled
/// from D0 up without gaps: D0..the highest requested channel (at least D0..D4) are captured.
pub fn plan_capture(msg: &Value, dev: &Dev) -> Result<Plan, String> {
    let rate = js_int(&msg["samplerate"])
        .filter(|&r| r >= MIN_RATE as i64 && r <= MAX_RATE as i64)
        .ok_or(format!("the samplerate must be between {MIN_RATE} and {MAX_RATE} Hz"))? as u64;
    let top = msg["channels"].as_array().and_then(|a| a.last()).and_then(Value::as_u64).ok_or("bad channel list")? as u32;
    if top >= dev.channel_count {
        return Err("bad channel list".into());
    }
    let highest = top.max(MIN_HIGHEST).min(dev.channel_count - 1); // the highest enabled
    let count = match get(msg, "samplecount") {
        None => None,
        Some(v) => Some(js_int(v).filter(|&n| n > 0).ok_or("bad samplecount")? as u64),
    };
    let mut commands = vec![format!("R{}", rate - rate % 2)]; // the firmware uses even rates only
    for ch in 0..dev.channel_count {
        commands.push(format!("D{}{ch:02}", (ch <= highest) as u8));
    }
    for ch in 0..dev.analog_count {
        commands.push(format!("A0{ch:02}"));
    }
    // the board captures at least 16 samples, a multiple of 4: the extra ones are not sent on
    if let Some(c) = count {
        commands.push(format!("L{}", 16.max(c.div_ceil(4) * 4)));
    }
    Ok(Plan {
        commands,
        start: if count.is_some() { "F" } else { "C" },
        count,
        bytes: (highest + 1).div_ceil(7),
        // the most the board may take before it sends anything: filling its whole buffer (an RP2350's is larger)
        first_data_ms: buffer_samples(highest, 476_000) as f64 / rate as f64 * 1000.0 + DATA_TIMEOUT_MS,
    })
}

/* ============================== connection ============================== */

/// Sends text and reads until `done(received)` gives a result.
fn ask<T>(link: &mut Link, text: &str, what: &str, done: impl Fn(&str) -> Option<T>) -> Result<T, String> {
    link.discard(); // what came before is not the answer (Node drops data while nobody listens)
    link.send(text.as_bytes())?;
    link.read_until(REPLY_TIMEOUT, |got| done(&latin1(got)))?.ok_or(format!("no answer to {what}"))
}

/// Stop the board (it may still be capturing from before), reset it, and throw away what it still sends.
fn reset(link: &mut Link) -> Result<(), String> {
    link.send(b"+")?;
    thread::sleep(SETTLE);
    link.send(b"*")?;
    thread::sleep(SETTLE);
    link.discard();
    Ok(())
}

fn identify(link: &mut Link) -> Result<Dev, String> {
    ask(link, "i\n", "the identify command: is it a sigrok-pico board?", parse_identity)
}

fn command(link: &mut Link, cmd: &str) -> Result<(), String> {
    ask(link, &format!("{cmd}\n"), &format!("\"{cmd}\" (the board refused it)"), |got| got.contains('*').then_some(()))
}

/* ============================== device kind ============================== */

struct Sess {
    stopped: AtomicBool,
    finished: AtomicBool,
    sent: AtomicU64,
    events: EventsRef,
    samplerate: Value,
}

struct Inner {
    conn: String,
    dev: Mutex<Dev>,
    exclusive: Mutex<()>,
    session: Mutex<Option<Arc<Sess>>>,
}

#[derive(Clone)]
pub struct SigrokPicoKind(Arc<Inner>);

/// (warning, details) at the end of a capture
type Ending = Option<(String, String)>;

impl Inner {
    fn busy(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    fn finish(&self, s: &Arc<Sess>, f: impl FnOnce()) {
        if s.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let mut g = self.session.lock().unwrap();
            if g.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, s)) {
                *g = None;
            }
        }
        f();
    }

    fn done(&self, s: &Arc<Sess>, stopped: bool, ending: Ending) {
        self.finish(s, || {
            let mut info = Map::new();
            info.insert("deviceId".into(), self.conn.clone().into());
            info.insert("samples".into(), s.sent.load(Ordering::SeqCst).into());
            info.insert("samplerate".into(), s.samplerate.clone());
            info.insert("stopped".into(), stopped.into());
            info.insert("ok".into(), true.into());
            if let Some((warning, details)) = ending {
                info.insert("warning".into(), warning.into());
                info.insert("details".into(), details.into());
            }
            s.events.done(Value::Object(info));
        });
    }

    fn stop_session(&self, s: &Arc<Sess>) {
        if s.finished.load(Ordering::SeqCst) || s.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // the capture thread sees the flag and sends '+'
        self.done(s, true, None);
    }

    fn probe(&self) -> Result<(), String> {
        let _x = self.exclusive.lock().unwrap();
        let mut link = Link::open(&self.conn, REPLY_TIMEOUT)?;
        reset(&mut link)?;
        *self.dev.lock().unwrap() = identify(&mut link)?;
        Ok(())
    }

    /// One capture: connect, reset, set up, start, read until the end mark.
    fn run(&self, s: &Arc<Sess>, plan: &Plan, msg: &Value, channels: &[u32]) -> Result<Ending, String> {
        if s.stopped.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let mut link = Link::open(&self.conn, REPLY_TIMEOUT)?;
        let result = self.capture(&mut link, s, plan, msg, channels);
        let _ = link.send(b"+*");
        result
    }

    fn capture(&self, link: &mut Link, s: &Arc<Sess>, plan: &Plan, msg: &Value, channels: &[u32]) -> Result<Ending, String> {
        let stopped = || s.stopped.load(Ordering::SeqCst);
        reset(link)?;
        *self.dev.lock().unwrap() = identify(link)?; // also checks that it still is a sigrok-pico board
        for cmd in &plan.commands {
            if stopped() {
                return Ok(None);
            }
            command(link, cmd)?;
        }
        if stopped() {
            return Ok(None);
        }
        // the board sends channels 0..highest (bit n = channel n): the ones not requested are cleared
        let repack = channel_packer(4, channels, None);
        let first_data = Duration::from_secs_f64(plan.first_data_ms / 1000.0);
        let mut timer = (Instant::now() + first_data, "the board sends no data");
        let mut decoder = SampleDecoder::new(plan.bytes);
        let mut stop_sent = false;
        link.send(format!("{}\n", plan.start).as_bytes())?;
        let mut buf = vec![0u8; 64 * 1024];
        // a stop (or an error after it) ends the capture without an error: done was already sent
        let quiet = |r: Result<Ending, String>| if stopped() { Ok(None) } else { r };
        loop {
            // a stop: the board sends what it still has and its end mark; give it STOP_WAIT for that
            if stopped() && !stop_sent {
                let _ = link.send(b"+");
                stop_sent = true;
                timer = (Instant::now() + STOP_WAIT, "stopped");
            }
            if Instant::now() >= timer.0 {
                return quiet(Err(timer.1.to_string()));
            }
            let n = match link.recv(&mut buf) {
                Ok(n) => n,
                Err(e) => return quiet(Err(e)),
            };
            if n == 0 {
                continue;
            }
            let end = decoder.push(&buf[..n], &mut |values: &[u32]| {
                if stopped() {
                    return;
                }
                let sent = s.sent.load(Ordering::SeqCst);
                let want = plan.count.map_or(values.len() as u64, |c| (values.len() as u64).min(c.saturating_sub(sent))) as usize;
                if want == 0 {
                    return;
                }
                let bytes: Vec<u8> = values[..want].iter().flat_map(|v| v.to_le_bytes()).collect();
                s.events.data(&repack.run(&bytes), sent);
                s.sent.store(sent + want as u64, Ordering::SeqCst);
            });
            if !decoder.ended && !stopped() {
                timer = (Instant::now() + first_data, "the board stopped sending data");
            }
            let Some(end) = end else { continue };
            if stopped() {
                return Ok(None);
            }
            let sent = s.sent.load(Ordering::SeqCst);
            let top = channels.last().copied().unwrap_or(0);
            let how = format!("{} Hz, channels up to D{top}: {} data bytes, the board counted {}",
                crate::device::js_display(&msg["samplerate"]), end.received, end.byte_count);
            return Ok(if end.aborted {
                Some((format!("The board could not send the samples fast enough and stopped after {sent} samples: use a lower samplerate or fewer channels"), how))
            } else if end.byte_count != end.received {
                Some((format!("{} bytes from the board were lost: the capture may have gaps", end.byte_count.abs_diff(end.received)), how))
            } else if plan.count.is_some_and(|c| sent < c) {
                Some((format!("The board sent only {sent} of {} samples", plan.count.unwrap()), how))
            } else {
                None
            });
        }
    }
}

impl SigrokPicoKind {
    pub fn new(conn: &str) -> Self {
        Self(Arc::new(Inner { conn: conn.into(), dev: Mutex::new(Dev::default()), exclusive: Mutex::new(()), session: Mutex::new(None) }))
    }

    /// Device info for the browser.
    pub fn describe(&self) -> Value {
        let dev = self.0.dev.lock().unwrap().clone();
        let conn = &self.0.conn;
        let buffer = |h| buffer_samples(h, DMA_BUF_SIZE);
        json!({
            "id": format!("sigrok-pico:{conn}"),
            "name": format!("sigrok-pico {}ch ({conn})", dev.channel_count),
            "channels": pin_names(dev.channel_count).into_iter().enumerate().map(|(i, name)| json!({ "index": i, "name": name, "type": "logic" })).collect::<Vec<_>>(),
            "samplerates": samplerates(),
            "defaultSamplerate": 1_000_000,
            "driver": "sigrok-pico",
            "note": format!("pico-coder sigrok-pico firmware, protocol {}. A Timer capture of up to {} samples (up to D7), {} (up to D15), {} (above) fits the board's buffer and works at any samplerate",
                dev.version, buffer(7), buffer(15), buffer(31)),
            // what the frontend can offer, see frontend/js/capture/captureLimits.js
            "limits": {
                "buffer": [
                    { "below": 8, "samples": buffer(7) },
                    { "below": 16, "samples": buffer(15) },
                    { "below": 32, "samples": buffer(31) },
                ],
                // the firmware's notes: 8 or more channels are reliable up to 60 MS/s
                "maxSamplerate": [{ "below": 7, "samplerate": MAX_RATE }, { "below": 32, "samplerate": 60_000_000 }],
            },
        })
    }
}

impl DeviceKind for SigrokPicoKind {
    fn start(&self, msg: &Value, events: EventsRef) -> Option<Session> {
        let inner = self.0.clone();
        if inner.busy() {
            events.error("sigrok-pico - the board is already capturing", None);
            return None;
        }
        let dev = inner.dev.lock().unwrap().clone();
        let plan = match plan_capture(msg, &dev) {
            Ok(p) => p,
            Err(e) => {
                events.error(&format!("sigrok-pico - {e}"), None);
                return None;
            }
        };
        let channels: Vec<u32> = msg["channels"].as_array().map(|a| a.iter().filter_map(|c| c.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
        let s = Arc::new(Sess {
            stopped: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            sent: AtomicU64::new(0),
            events,
            samplerate: msg["samplerate"].clone(),
        });
        *inner.session.lock().unwrap() = Some(s.clone());

        let (t_inner, t_s, msg) = (inner.clone(), s.clone(), msg.clone());
        thread::spawn(move || {
            let result = {
                let _x = t_inner.exclusive.lock().unwrap();
                t_inner.run(&t_s, &plan, &msg, &channels)
            };
            match result {
                Ok(ending) => t_inner.done(&t_s, false, ending),
                Err(e) => {
                    let version = t_inner.dev.lock().unwrap().version.clone();
                    let details = format!("{} (sigrok-pico protocol {version})\n\n{e}", t_inner.conn);
                    t_inner.finish(&t_s, || t_s.events.error(&format!("sigrok-pico - {e}"), Some(&details)));
                }
            }
        });
        Some(Box::new(move || inner.stop_session(&s)))
    }

    fn stop(&self) {
        let s = self.0.session.lock().unwrap().clone();
        if let Some(s) = s {
            self.0.stop_session(&s);
        }
    }
}

/* ============================== scan ============================== */

/// port -> kind: kept between scans, a capturing board is not probed
static KINDS: Mutex<Vec<SigrokPicoKind>> = Mutex::new(Vec::new());

pub fn scan() -> Vec<(Value, Arc<dyn DeviceKind>)> {
    let mut devices: Vec<(Value, Arc<dyn DeviceKind>)> = Vec::new();
    for conn in usb_ports(USB_ID.0, USB_ID.1) {
        let known = KINDS.lock().unwrap().iter().find(|k| k.0.conn == conn).cloned();
        let result = match &known {
            None => {
                let kind = SigrokPicoKind::new(&conn);
                kind.0.probe().map(|_| {
                    KINDS.lock().unwrap().push(kind.clone());
                    kind
                })
            }
            Some(kind) if !kind.0.busy() => kind.0.probe().map(|_| kind.clone()),
            Some(kind) => Ok(kind.clone()),
        };
        match result {
            Ok(kind) => devices.push((kind.describe(), Arc::new(kind))),
            // e.g. the port is in use by another program, or the board has other firmware
            Err(e) => eprintln!("sigrok-pico: no board on {conn}: {e}"),
        }
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev() -> Dev {
        Dev { analog_count: 3, channel_count: 21, version: "02".into() }
    }

    #[test]
    fn identity_pins_rates() {
        assert_eq!(parse_identity("junk*SRPICO,A031D21,02"), Some(dev()));
        assert_eq!(parse_identity("SRPICO,A001D32,02"), Some(Dev { analog_count: 0, channel_count: 32, version: "02".into() }));
        assert_eq!(parse_identity("LOGIC_ANALYZER_PICO_V6_0"), None);
        assert_eq!(pin_names(21)[..2], ["GP2", "GP3"]);
        assert_eq!(pin_names(26)[22..], ["GP22", "GP26", "GP27", "GP28"]);
        assert_eq!(pin_names(32)[31], "GP31");
        let rates = samplerates();
        assert_eq!((rates[0], *rates.last().unwrap()), (5000, 120_000_000));
        assert!(rates.iter().all(|r| r % 2 == 0));
    }

    #[test]
    fn buffer_sizes() {
        assert_eq!(buffer_samples(7, DMA_BUF_SIZE), 219_644);
        assert_eq!(buffer_samples(15, DMA_BUF_SIZE), 109_052);
        assert_eq!(buffer_samples(31, DMA_BUF_SIZE), 53_244);
    }

    #[test]
    fn plans() {
        let p = plan_capture(&json!({ "samplerate": 1_000_001, "channels": [2, 9], "samplecount": 10 }), &dev()).unwrap();
        assert_eq!(p.commands[0], "R1000000");
        assert_eq!(p.commands.iter().filter(|c| c.starts_with("D1")).count(), 10);
        assert!(p.commands.contains(&"D010".into()) && p.commands.contains(&"D020".into()) && p.commands.contains(&"A002".into()));
        assert_eq!(p.commands.last().unwrap(), "L16");
        assert_eq!((p.start, p.bytes), ("F", 2));
        let low = plan_capture(&json!({ "samplerate": 5000, "channels": [2] }), &dev()).unwrap();
        assert_eq!(low.commands.iter().filter(|c| c.starts_with("D1")).cloned().collect::<Vec<_>>(), ["D100", "D101", "D102", "D103", "D104"]);
        assert_eq!(low.bytes, 1);
        assert_eq!(plan_capture(&json!({ "samplerate": 5000, "channels": [0] }), &dev()).unwrap().start, "C");
        assert!(plan_capture(&json!({ "samplerate": 4000, "channels": [0] }), &dev()).unwrap_err().contains("samplerate"));
    }

    /// The firmware's encoder (send_slices_1B/2B/4B with check_rle()).
    fn encode(samples: &[u32], bytes: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let tx = |out: &mut Vec<u8>, mut v: u32| {
            for _ in 0..bytes {
                out.push(((v | 0x80) & 0xff) as u8);
                v >>= 7;
            }
        };
        let check_rle = |out: &mut Vec<u8>, rle: &mut u32| {
            while *rle >= 1568 {
                out.push(127);
                *rle -= 1568;
            }
            if *rle > 32 {
                let d = *rle >> 5;
                out.push((d + 78) as u8);
                *rle -= d << 5;
            }
            if *rle > 0 {
                out.push((47 + *rle) as u8);
                *rle = 0;
            }
        };
        let mut rle = 0;
        tx(&mut out, samples[0]);
        let mut last = samples[0];
        for &s in &samples[1..] {
            if s == last {
                rle += 1;
            } else {
                check_rle(&mut out, &mut rle);
                tx(&mut out, s);
            }
            last = s;
        }
        check_rle(&mut out, &mut rle);
        out
    }

    #[test]
    fn decoder_undoes_the_encoding_at_any_chunking() {
        const HALF: usize = 4096;
        let mut x = 7u64;
        let mut rnd = move || {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 33) as u32
        };
        let lengths = [1u32, 1, 2, 3, 7, 8, 9, 31, 32, 33, 100, 639, 641, 700, 1567, 1569, 2000, 5000];
        for highest in [4u32, 7, 13, 20, 31] {
            let mask = if highest == 31 { u32::MAX } else { (1u32 << (highest + 1)) - 1 };
            let mut samples = Vec::new();
            while samples.len() < 30_000 {
                let (len, v) = (lengths[rnd() as usize % lengths.len()], rnd() & mask);
                for _ in 0..len {
                    if samples.len() < 30_000 {
                        samples.push(v);
                    }
                }
            }
            let bytes = (highest + 1).div_ceil(7);
            let mut enc = Vec::new();
            for half in samples.chunks(HALF) {
                enc.extend(encode(half, bytes));
            }
            let mut stream = enc.clone();
            stream.extend(format!("${}+", enc.len()).bytes());
            let mut dec = SampleDecoder::new(bytes);
            let (mut got, mut end) = (Vec::new(), None);
            let mut p = 0;
            while p < stream.len() {
                let q = (p + 1 + rnd() as usize % 50).min(stream.len());
                if let Some(e) = dec.push(&stream[p..q], &mut |v: &[u32]| got.extend_from_slice(v)) {
                    end = Some(e);
                }
                p = q;
            }
            assert_eq!(got, samples, "highest D{highest}");
            assert_eq!(end, Some(End { aborted: false, byte_count: enc.len() as u64, received: enc.len() as u64 }));
        }
    }
}
