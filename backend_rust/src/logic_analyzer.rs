//! Port of LogicAnalyzerDevice.js - gusmanb/logicanalyzer boards (https://github.com/gusmanb/logicanalyzer,
//! firmware V6_x), talking the board's own protocol over USB serial or (WiFi builds) TCP.
//!
//!   scan() -> one device per board: the USB serial ports with the LogicAnalyzer's vendor / product id
//!             (1209:3020), plus the WiFi boards in env LOGICANALYZER_HOSTS ("192.168.1.20:4045,...")
//!
//! The board does not stream: it captures into its own memory and sends it when the capture is done, so it
//! triggers itself (hardware_trigger: main.rs does not use trigger.rs):
//!   L2H / H2L   the board's "edge" trigger, which really fires on the level
//!   PulseH / PulseL and other channel conditions are not supported
//! A capture without a trigger triggers on the board's external trigger input (GPIO1 on a Pico) being low,
//! which it is when nothing drives it (the pin's pull-down).
//! WiFi settings: a board with a WiFi firmware build (board name ending in WIFI) takes its network name,
//! password, IP address and port with command 2, over USB, and keeps them in its flash.

use crate::channels::packed_channel_packer;
use crate::device::{get, js_int, js_num, js_truthy, latin1, thousands, DeviceKind, EventsRef, Session};
use crate::device_settings::validate_settings;
use crate::link::{is_network, usb_ports, Link};
use regex_lite::Regex;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const USB_ID: (u16, u16) = (0x1209, 0x3020);
const MIN_MAJOR_VERSION: u32 = 6; // the CAPTURE_REQUEST layout below is the one of firmware V6_x
const REPLY_TIMEOUT: Duration = Duration::from_millis(5000); // the board may take this long to answer
const CANCEL_WAIT: Duration = Duration::from_millis(2500); // a capturing board only looks for the cancel byte every 2 s
const START_TIMEOUT_MS: f64 = 5000.0; // more than the capture itself before a capture without trigger is given up
const SKIP_UNTRIGGERED: u64 = 2; // pre-trigger samples asked for (and thrown away) in a capture without trigger

/* ============================== protocol ============================== */

/// A frame to the board: 0x55 0xAA, the payload with 0xAA / 0x55 / 0xF0 escaped as 0xF0 (b ^ 0xF0), 0xAA 0x55.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x55, 0xAA];
    for &b in payload {
        if b == 0xAA || b == 0x55 || b == 0xF0 {
            out.extend_from_slice(&[0xF0, b ^ 0xF0]);
        } else {
            out.push(b);
        }
    }
    out.extend_from_slice(&[0xAA, 0x55]);
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub trigger_type: u8, // 0 = edge (simple)
    pub trigger: u8,      // trigger channel, channel_count = the external trigger input
    pub inverted: bool,
    pub channels: Vec<u8>,
    pub frequency: u32,
    pub pre_samples: u32,
    pub post_samples: u32,
    pub capture_mode: u8, // 0 = 8 channels (1 byte per sample), 1 = 16 (2), 2 = 24 (4)
}

/// Command 1 + the firmware's CAPTURE_REQUEST struct (48 bytes, little endian, natural alignment).
pub fn capture_request(r: &Request) -> Vec<u8> {
    let mut b = vec![0u8; 1 + 48];
    b[0] = 1;
    b[1] = r.trigger_type;
    b[2] = r.trigger;
    b[3] = r.inverted as u8;
    // b[5..7]: triggerValue 0
    b[7..7 + r.channels.len()].copy_from_slice(&r.channels); // channels[24]
    b[31] = r.channels.len() as u8;
    b[33..37].copy_from_slice(&r.frequency.to_le_bytes());
    b[37..41].copy_from_slice(&r.pre_samples.to_le_bytes());
    b[41..45].copy_from_slice(&r.post_samples.to_le_bytes());
    // b[45] loopCount 0, b[46] measure 0
    b[47] = r.capture_mode;
    b
}

/// Command 2 + the firmware's WIFI_SETTINGS_REQUEST struct (116 bytes): apName[33], passwd[64], ipAddress[16]
/// (ASCII, zero padded), 1 byte padding, uint16 port (little endian).
pub fn wifi_settings_request(ssid: &str, password: &str, ip: &str, port: u16) -> Result<Vec<u8>, String> {
    let mut b = vec![0u8; 1 + 116];
    b[0] = 2;
    for (text, at, size) in [(ssid, 0, 33), (password, 33, 64), (ip, 97, 16)] {
        if !text.bytes().all(|c| (0x20..=0x7e).contains(&c)) || text.len() >= size {
            return Err(format!("\"{text}\" does not fit the board's settings"));
        }
        b[1 + at..1 + at + text.len()].copy_from_slice(text.as_bytes());
    }
    b[1 + 114..1 + 116].copy_from_slice(&port.to_le_bytes());
    Ok(b)
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Dev {
    pub board: String,
    pub version: String,
    pub max_frequency: u64,
    pub blast_frequency: u64,
    pub buffer_size: u64,
    pub channel_count: u64,
}

/// The answer to the ID request (5 lines): board name, version and limits.
pub fn parse_identity(lines: &[String]) -> Result<Dev, String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^LOGIC_ANALYZER_(.*?)_?V(\d+)_(\d+)$").unwrap());
    let first = lines.first().map(String::as_str).unwrap_or("");
    let m = re.captures(first).ok_or(format!("not a LogicAnalyzer board (it answered \"{first}\")"))?;
    let (board, major, minor) = (&m[1], &m[2], &m[3]);
    if major.parse::<u32>().unwrap_or(0) < MIN_MAJOR_VERSION {
        return Err(format!("firmware V{major}_{minor} is too old, V{MIN_MAJOR_VERSION}_0 or newer is needed"));
    }
    let value = |i: usize, key: &str| -> Result<u64, String> {
        let line = lines.get(i).map(String::as_str).unwrap_or("");
        line.strip_prefix(key)
            .and_then(|r| r.strip_prefix(':'))
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|d| d.parse().ok())
            .filter(|&n| n > 0)
            .ok_or(format!("bad {key} line from the board: \"{line}\""))
    };
    Ok(Dev {
        board: if board.is_empty() { "board".into() } else { board.into() },
        version: format!("V{major}_{minor}"),
        max_frequency: value(1, "FREQ")?,
        blast_frequency: value(2, "BLASTFREQ")?,
        buffer_size: value(3, "BUFFER")?,
        channel_count: value(4, "CHANNELS")?,
    })
}

