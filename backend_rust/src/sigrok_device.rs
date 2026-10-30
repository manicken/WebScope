//! Port of SigrokDevice.js - drives sigrok-cli as a child process (no libsigrok linking).
//!
//!   scan()                 -> one `Found` per device listed by `sigrok-cli --scan`
//!                             (sigrok-pico boards have their own driver: sigrok_pico.rs)
//!   SigrokKind::start/stop -> same shape as DemoDevice; errors and short captures come with `details`
//!                             (the command line, exit code and sigrok-cli's whole stderr)
//!
//! Only logic channels are handled (raw packed bytes via `-O binary`).
//! sigrok-cli is located automatically: $SIGROK_CLI, PATH, next to the executable, usual install folders.

use crate::channels::{channel_packer, packed_channel_packer};
use crate::device::{as_pos_int, get, js_int, DeviceKind, EventsRef, Session};
use serde_json::{json, Map, Value};
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

// ---- locating sigrok-cli ----------------------------------------------------

static SIGROK_CLI: OnceLock<PathBuf> = OnceLock::new();

fn candidates() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "sigrok-cli.exe" } else { "sigrok-cli" };
    let mut list = Vec::new();

    if let Some(p) = env::var_os("SIGROK_CLI") {
        list.push(PathBuf::from(p));
    }
    list.push(PathBuf::from(exe)); // via PATH

    if let Some(dir) = env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        list.push(dir.join("sigrok-cli").join(exe));
        list.push(dir.join(exe));
    }

    if cfg!(windows) {
        let mut roots = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(v) = env::var_os(var) {
                roots.push(PathBuf::from(v));
            }
        }
        if let Some(v) = env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(v).join("Programs"));
        }
        for r in roots {
            list.push(r.join("sigrok").join("sigrok-cli").join(exe));
            list.push(r.join("sigrok").join("PulseView").join(exe));
            list.push(r.join("sigrok-cli").join(exe));
        }
        list.push(PathBuf::from(r"C:\msys64\mingw64\bin").join(exe));
        list.push(PathBuf::from(r"C:\msys64\ucrt64\bin").join(exe));
    } else {
        list.extend(
            ["/usr/local/bin/sigrok-cli", "/opt/homebrew/bin/sigrok-cli", "/usr/bin/sigrok-cli"].map(PathBuf::from),
        );
    }
    list
}

/// Runs a command to completion with a timeout and returns stdout.
fn run_with_timeout(cli: &Path, args: &[String], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let _stdin = child.stdin.take(); // keep open until we are done
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();

    // drain both pipes on their own threads so a full pipe can never stall the child
    let t_out = thread::spawn(move || {
        let mut v = Vec::new();
        let _ = out.read_to_end(&mut v);
        v
    });
    let t_err = thread::spawn(move || {
        let mut v = Vec::new();
        let _ = err.read_to_end(&mut v);
        v
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {} s", timeout.as_secs()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(e.to_string()),
        }
    };

    let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(stdout)
    } else {
        Err(format!("{status}: {}", stderr.trim()))
    }
}

/// Tried in order, the first one that answers `--version` wins.
fn resolve_sigrok_cli() -> Result<&'static PathBuf, String> {
    if let Some(p) = SIGROK_CLI.get() {
        return Ok(p);
    }
    let mut tried = Vec::new();
    for c in candidates() {
        if c.is_absolute() && !c.exists() {
            tried.push(c.display().to_string());
            continue;
        }
        if run_with_timeout(&c, &["--version".to_string()], Duration::from_secs(10)).is_ok() {
            println!("Using sigrok-cli: {}", c.display());
            let _ = SIGROK_CLI.set(c);
            return Ok(SIGROK_CLI.get().unwrap());
        }
        tried.push(c.display().to_string());
    }
    Err(format!(
        "sigrok-cli not found. Tried:\n  {}\nSet SIGROK_CLI to the full path of sigrok-cli(.exe), or add its folder to PATH.",
        tried.join("\n  ")
    ))
}

fn run(args: &[&str]) -> Result<String, String> {
    let cli = resolve_sigrok_cli()?;
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_with_timeout(cli, &args, Duration::from_secs(30))
        .map_err(|e| format!("{} {}: {e}", cli.display(), args.join(" ")))
}