/// The lowest samplerate the board can do (its PIO clock divider is 16 bits).
fn min_frequency(dev: &Dev) -> u64 {
    (dev.max_frequency * 2).div_ceil(65535)
}

/// 1-2-5 steps from the lowest to the highest samplerate: all of them divide the board's clock evenly.
pub fn samplerates(dev: &Dev) -> Vec<u64> {
    let mut list = Vec::new();
    let mut decade = 1;
    while decade <= dev.max_frequency {
        for f in [decade, 2 * decade, 5 * decade] {
            if f >= min_frequency(dev) && f <= dev.max_frequency {
                list.push(f);
            }
        }
        decade *= 10;
    }
    if list.last() != Some(&dev.max_frequency) {
        list.push(dev.max_frequency);
    }
    list
}

#[derive(Debug)]
pub struct Plan {
    pub request: Request,
    pub unit: usize,
    pub skip: u64,
    pub count: u64,
    pub trigger: Option<u64>,
    pub warning: Option<String>,
}

/// What to ask the board for, and which of the samples it sends back go to the browser. msg.channels is
/// already resolved. The board's capture = preSamples - 1 samples, the trigger sample, postSamples samples;
/// it is asked for at least 2 / 2 (the LogicAnalyzer software's minimum), the extra samples in front skipped.
pub fn plan_capture(msg: &Value, dev: &Dev) -> Result<Plan, String> {
    let channels: Vec<u8> = msg["channels"].as_array().map(|a| a.iter().filter_map(|c| c.as_u64().map(|n| n as u8)).collect()).unwrap_or_default();
    let max_channel = *channels.last().ok_or("bad channel list")?;
    let capture_mode = if max_channel < 8 { 0 } else if max_channel < 16 { 1 } else { 2 };
    let unit = [1usize, 2, 4][capture_mode as usize];
    let max_samples = dev.buffer_size / unit as u64;
    let memory = format!(
        "the board holds {max_samples} samples {}",
        ["with channels 1-8", "with channels up to 16", "with channels above 16"][capture_mode as usize]
    );
    let min = min_frequency(dev);
    let frequency = js_int(&msg["samplerate"])
        .filter(|&f| f >= min as i64 && f <= dev.max_frequency as i64)
        .ok_or(format!("the samplerate must be between {min} and {} Hz", dev.max_frequency))? as u32;
    let request = |trigger: u8, inverted: bool, pre: u64, post: u64| Request {
        trigger_type: 0, trigger, inverted, channels: channels.clone(), frequency,
        pre_samples: pre as u32, post_samples: post as u32, capture_mode,
    };

    if js_truthy(msg.get("triggerOn")) {
        let t = &msg["triggerOn"];
        let kind = t["type"].as_str().unwrap_or("");
        if kind != "L2H" && kind != "H2L" {
            return Err("the board only triggers on L2H / H2L".into());
        }
        let has_conditions = match &t["conditions"] {
            Value::Object(m) => !m.is_empty(),
            Value::Array(a) => !a.is_empty(),
            Value::String(s) => !s.is_empty(),
            _ => false,
        };
        if has_conditions {
            return Err("the board cannot check other channels at the trigger".into());
        }
        let ch = js_int(&t["channel"]).filter(|&c| c >= 0 && (c as u64) < dev.channel_count).ok_or("bad trigger channel")?;
        let count = |key: &str| -> Result<u64, String> {
            get(msg, key).map_or(Ok(0), |v| js_int(v).filter(|&n| n >= 0).map(|n| n as u64).ok_or(format!("bad {key}")))
        };
        let (pre, post) = (count("preTrigger")?, count("postTrigger")?);
        let (pre_samples, post_samples) = ((pre + 1).max(2), post.max(2));
        let max_pre = max_samples / 10; // the LogicAnalyzer software's limit
        if pre_samples > max_pre {
            return Err(format!("at most {} samples before the trigger: {memory}, a tenth of them before the trigger", max_pre as i64 - 1));
        }
        if pre_samples + post_samples > max_samples {
            return Err(format!("the capture is too long: {memory}"));
        }
        return Ok(Plan {
            request: request(ch as u8, kind == "H2L", pre_samples, post_samples),
            unit, skip: pre_samples - (pre + 1), count: pre + 1 + post, trigger: Some(pre), warning: None,
        });
    }

    let available = max_samples - SKIP_UNTRIGGERED;
    let mut count = match get(msg, "samplecount") {
        None => available, // no samplecount (one shot / looping): fill the board's memory
        Some(v) => js_int(v).filter(|&n| n > 0).ok_or("bad samplecount")? as u64,
    };
    let mut warning = None;
    if count > available {
        warning = Some(format!("The board captured only {available} of {count} samples: {memory}"));
        count = available;
    }
    Ok(Plan {
        // the external trigger input, inverted: it is low when nothing drives it, so the capture starts at once
        request: request(dev.channel_count as u8, true, SKIP_UNTRIGGERED, count.max(2)),
        unit, skip: SKIP_UNTRIGGERED, count, trigger: None, warning,
    })
}

/* ---------- the board's answer to a capture request ---------- */

#[derive(Debug, PartialEq)]
pub enum ReadEvent {
    Started,
    Length(u32),
    /// whole samples (the board's format) and their offset in samples
    Samples(Vec<u8>, u64),
    End(u64),
    Failed(String),
}

#[derive(PartialEq, Debug)]
enum RState {
    Reply,
    Length,
    Samples,
    StampCount,
    Stamps,
    Done,
    Failed,
}

/// Reads "CAPTURE_STARTED\n" (or "CAPTURE_ERROR\n"), when the capture is done: sample count (uint32 LE), the
/// samples (`unit` bytes each, bit k = the k-th requested channel), timestamp count (1 byte), the timestamps
/// (uint32 each, only when there are more than 1). Of the samples, `count` from sample `skip` on are reported.
pub struct CaptureReader {
    unit: usize,
    skip: u64,
    count: u64,
    state: RState,
    pending: Vec<u8>,
    left: u64,
    pos: u64,
    pub sent: u64,
}

impl CaptureReader {
    pub fn new(unit: usize, skip: u64, count: u64) -> Self {
        Self { unit, skip, count, state: RState::Reply, pending: Vec::new(), left: 0, pos: 0, sent: 0 }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<ReadEvent> {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(data);
        let mut ev = Vec::new();
        let mut at = 0;
        while at < buf.len() && self.state != RState::Done && self.state != RState::Failed {
            let rest = &buf[at..];
            match self.state {
                RState::Reply => {
                    let Some(nl) = rest.iter().position(|&b| b == b'\n') else { break };
                    let line = latin1(&rest[..nl]);
                    let line = line.trim();
                    at += nl + 1;
                    if line.is_empty() {
                        continue;
                    }
                    if line == "CAPTURE_STARTED" {
                        self.state = RState::Length;
                        ev.push(ReadEvent::Started);
                        continue;
                    }
                    self.state = RState::Failed;
                    ev.push(ReadEvent::Failed(if line == "CAPTURE_ERROR" {
                        "the board refused the capture settings".into()
                    } else {
                        format!("unexpected answer from the board: \"{line}\"")
                    }));
                    return ev;
                }
                RState::Length => {
                    if rest.len() < 4 {
                        break;
                    }
                    let samples = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
                    self.left = u64::from(samples) * self.unit as u64;
                    self.state = if self.left > 0 { RState::Samples } else { RState::StampCount };
                    ev.push(ReadEvent::Length(samples));
                    at += 4;
                }
                RState::Samples => {
                    let take = (rest.len() as u64).min(self.left);
                    let whole = take - take % self.unit as u64;
                    if whole == 0 && take < self.left {
                        break;
                    }
                    let n = whole / self.unit as u64;
                    // the part of these n samples (from self.pos on) that is within [skip, skip + count)
                    let (from, to) = (self.skip.max(self.pos), (self.skip + self.count).min(self.pos + n));
                    if to > from {
                        let (a, b) = (((from - self.pos) as usize) * self.unit, ((to - self.pos) as usize) * self.unit);
                        ev.push(ReadEvent::Samples(rest[a..b].to_vec(), self.sent));
                        self.sent += to - from;
                    }
                    self.pos += n;
                    self.left -= whole;
                    if self.left == 0 {
                        self.state = RState::StampCount;
                    }
                    at += whole as usize;
                }
                RState::StampCount => {
                    let stamps = u64::from(rest[0]);
                    self.left = if stamps > 1 { stamps * 4 } else { 0 };
                    at += 1;
                    if self.left > 0 {
                        self.state = RState::Stamps;
                    } else {
                        self.state = RState::Done;
                        ev.push(ReadEvent::End(self.sent));
                    }
                }
                RState::Stamps => {
                    // not used: WebScope does no burst captures
                    let take = (rest.len() as u64).min(self.left);
                    self.left -= take;
                    at += take as usize;
                    if self.left == 0 {
                        self.state = RState::Done;
                        ev.push(ReadEvent::End(self.sent));
                    }
                }
                RState::Done | RState::Failed => break,
            }
        }
        if self.state != RState::Done && self.state != RState::Failed {
            self.pending = buf[at..].to_vec();
        }
        ev
    }
}

/* ============================== connection ============================== */

/// Send the ID request and read the 5 lines of the answer (anything before them is old data and ignored).
fn identify(link: &mut Link) -> Result<Dev, String> {
    link.send(&frame(&[0]))?;
    let r = link.read_until(REPLY_TIMEOUT, |got| {
        let text = latin1(got);
        let end = text.rfind('\n')?; // complete lines only
        let lines: Vec<String> = text[..end]
            .split('\n')
            .map(|l| l.trim().to_string())
            .skip_while(|l| !l.starts_with("LOGIC_ANALYZER_"))
            .take(5)
            .collect();
        (lines.len() == 5).then(|| parse_identity(&lines))
    })?;
    r.unwrap_or(Err("no answer to the ID request: is it a LogicAnalyzer board?".into()))
}

/// Send a command and read the one line the board answers with.
fn command(link: &mut Link, payload: &[u8]) -> Result<String, String> {
    link.send(&frame(payload))?;
    link.read_until(REPLY_TIMEOUT, |got| got.iter().position(|&b| b == b'\n').map(|nl| latin1(&got[..nl]).trim().to_string()))?
        .ok_or("the board did not answer".into())
}

/// A WiFi build of the firmware: "WIFI" (Pico W), or another name ending in WIFI, e.g. "P2WIFI".
fn has_wifi(dev: &Dev) -> bool {
    dev.board.ends_with("WIFI")
}

/* ============================== device kind ============================== */

struct Sess {
    stopped: AtomicBool,
    finished: AtomicBool,
    sent: AtomicU64,
    events: EventsRef,
    samplerate: Value,
    trigger: Option<u64>,
    warning: Option<String>,
}

struct Inner {
    conn: String,
    dev: Mutex<Dev>,
    /// what was last saved from here (the board cannot tell its WiFi settings back)
    wifi: Mutex<Option<Value>>,
    /// one connection at a time, also while a cancelled capture is being torn down
    exclusive: Mutex<()>,
    session: Mutex<Option<Arc<Sess>>>,
}

#[derive(Clone)]
pub struct LogicAnalyzerKind(Arc<Inner>);

impl Inner {
    fn busy(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    /// Exactly one of done / error per start; after that the session is over.
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

    fn done(&self, s: &Arc<Sess>, samples: u64, stopped: bool) {
        self.finish(s, || {
            let mut info = Map::new();
            info.insert("deviceId".into(), self.conn.clone().into());
            info.insert("samples".into(), samples.into());
            info.insert("samplerate".into(), s.samplerate.clone());
            info.insert("stopped".into(), stopped.into());
            info.insert("ok".into(), true.into());
            if !stopped {
                if let Some(t) = s.trigger {
                    info.insert("trigger".into(), t.into());
                }
                if let Some(w) = &s.warning {
                    info.insert("warning".into(), w.clone().into());
                }
            }
            s.events.done(Value::Object(info));
        });
    }

    fn stop_session(&self, s: &Arc<Sess>) {
        if s.finished.load(Ordering::SeqCst) || s.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // the capture thread sees the flag and sends the cancel byte
        self.done(s, s.sent.load(Ordering::SeqCst), true);
    }

    /// Connect and identify the board again (scan).
    fn probe(&self) -> Result<(), String> {
        let _x = self.exclusive.lock().unwrap();
        let mut link = Link::open(&self.conn, REPLY_TIMEOUT)?;
        *self.dev.lock().unwrap() = identify(&mut link)?;
        Ok(())
    }

    /// One capture: connect, identify, request, read. The number of samples sent.
    fn run(&self, s: &Arc<Sess>, plan: &Plan, channels: &[u32]) -> Result<u64, String> {
        if s.stopped.load(Ordering::SeqCst) {
            return Ok(0);
        }
        let mut link = Link::open(&self.conn, REPLY_TIMEOUT)?;
        let mut cancel_sent = false;
        let result = self.read_capture(&mut link, s, plan, channels, &mut cancel_sent);
        // a cancelled board needs its time: the next connection must not reach it while it still captures
        if cancel_sent {
            thread::sleep(CANCEL_WAIT);
        }
        result
    }

    fn read_capture(&self, link: &mut Link, s: &Arc<Sess>, plan: &Plan, channels: &[u32], cancel_sent: &mut bool) -> Result<u64, String> {
        *self.dev.lock().unwrap() = identify(link)?; // also checks that it still is the same kind of board
        if s.stopped.load(Ordering::SeqCst) {
            return Ok(0);
        }
        // the board sends the requested channels as bits 0, 1, ..: bit k = channels[k]
        let repack = packed_channel_packer(plan.unit, channels);
        let mut reader = CaptureReader::new(plan.unit, plan.skip, plan.count);
        // (deadline, why, send the cancel byte first)
        let mut timer: Option<(Instant, String, bool)> = Some((Instant::now() + REPLY_TIMEOUT, "the board did not answer the capture request".into(), false));
        link.send(&frame(&capture_request(&plan.request)))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            // any byte cancels a running capture (the board looks for it every 2 s and then sends nothing)
            if s.stopped.load(Ordering::SeqCst) {
                let _ = link.send(&[0xff]);
                *cancel_sent = true;
                return Ok(reader.sent);
            }
            if let Some((deadline, why, cancel)) = &timer {
                if Instant::now() >= *deadline {
                    if *cancel {
                        let _ = link.send(&[0xff]);
                        *cancel_sent = true;
                    }
                    return Err(why.clone());
                }
            }
            let n = link.recv(&mut buf)?;
            if n == 0 {
                continue;
            }
            for e in reader.push(&buf[..n]) {
                match e {
                    ReadEvent::Started => {
                        timer = None;
                        s.events.status(json!({ "state": "armed" }));
                        if plan.trigger.is_none() {
                            let r = &plan.request;
                            let ms = f64::from(r.pre_samples + r.post_samples) / f64::from(r.frequency) * 1000.0 + START_TIMEOUT_MS;
                            timer = Some((
                                Instant::now() + Duration::from_secs_f64(ms / 1000.0),
                                "the capture did not start. Without a trigger it starts when the board's external trigger input (GPIO1 on a Pico) is low: is something driving it high?".into(),
                                true,
                            ));
                        }
                    }
                    ReadEvent::Length(_) => {
                        timer = None;
                        s.events.status(json!({ "state": "triggered", "sample": plan.trigger.unwrap_or(0) }));
                    }
                    ReadEvent::Samples(bytes, offset) => {
                        if s.stopped.load(Ordering::SeqCst) {
                            continue;
                        }
                        s.events.data(&repack.run(&bytes), offset);
                        s.sent.store(offset + (bytes.len() / plan.unit) as u64, Ordering::SeqCst);
                    }
                    ReadEvent::End(sent) => return Ok(sent),
                    ReadEvent::Failed(m) => return Err(m),
                }
            }
        }
    }
}

impl LogicAnalyzerKind {
    pub fn new(conn: &str) -> Self {
        Self(Arc::new(Inner {
            conn: conn.into(),
            dev: Mutex::new(Dev::default()),
            wifi: Mutex::new(None),
            exclusive: Mutex::new(()),
            session: Mutex::new(None),
        }))
    }