// sigrok-cli --scan does not report channel types. Treat D0, D1, ... / 0, 1, ... as logic.
fn is_logic_channel(name: &str) -> bool {
    let s = name.strip_prefix('D').unwrap_or(name);
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

// How sigrok-cli's binary output holds the enabled channels (-C) depends on the driver (measured):
//   raw     the device's own sample: channel n = bit n, ceil(all logic channels / 8) bytes, the bits of
//           disabled channels are not cleared (fx2lafw) - libsigrok's own convention, so the default
//   packed  only the enabled channels: the k-th enabled channel = bit k, ceil(enabled / 8) bytes (demo)
const PACKED_DRIVERS: [&str; 1] = ["demo"];

// The sample count for "until stopped" on a device that cannot sample continuously (no --continuous):
// 2^31 - 1, so it fits a 32-bit signed number in the driver / firmware; 35 minutes at 1 MHz
const UNTIL_STOPPED_SAMPLES: u64 = (1 << 31) - 1;

// ---- capture ----------------------------------------------------------------

struct Running {
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
}

pub struct SigrokKind {
    spec: String,          // what goes after -d, e.g. "demo" or "fx2lafw:conn=1.5"
    channels: Vec<String>, // all channel names reported by the scan
    continuous: bool,      // it can run until stopped (--continuous), else it needs a sample count
    running: Arc<Mutex<Option<Running>>>,
}

impl SigrokKind {
    pub fn new(spec: String, channels: Vec<String>, continuous: bool) -> Self {
        Self { spec, channels, continuous, running: Arc::new(Mutex::new(None)) }
    }
}

fn trim_tail(s: &mut String, max: usize) {
    if s.len() > max {
        let mut cut = s.len() - max;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

/// sigrok-cli's error message without its debug lines ("sr: ..."; some drivers print "Drain reads" on every run).
fn error_text(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let plain: Vec<&str> = lines.iter().copied().filter(|l| !l.starts_with("sr: ")).collect();
    if !plain.is_empty() {
        plain.join("\n")
    } else {
        lines.into_iter().filter(|l| !l.contains("Drain reads")).collect::<Vec<_>>().join("\n")
    }
}

impl DeviceKind for SigrokKind {
    fn start(&self, msg: &Value, events: EventsRef) -> Option<Session> {
        println!("sigrok device start");
        let Some(cli) = SIGROK_CLI.get() else {
            events.error("sigrok-cli has not been located (scanSigrok() must run first)", None);
            return None;
        };
        let mut running = self.running.lock().unwrap();
        if running.is_some() {
            events.error("SigrokDevice - device is already capturing", None);
            return None;
        }
        let fail = |m: &str| {
            events.error(&format!("SigrokDevice - {m}"), None);
            None
        };

        // msg comes from the browser: validate everything before it reaches the command line
        let mut args: Vec<String> = vec!["-d".into(), self.spec.clone()];
        if let Some(v) = msg.get("samplerate") {
            let Some(n) = as_pos_int(v) else { return fail("bad samplerate") };
            args.push("--config".into());
            args.push(format!("samplerate={n}"));
        }
        // msg.channels: indexes into the logic channels (= the device info's channels), all when missing
        let logic: Vec<&String> = self.channels.iter().filter(|c| is_logic_channel(c)).collect();
        let indexes: Vec<u32> = match get(msg, "channels") {
            None => (0..logic.len() as u32).collect(),
            Some(v) => {
                let list = v.as_array().map(|a| a.iter().map(|x| js_int(x).filter(|&i| i >= 0 && (i as usize) < logic.len())).collect::<Option<Vec<_>>>());
                match list {
                    Some(Some(l)) => l.into_iter().map(|i| i as u32).collect(),
                    _ => return fail("bad channel list"),
                }
            }
        };
        if indexes.is_empty() {
            return fail("bad channel list");
        }
        let driver = self.spec.split(':').next().unwrap_or("");
        args.push("-C".into());
        args.push(indexes.iter().map(|&i| logic[i as usize].as_str()).collect::<Vec<_>>().join(","));

        let samplecount = match get(msg, "samplecount") {
            Some(v) => {
                let Some(n) = as_pos_int(v) else { return fail("bad samplecount") };
                args.push("--samples".into());
                args.push(n.to_string());
                Some(n)
            }
            None if !self.continuous => {
                // runs until stopped all the same: a sample count it will not reach
                args.push("--samples".into());
                args.push(UNTIL_STOPPED_SAMPLES.to_string());
                None
            }
            None => {
                args.push("--continuous".into());
                None
            }
        };
        args.push("-O".into());
        args.push("binary".into());

        // what sigrok-cli sends, and how to turn it into the browser's format (only the enabled channels)
        let packed = PACKED_DRIVERS.contains(&driver);
        let unit = ((if packed { indexes.len() } else { logic.len() }) + 7) / 8;
        let repack = if packed { packed_channel_packer(unit, &indexes) } else { channel_packer(unit, &indexes, None) };
        let command_line = format!("\"{}\" {}", cli.display(), args.join(" "));

        // stdin must stay OPEN ('piped'): sigrok-cli quits immediately on stdin EOF
        let spawned = Command::new(cli).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                events.error(&format!("SigrokDevice - could not run {}: {e}", cli.display()), Some(&format!("{command_line}\n\n{e}")));
                events.done(json!({ "deviceId": self.spec, "samples": 0, "stopped": false, "ok": false }));
                return None;
            }
        };
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();

        let child = Arc::new(Mutex::new(child));
        let stopped = Arc::new(AtomicBool::new(false));
        *running = Some(Running { child: child.clone(), stopped: stopped.clone() });
        drop(running);

        let state = self.running.clone();
        let spec = self.spec.clone();

        thread::spawn(move || {
            let _stdin = stdin; // held for the lifetime of the capture

            // the last 20000 bytes of stderr, for the error message and its details
            let err_buf = Arc::new(Mutex::new(String::new()));
            let err_thread = {
                let err_buf = err_buf.clone();
                thread::spawn(move || {
                    let mut b = [0u8; 1024];
                    loop {
                        match stderr.read(&mut b) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut s = err_buf.lock().unwrap();
                                s.push_str(&String::from_utf8_lossy(&b[..n]));
                                trim_tail(&mut s, 20000);
                            }
                        }
                    }
                })
            };

            let mut buf = vec![0u8; 64 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            let mut total_bytes: u64 = 0;
            loop {
                let n = match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                // chunk boundaries are arbitrary: only forward whole samples
                pending.extend_from_slice(&buf[..n]);
                let usable = pending.len() - pending.len() % unit;
                if usable == 0 {
                    continue;
                }
                let remaining = match samplecount {
                    Some(c) => c.saturating_mul(unit as u64).saturating_sub(total_bytes),
                    None => usable as u64,
                };
                let bytes = (usable as u64).min(remaining) as usize;
                if bytes > 0 {
                    if !events.data(&repack.run(&pending[..bytes]), total_bytes / unit as u64) {
                        // the client is gone: stop capturing
                        stopped.store(true, Ordering::SeqCst);
                        let _ = child.lock().unwrap().kill();
                        break;
                    }
                    total_bytes += bytes as u64;
                }
                pending.drain(..usable);
            }

            let _ = err_thread.join();
            // stdout hit EOF so the process is exiting; poll instead of blocking in wait()
            // so stop() can still take the child lock.
            let status = loop {
                let r = child.lock().unwrap().try_wait();
                match r {
                    Ok(Some(s)) => break Some(s),
                    Ok(None) => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break None,
                }
            };
            *state.lock().unwrap() = None;

            let was_stopped = stopped.load(Ordering::SeqCst);
            let code = status.and_then(|s| s.code());
            let code_text = code.map_or("null".to_string(), |c| c.to_string());
            let stderr = err_buf.lock().unwrap().clone();
            let details = || {
                let err = if stderr.trim().is_empty() { "(nothing on stderr)" } else { stderr.trim() };
                format!("{command_line}\n\nexit code: {code_text}\n\n{err}")
            };
            if code != Some(0) && !was_stopped {
                let text = error_text(&stderr);
                let text = if text.is_empty() { format!("sigrok-cli exited with code {code_text}") } else { text };
                events.error(&format!("SigrokDevice - {text}"), Some(&details()));
            }
            let samples = total_bytes / unit as u64;
            let mut info = Map::new();
            info.insert("deviceId".into(), spec.into());
            info.insert("samples".into(), samples.into());
            info.insert("stopped".into(), was_stopped.into());
            info.insert("ok".into(), (was_stopped || code == Some(0)).into());
            // some devices end early without an error (their memory is full, or they cannot send the data fast enough)
            if let Some(c) = samplecount.filter(|&c| !was_stopped && code == Some(0) && samples < c) {
                info.insert("warning".into(), format!("The device sent only {samples} of {c} samples: use a lower samplerate or a shorter capture").into());
                info.insert("details".into(), details().into());
            }
            events.done(Value::Object(info));
        });
        None
    }

    fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().as_ref() {
            r.stopped.store(true, Ordering::SeqCst);
            let _ = r.child.lock().unwrap().kill(); // SIGKILL on Unix, TerminateProcess on Windows
        }
    }
}