    /// The WiFi settings form: open for a WiFi board on USB, grayed out (with the reason) for every other board.
    fn wifi_settings(&self) -> Value {
        let dev = self.0.dev.lock().unwrap().clone();
        let disabled = if !has_wifi(&dev) {
            Some(format!("This board ({}) has no WiFi. WiFi needs a Pico W or Pico 2 W with a WiFi build of the LogicAnalyzer firmware.", dev.board))
        } else if is_network(&self.0.conn) {
            Some("Connect the board with USB to change its WiFi settings.".to_string())
        } else {
            None
        };
        const IPV4: &str = r"((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)";
        const ASCII: &str = r"[\x20-\x7E]*";
        let mut values = json!({ "ssid": "", "password": "", "ip": "", "port": 4045 });
        if let Some(w) = self.0.wifi.lock().unwrap().clone() {
            values = crate::device::merge(values, w);
        }
        let mut s = json!({
            "title": "LogicAnalyzer WiFi settings",
            "note": "Saved in the board's flash. The board then joins the network (WPA2) with this IP address, and \
                     WebScope finds it when its address is in LOGICANALYZER_HOSTS / logicAnalyzerHosts. \
                     The board cannot tell its current settings, so the fields show what was last saved from here.",
            "fields": [
                { "key": "ssid", "label": "Network name", "type": "text", "minLength": 1, "maxLength": 32, "pattern": ASCII, "patternHint": "only plain ASCII characters" },
                { "key": "password", "label": "Password", "type": "password", "minLength": 8, "maxLength": 63, "pattern": ASCII, "patternHint": "only plain ASCII characters", "help": "WPA2: 8 to 63 characters" },
                { "key": "ip", "label": "IP address", "type": "text", "pattern": IPV4, "patternHint": "an IPv4 address, e.g. 192.168.1.20", "help": "a free address in the network: the board does not use DHCP" },
                { "key": "port", "label": "Port", "type": "number", "min": 1, "max": 65535, "integer": true },
            ],
            "values": values,
        });
        if let Some(d) = disabled {
            s["disabled"] = d.into();
        }
        s
    }

    /// Device info for the browser.
    pub fn describe(&self) -> Value {
        let dev = self.0.dev.lock().unwrap().clone();
        let conn = &self.0.conn;
        let rates = samplerates(&dev);
        let b = dev.buffer_size;
        json!({
            "id": format!("logicanalyzer:{conn}"),
            "name": format!("LogicAnalyzer {} {} ({conn})", dev.board, dev.version),
            "channels": (0..dev.channel_count).map(|i| json!({ "index": i, "name": format!("CH{}", i + 1), "type": "logic" })).collect::<Vec<_>>(),
            "samplerates": rates,
            "defaultSamplerate": if rates.contains(&1_000_000) { 1_000_000 } else { *rates.last().unwrap_or(&0) },
            "driver": "logicanalyzer",
            "note": format!("{} KB memory: {b} samples with CH1-8, {} up to CH16, {} above. Triggers: L2H / H2L only",
                js_num((b as f64 / 1024.0).round()), js_num(b as f64 / 2.0), js_num(b as f64 / 4.0)),
            // what the frontend can offer, see frontend/js/capture/captureLimits.js (the same rules as plan_capture())
            "limits": {
                "stream": false,
                "memory": [
                    { "below": 8, "samples": b },
                    { "below": 16, "samples": b / 2 },
                    { "below": dev.channel_count, "samples": b / 4 },
                ],
                "preTriggerShare": 0.1,
                "hardwareTrigger": { "types": ["L2H", "H2L"], "conditions": false },
            },
            "details": [
                { "label": "Board", "value": dev.board },
                { "label": "Firmware", "value": dev.version },
                { "label": "Connection", "value": if is_network(conn) { format!("WiFi, {conn}") } else { format!("USB, {conn}") } },
                { "label": "Memory", "value": format!("{} samples", thousands(b)) },
            ],
            "settings": self.wifi_settings(),
        })
    }
}

impl DeviceKind for LogicAnalyzerKind {
    fn hardware_trigger(&self) -> bool {
        true
    }