// ---- scanning ---------------------------------------------------------------

pub struct Found {
    pub id: String,
    pub spec: String,
    pub channels: Vec<String>,
    pub continuous: bool,
    pub info: Value,
}

/// "<name> with <n> channel(s): D0 D1 ..." -> (name, channels)
fn parse_description(rest: &str) -> (String, Vec<String>) {
    for (i, _) in rest.match_indices(" with ") {
        let after = &rest[i + 6..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let after = &after[digits..];
        let Some(list) = after.strip_prefix(" channels: ").or_else(|| after.strip_prefix(" channel: ")) else {
            continue;
        };
        return (rest[..i].to_string(), list.split_whitespace().map(String::from).collect());
    }
    (rest.to_string(), Vec::new())
}

/// "20 MHz", "500 kHz (current)", "1 Hz" -> Hz
fn parse_samplerate_line(line: &str) -> Option<u64> {
    let line = match line.find("(current)") {
        Some(i) => &line[..i],
        None => line,
    }
    .trim();
    let hz = line.find("Hz")?;
    let before = &line[..hz];
    let (num, mult): (&str, f64) = match before.chars().last() {
        Some(c) if c.is_ascii_digit() => (before, 1.0),
        Some(c @ ('k' | 'K')) => (&before[..before.len() - c.len_utf8()], 1e3),
        Some('M') => (&before[..before.len() - 1], 1e6),
        Some('G') => (&before[..before.len() - 1], 1e9),
        Some(c) => (&before[..before.len() - c.len_utf8()], 1.0),
        None => ("", 1.0),
    };
    let v: f64 = num.trim().parse().ok()?;
    Some((v * mult).round() as u64)
}

/// Device info for the browser, from `--show` of one device; also whether it can run until stopped.
fn describe(spec: &str, name: &str, channels: &[String]) -> Result<(Value, bool), String> {
    let show = run(&["-d", spec, "--show"])?;
    let lines: Vec<&str> = show.lines().collect();

    let mut samplerates = Vec::new();
    let mut default_samplerate = None; // the rate the device is set to now, marked "(current)" in the list
    if let Some(start) = lines.iter().position(|l| l.trim() == "samplerate - supported samplerates:") {
        for l in &lines[start + 1..] {
            if !l.contains("Hz") {
                break;
            }
            if let Some(hz) = parse_samplerate_line(l) {
                samplerates.push(hz);
                if l.contains("(current)") {
                    default_samplerate = Some(hz);
                }
            }
        }
    }
    // some drivers give a range instead of a list (the demo driver: "1 Hz - 1 GHz in steps of 1 Hz"),
    // without a "(current)" mark: ask for the current rate, which --get prints in Hz, e.g. "200000"
    if default_samplerate.is_none() {
        match run(&["-d", spec, "--get", "samplerate"]) {
            Ok(out) => default_samplerate = out.trim().parse::<u64>().ok().filter(|&r| r > 0),
            Err(e) => eprintln!("Sigrok: could not get the samplerate of {spec}: {e}"),
        }
    }
    let trigger_options: Vec<String> = lines
        .iter()
        .find_map(|l| l.trim().strip_prefix("Supported triggers:"))
        .map(|rest| rest.trim().split(' ').map(String::from).collect())
        .unwrap_or_default();
    // "continuous: on, off" is listed only by drivers that can run until stopped; the others need a
    // sample count, and sigrok-cli refuses --continuous for them: see UNTIL_STOPPED_SAMPLES
    let continuous = lines.iter().any(|l| l.trim_start().starts_with("continuous:"));

    let logic: Vec<Value> = channels
        .iter()
        .filter(|c| is_logic_channel(c))
        .enumerate()
        .map(|(i, n)| json!({ "index": i, "name": n, "type": "logic" }))
        .collect();
    let mut info = json!({
        "id": format!("sigrok:{spec}"),
        "name": name,
        "samplerates": samplerates,
        "triggerOptions": trigger_options,
        "driver": spec.split(':').next().unwrap_or(spec),
        "channels": logic,
    });
    if let Some(r) = default_samplerate {
        info["defaultSamplerate"] = r.into();
    }
    Ok((info, continuous))
}

pub fn scan() -> Result<Vec<Found>, String> {
    let out = run(&["--scan"])?;
    let mut devices = Vec::new();

    // Output looks like:
    //   The following devices were found:
    //   demo - Demo device with 13 channels: D0 D1 D2 ...
    //   fx2lafw:conn=1.5 - Saleae Logic with 8 channels: D0 D1 ...
    for line in out.lines() {
        let Some((spec, rest)) = line.split_once(" - ") else { continue };
        if spec.is_empty() || spec.contains(char::is_whitespace) || rest.is_empty() {
            continue;
        }
        let (name, channels) = parse_description(rest);
        let (info, continuous) = describe(spec, &name, &channels)?;
        devices.push(Found { id: format!("sigrok:{spec}"), spec: spec.to_string(), channels, continuous, info });
    }
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_lines_and_rates() {
        assert_eq!(parse_description("Demo device with 13 channels: D0 D1 A0"), ("Demo device".into(), vec!["D0".into(), "D1".into(), "A0".into()]));
        assert_eq!(parse_samplerate_line("  500 kHz (current)"), Some(500_000));
        assert_eq!(parse_samplerate_line("24 MHz"), Some(24_000_000));
        assert_eq!(error_text("sr: x\nsr: Drain reads\n"), "sr: x");
        assert_eq!(error_text("sr: x\nFailed to open device.\n"), "Failed to open device.");
        assert!(is_logic_channel("D7") && is_logic_channel("12") && !is_logic_channel("A0"));
    }
}