    fn start(&self, msg: &Value, events: EventsRef) -> Option<Session> {
        let inner = self.0.clone();
        if inner.busy() {
            events.error("LogicAnalyzer - the board is already capturing", None);
            return None;
        }
        let dev = inner.dev.lock().unwrap().clone();
        let plan = match plan_capture(msg, &dev) {
            Ok(p) => p,
            Err(e) => {
                events.error(&format!("LogicAnalyzer - {e}"), None);
                return None;
            }
        };
        let channels: Vec<u32> = plan.request.channels.iter().map(|&c| u32::from(c)).collect();
        let s = Arc::new(Sess {
            stopped: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            sent: AtomicU64::new(0),
            events,
            samplerate: msg["samplerate"].clone(),
            trigger: plan.trigger,
            warning: plan.warning.clone(),
        });
        *inner.session.lock().unwrap() = Some(s.clone());

        let (t_inner, t_s) = (inner.clone(), s.clone());
        thread::spawn(move || {
            let result = {
                let _x = t_inner.exclusive.lock().unwrap();
                t_inner.run(&t_s, &plan, &channels)
            };
            match result {
                Ok(samples) => t_inner.done(&t_s, samples, false),
                Err(e) => {
                    let dev = t_inner.dev.lock().unwrap().clone();
                    let details = format!("{} ({} {})\n\n{e}", t_inner.conn, dev.board, dev.version);
                    t_inner.finish(&t_s, || t_s.events.error(&format!("LogicAnalyzer - {e}"), Some(&details)));
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

    /// Save WiFi settings on the board (see device_settings.rs).
    fn apply_settings(&self, values: &Value) -> Result<(String, Value), String> {
        let v = validate_settings(&self.wifi_settings(), values)?; // also refuses a board without WiFi
        let (ssid, password, ip) = (v["ssid"].as_str().unwrap_or(""), v["password"].as_str().unwrap_or(""), v["ip"].as_str().unwrap_or(""));
        let port = v["port"].as_u64().unwrap_or(0) as u16;
        let request = wifi_settings_request(ssid, password, ip, port)?;
        // the firmware receives a frame into 128 bytes without checking (messageBuffer[128]), and escaping makes
        // every 0x55 / 0xAA / 0xF0 byte two: e.g. a "U" in the name or password
        if frame(&request).len() > 128 {
            return Err("the network name and password have too many \"U\" characters for the board's receive buffer (at most 7 together)".into());
        }
        if self.0.busy() {
            return Err("the board is capturing: stop the capture first".into());
        }
        {
            let _x = self.0.exclusive.lock().unwrap();
            let mut link = Link::open(&self.0.conn, REPLY_TIMEOUT)?;
            let dev = identify(&mut link)?;
            *self.0.dev.lock().unwrap() = dev.clone();
            if !has_wifi(&dev) {
                return Err(format!("the board's firmware has no WiFi (it is a {} build)", dev.board));
            }
            let answer = command(&mut link, &request)?;
            if answer != "SETTINGS_SAVED" {
                return Err(if answer == "ERR_UNSUPPORTED" { "the board's firmware has no WiFi".into() } else { format!("the board answered \"{answer}\"") });
            }
        }
        *self.0.wifi.lock().unwrap() = Some(json!({ "ssid": ssid, "ip": ip, "port": port }));
        Ok((format!("LogicAnalyzer: WiFi settings saved, the board joins \"{ssid}\" as {ip}:{port}"), self.describe()))
    }
}

/* ============================== scan ============================== */

/// connection -> kind: kept between scans, a capturing board is not probed
static KINDS: Mutex<Vec<LogicAnalyzerKind>> = Mutex::new(Vec::new());

fn hosts_from_env() -> Vec<String> {
    std::env::var("LOGICANALYZER_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|h| h.trim().to_string())
        .filter(|h| is_network(h))
        .collect()
}

pub fn scan() -> Vec<(Value, Arc<dyn DeviceKind>)> {
    let mut devices: Vec<(Value, Arc<dyn DeviceKind>)> = Vec::new();
    let mut conns = usb_ports(USB_ID.0, USB_ID.1);
    conns.extend(hosts_from_env());
    for conn in conns {
        let known = KINDS.lock().unwrap().iter().find(|k| k.0.conn == conn).cloned();
        let result = match &known {
            None => {
                let kind = LogicAnalyzerKind::new(&conn);
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
            Err(e) => eprintln!("LogicAnalyzer: no board on {conn}: {e}"),
        }
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pico() -> Dev {
        Dev { board: "PICO".into(), version: "V6_0".into(), max_frequency: 100_000_000, blast_frequency: 200_000_000, buffer_size: 131072, channel_count: 24 }
    }
    fn id_lines() -> Vec<String> {
        ["LOGIC_ANALYZER_PICO_V6_0", "FREQ:100000000", "BLASTFREQ:200000000", "BUFFER:131072", "CHANNELS:24"].map(String::from).to_vec()
    }
    fn unframe(b: &[u8]) -> Vec<u8> {
        assert_eq!(&b[..2], &[0x55, 0xAA]);
        assert_eq!(&b[b.len() - 2..], &[0xAA, 0x55]);
        let mut out = Vec::new();
        let mut i = 2;
        while i < b.len() - 2 {
            if b[i] == 0xF0 {
                i += 1;
                out.push(b[i] ^ 0xF0);
            } else {
                out.push(b[i]);
            }
            i += 1;
        }
        out
    }

    #[test]
    fn frames_escape() {
        assert_eq!(frame(&[0]), vec![0x55, 0xAA, 0x00, 0xAA, 0x55]);
        let payload = [1, 0x55, 0xAA, 0xF0, 7];
        let f = frame(&payload);
        assert_eq!(f, vec![0x55, 0xAA, 1, 0xF0, 0xA5, 0xF0, 0x5A, 0xF0, 0x00, 7, 0xAA, 0x55]);
        assert_eq!(unframe(&f), payload.to_vec());
    }

    #[test]
    fn capture_request_layout() {
        let r = Request { trigger_type: 0, trigger: 3, inverted: true, channels: vec![0, 2, 9], frequency: 0x01020304, pre_samples: 0x55AA, post_samples: 1000, capture_mode: 1 };
        let p = capture_request(&r);
        assert_eq!(p.len(), 49);
        assert_eq!((p[0], p[1], p[2], p[3], p[31]), (1, 0, 3, 1, 3));
        assert_eq!(&p[7..10], &[0, 2, 9]);
        assert_eq!(u32::from_le_bytes(p[33..37].try_into().unwrap()), 0x01020304);
        assert_eq!(u32::from_le_bytes(p[37..41].try_into().unwrap()), 0x55AA);
        assert_eq!(u32::from_le_bytes(p[41..45].try_into().unwrap()), 1000);
        assert_eq!((p[45], p[46], p[47]), (0, 0, 1));
    }

    #[test]
    fn wifi_request_layout() {
        let p = wifi_settings_request("MyNet", "secret123", "192.168.1.20", 4045).unwrap();
        assert_eq!(p.len(), 117);
        assert_eq!(p[0], 2);
        assert_eq!(&p[1..6], b"MyNet");
        assert_eq!(p[1 + 32], 0);
        assert_eq!(&p[34..43], b"secret123");
        assert_eq!(&p[98..110], b"192.168.1.20");
        assert_eq!(u16::from_le_bytes([p[115], p[116]]), 4045);
        assert!(wifi_settings_request(&"x".repeat(33), "secret123", "1.2.3.4", 1).unwrap_err().contains("does not fit"));
        assert!(wifi_settings_request("Café", "secret123", "1.2.3.4", 1).unwrap_err().contains("does not fit"));
    }

    #[test]
    fn identity() {
        assert_eq!(parse_identity(&id_lines()).unwrap(), pico());
        let mut l = id_lines();
        l[0] = "LOGIC_ANALYZER_PICO_2_V6_5".into();
        assert_eq!(parse_identity(&l).unwrap().board, "PICO_2");
        l[0] = "LOGIC_ANALYZER_PICO_V5_1".into();
        assert!(parse_identity(&l).unwrap_err().contains("too old"));
        assert!(parse_identity(&["hello".into()]).unwrap_err().contains("not a LogicAnalyzer"));
        assert!(parse_identity(&[id_lines()[0].clone(), "FREQ:x".into()]).unwrap_err().contains("FREQ"));
    }

    #[test]
    fn rates() {
        assert_eq!(samplerates(&pico()), vec![5000, 10000, 20000, 50000, 100000, 200000, 500000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000]);
        assert_eq!(*samplerates(&Dev { max_frequency: 200_000_000, ..pico() }).last().unwrap(), 200_000_000);
    }

    #[test]
    fn plans() {
        let t = plan_capture(&json!({ "channels": [0, 1, 2], "samplerate": 1e6, "triggerOn": { "channel": 5, "type": "H2L" }, "preTrigger": 10, "postTrigger": 100 }), &pico()).unwrap();
        assert_eq!(t.unit, 1);
        assert_eq!((t.request.frequency, t.request.capture_mode, t.request.trigger, t.request.inverted, t.request.pre_samples, t.request.post_samples), (1_000_000, 0, 5, true, 11, 100));
        assert_eq!((t.skip, t.count, t.trigger), (0, 111, Some(10)));
        let z = plan_capture(&json!({ "channels": [3, 17], "samplerate": 1e6, "triggerOn": { "channel": 3, "type": "L2H" }, "preTrigger": 0, "postTrigger": 0 }), &pico()).unwrap();
        assert_eq!(z.unit, 4);
        assert_eq!((z.request.pre_samples, z.request.post_samples, z.skip, z.count, z.trigger, z.request.inverted), (2, 2, 1, 1, Some(0), false));
        let free = plan_capture(&json!({ "channels": [0, 8], "samplerate": 1e6, "samplecount": 5000 }), &pico()).unwrap();
        assert_eq!((free.unit, free.request.trigger, free.request.inverted, free.skip, free.count), (2, 24, true, 2, 5000));
        assert_eq!(plan_capture(&json!({ "channels": [0], "samplerate": 1e6 }), &pico()).unwrap().count, 131070);
        let big = plan_capture(&json!({ "channels": [0], "samplerate": 1e6, "samplecount": 1e6 }), &pico()).unwrap();
        assert_eq!(big.count, 131070);
        assert!(big.warning.unwrap().contains("only 131070 of 1000000"));
        let m = |o: Value| crate::device::merge(json!({ "channels": [0], "samplerate": 1e6, "triggerOn": { "channel": 0, "type": "L2H" }, "preTrigger": 10, "postTrigger": 10 }), o);
        for (o, want) in [
            (json!({ "triggerOn": { "channel": 0, "type": "PulseH", "pulseLength": 3 } }), "L2H"),
            (json!({ "triggerOn": { "channel": 0, "type": "L2H", "conditions": { "1": "hi" } } }), "other channels"),
            (json!({ "preTrigger": 20000 }), "before the trigger"),
            (json!({ "postTrigger": 131072 }), "too long"),
            (json!({ "samplerate": 1000 }), "samplerate"),
            (json!({ "samplerate": 200e6 }), "samplerate"),
        ] {
            let err = plan_capture(&m(o.clone()), &pico()).unwrap_err();
            assert!(err.contains(want), "{o}: {err}");
        }
    }

    #[test]
    fn reader_keeps_skip_count_at_any_chunking() {
        let mut seed = 12345u64;
        let mut rnd = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            1 + ((seed >> 33) as usize % n)
        };
        for iter in 0..200u64 {
            let unit = [1usize, 2, 4][(iter % 3) as usize];
            let (total, skip) = (50 + iter, iter % 5);
            let count = total - skip - iter % 7;
            let mut bytes = b"\r\nCAPTURE_STARTED\r\n".to_vec();
            bytes.extend_from_slice(&(total as u32).to_le_bytes());
            for i in 0..total {
                for b in 0..unit {
                    bytes.push((i >> (8 * b)) as u8);
                }
            }
            bytes.extend_from_slice(&[2, 1, 2, 3, 4, 5, 6, 7, 8]); // 2 timestamps
            let mut r = CaptureReader::new(unit, skip, count);
            let (mut got, mut started, mut length, mut ended) = (Vec::new(), 0, None, None);
            let mut pos = 0;
            while pos < bytes.len() {
                let end = (pos + rnd(40)).min(bytes.len());
                for e in r.push(&bytes[pos..end]) {
                    match e {
                        ReadEvent::Started => started += 1,
                        ReadEvent::Length(n) => length = Some(n),
                        ReadEvent::Samples(b, off) => {
                            assert_eq!(off as usize * unit, got.len());
                            got.extend(b);
                        }
                        ReadEvent::End(n) => ended = Some(n),
                        ReadEvent::Failed(m) => panic!("{m}"),
                    }
                }
                pos = end;
            }
            let mut want = Vec::new();
            for i in skip..skip + count {
                for b in 0..unit {
                    want.push((i >> (8 * b)) as u8);
                }
            }
            assert_eq!(got, want, "iter {iter}");
            assert_eq!((started, length, ended, &r.state), (1, Some(total as u32), Some(count), &RState::Done));
        }
        let mut r = CaptureReader::new(1, 0, 1);
        assert!(matches!(&r.push(b"CAPTURE_ERROR\n")[..], [ReadEvent::Failed(m)] if m.contains("refused")));
    }

    #[test]
    fn wifi_settings_refused() {
        let k = LogicAnalyzerKind::new("COM9");
        *k.0.dev.lock().unwrap() = pico();
        let v = json!({ "ssid": "MyNet", "password": "secret123", "ip": "192.168.1.20", "port": 4045 });
        assert!(k.apply_settings(&v).unwrap_err().contains("has no WiFi"));
        let w = LogicAnalyzerKind::new("192.168.1.20:4045");
        *w.0.dev.lock().unwrap() = Dev { board: "WIFI".into(), ..pico() };
        assert!(w.apply_settings(&v).unwrap_err().contains("Connect the board with USB"));
        let k = LogicAnalyzerKind::new("COM9");
        *k.0.dev.lock().unwrap() = Dev { board: "WIFI".into(), ..pico() };
        let bad = |o: Value| k.apply_settings(&crate::device::merge(v.clone(), o)).unwrap_err();
        assert!(bad(json!({ "ip": "192.168.1.300" })).contains("IP address: an IPv4 address"));
        assert!(bad(json!({ "password": "short" })).contains("Password: at least 8"));
        assert!(bad(json!({ "ssid": "" })).contains("Network name: is needed"));
        assert!(bad(json!({ "password": "UUUUUUUU" })).contains("too many \"U\""));
    }
}
