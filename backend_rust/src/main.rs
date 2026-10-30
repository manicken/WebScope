//! WebScope backend (Rust port of backend/index.js): HTTP + WebSocket on one port, the same protocol,
//! settings.json and command line as the Node backend.
//!
//!   webscope-backend [--port <n>] [--open] [--allow-origin <origin>] [--allow-host <name>] [--no-host-check]
//!                    [--settings <file>] [--allow-admin]
//!   settings.json    next to the executable (or in the current folder), see settings.rs
//!   env PORT             the default port (settings.json and --port win)
//!   env WEBSCOPE_BIND    default 0.0.0.0
//!   env WEBSCOPE_PUBLIC  the frontend folder      default: the WebScope folder's frontend/ (see find_root())
//!   env WEBSCOPE_DATA    the /api/fs folder       default: the WebScope folder's user_data_fs/
//!   env SIGROK_CLI / LOGICANALYZER_HOSTS          win over sigrokCli / logicAnalyzerHosts in settings.json
//!
//! Served: /api/fs/ (the user's files), /python/runtime/ and /python/decoders/ (the Python decoder
//! extension, read only), the frontend, and the WebSocket (devices and captures).

mod channels;
mod demo_device;
mod demo_wave;
mod device;
mod device_settings;
mod http;
mod link;
mod logic_analyzer;
mod settings;
mod sigrok_device;
mod sigrok_pico;
mod trigger;

use demo_device::DemoDevice;
use device::{js_truthy, merge, DeviceKind, Events, EventsRef, Out, Session, Sink};
use http::HttpError;
use serde_json::{json, Map, Value};
use settings::{is_host_allowed, is_origin_allowed, local_hostnames, Settings};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{env, fs, io, process, thread};
use tungstenite::protocol::Role;
use tungstenite::{Error as WsError, Message, WebSocket};

struct Entry {
    id: String,
    info: Value,
    kind: Arc<dyn DeviceKind>,
}

struct Ctx {
    settings: Settings,
    local_names: HashSet<String>,
    public_dir: PathBuf,
    data_dir: PathBuf, // canonical
    /// /python/<name>/ -> folder (canonical; None when it does not exist)
    python: Vec<(&'static str, Option<PathBuf>)>,
    devices: Mutex<Vec<Entry>>,
    demo: Arc<DemoDevice>,
    /// sigrok-cli devices by id: kept between scans, so a running capture can still be stopped
    sigrok_kinds: Mutex<HashMap<String, Arc<dyn DeviceKind>>>,
    clients: Mutex<Vec<(u64, Sink)>>,
    refused_hosts: Mutex<HashSet<String>>,
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

fn find(ctx: &Ctx, id: Option<&str>) -> Option<(Value, Arc<dyn DeviceKind>)> {
    let id = id?;
    ctx.devices.lock().unwrap().iter().find(|e| e.id == id).map(|e| (e.info.clone(), e.kind.clone()))
}

fn demo_entry(ctx: &Ctx) -> Entry {
    Entry { id: "remotedemo".into(), info: ctx.demo.info(), kind: ctx.demo.clone() }
}

/// The demo device at once; the hardware scans in the background (all drivers at the same time), the full
/// device list is sent to `sink` when they are done.
fn refresh_devices(ctx: &Arc<Ctx>, sink: &Sink) {
    *ctx.devices.lock().unwrap() = vec![demo_entry(ctx)];
    let (ctx, sink) = (ctx.clone(), sink.clone());
    thread::spawn(move || {
        let sigrok = {
            let ctx = ctx.clone();
            thread::spawn(move || match sigrok_device::scan() {
                Ok(found) => found
                    .into_iter()
                    .map(|f| {
                        let mut kinds = ctx.sigrok_kinds.lock().unwrap();
                        let kind = kinds
                            .entry(f.id.clone())
                            .or_insert_with(|| Arc::new(sigrok_device::SigrokKind::new(f.spec, f.channels, f.continuous)))
                            .clone();
                        (f.info, kind)
                    })
                    .collect(),
                Err(e) => {
                    eprintln!("Sigrok scan failed: {e}");
                    Vec::new()
                }
            })
        };
        let la = thread::spawn(logic_analyzer::scan);
        let pico = thread::spawn(sigrok_pico::scan);
        let mut found: Vec<(Value, Arc<dyn DeviceKind>)> = Vec::new();
        for t in [sigrok, la, pico] {
            found.extend(t.join().unwrap_or_default());
        }
        let infos: Vec<Value> = {
            let mut devs = ctx.devices.lock().unwrap();
            for (info, kind) in found {
                let id = info["id"].as_str().unwrap_or("").to_string();
                devs.retain(|e| e.id != id);
                devs.push(Entry { id, info, kind });
            }
            devs.iter().map(|e| e.info.clone()).collect()
        };
        sink.json(&json!({ "type": "devices", "devices": infos }));
    });
}

/// A device's settings form was saved: the answer to the sender, the new info to everyone.
fn apply_device_settings(ctx: &Arc<Ctx>, sink: &Sink, msg: &Value) {
    let (ctx, sink, msg) = (ctx.clone(), sink.clone(), msg.clone());
    // in its own thread: a board can take seconds to answer, the client's thread keeps sending meanwhile
    thread::spawn(move || {
        let reply = |ok: bool, message: &str| {
            let mut m = Map::new();
            m.insert("type".into(), "deviceSettings".into());
            if let Some(id) = msg.get("reqId") {
                m.insert("reqId".into(), id.clone());
            }
            m.insert("ok".into(), ok.into());
            m.insert("message".into(), message.into());
            sink.json(&Value::Object(m));
        };
        let Some((_, kind)) = find(&ctx, msg["deviceId"].as_str()) else {
            return reply(false, "This device has no settings");
        };
        let values = msg.get("values").filter(|v| !v.is_null()).cloned().unwrap_or(json!({}));
        match kind.apply_settings(&values) {
            Ok((message, info)) => {
                {
                    let mut devs = ctx.devices.lock().unwrap();
                    let id = info["id"].as_str().unwrap_or("").to_string();
                    match devs.iter_mut().find(|e| e.id == id) {
                        Some(e) => e.info = info.clone(),
                        None => devs.push(Entry { id, info: info.clone(), kind }),
                    }
                }
                reply(true, &message);
                send_to_all(&ctx, &json!({ "type": "deviceUpdated", "device": info }));
            }
            Err(m) => reply(false, &m),
        }
    });
}

fn send_to_all(ctx: &Ctx, v: &Value) {
    for (_, sink) in ctx.clients.lock().unwrap().iter() {
        sink.json(v);
    }
}

/// A capture's events to the client that started it.
struct ClientEvents {
    sink: Sink,
    /// the resolved channel list of the start message, sent back with done
    channels: Value,
}

impl Events for ClientEvents {
    fn data(&self, chunk: &[u8], _offset: u64) -> bool {
        self.sink.data(chunk.to_vec())
    }

    fn done(&self, info: Value) {
        let msg = merge(merge(json!({ "type": "done" }), info), json!({ "channels": self.channels }));
        self.sink.json(&msg);
    }

    fn error(&self, message: &str, details: Option<&str>) {
        println!("Error: {message}");
        let mut m = json!({ "type": "error", "message": message });
        if let Some(d) = details {
            m["details"] = d.into();
        }
        self.sink.json(&m);
    }

    fn status(&self, status: Value) {
        self.sink.json(&merge(json!({ "type": "trigger" }), status));
    }
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

fn handle_message(text: &str, ctx: &Arc<Ctx>, sink: &Sink, session: &mut Option<Session>) {
    let mut msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return eprintln!("{e}"),
    };
    match msg["type"].as_str() {
        Some("start") => {
            println!("{msg}");
            // a new start replaces whatever this client still had running
            if let Some(stop) = session.take() {
                stop();
            }
            let plain = ClientEvents { sink: sink.clone(), channels: Value::Null };
            let Some((info, kind)) = find(ctx, msg["deviceId"].as_str()) else {
                return plain.error("unknown device", None);
            };
            // the devices always get the channel list: the one asked for, or all channels (see channels.rs)
            match channels::resolve_channels(&msg, &info) {
                Ok(c) => msg["channels"] = json!(c),
                Err(e) => return plain.error(&e, None),
            }
            let events: EventsRef = Arc::new(ClientEvents { sink: sink.clone(), channels: msg["channels"].clone() });
            *session = if js_truthy(msg.get("triggerOn")) && !kind.hardware_trigger() {
                // triggered capture: the device runs continuously, trigger.rs decides what is kept
                trigger::start_triggered(&info, kind, &msg, events)
            } else {
                // a device that triggers itself (LogicAnalyzer) also gets the trigger settings
                kind.start(&msg, events)
            };
        }
        Some("stop") => {
            println!("{msg}");
            match session.take() {
                Some(stop) => stop(),
                None => {
                    if let Some((_, kind)) = find(ctx, msg["deviceId"].as_str()) {
                        kind.stop();
                    }
                }
            }
        }
        Some("refreshdevices") => refresh_devices(ctx, sink),
        Some("deviceSettings") => apply_device_settings(ctx, sink, &msg),
        _ => {}
    }
}

fn is_would_block(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

/// One thread per client. A short read timeout lets the same thread both read client messages
/// and flush whatever the device threads queued up (no split of the socket needed).
fn ws_session(stream: TcpStream, ctx: Arc<Ctx>) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(10)));
    let mut ws = WebSocket::from_raw_socket(stream, Role::Server, None);

    let (tx, rx) = mpsc::channel::<Out>();
    let sink = Sink::new(tx);
    let id = NEXT_CLIENT.fetch_add(1, Ordering::SeqCst);
    ctx.clients.lock().unwrap().push((id, sink.clone()));
    let mut session: Option<Session> = None;
    println!("Client connected");
    refresh_devices(&ctx, &sink);

    'outer: loop {
        // outgoing: everything the device threads queued
        loop {
            match rx.try_recv() {
                Ok(out) => {
                    let msg = match out {
                        Out::Text(s) => Message::Text(s),
                        Out::Binary(b) => Message::Binary(b),
                    };
                    if ws.write(msg).is_err() {
                        break 'outer;
                    }
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }

        // incoming
        match ws.read() {
            Ok(Message::Text(t)) => handle_message(&t, &ctx, &sink, &mut session),
            Ok(Message::Close(_)) => {
                let _ = ws.flush(); // closing reply
                break;
            }
            Ok(_) => {}
            Err(WsError::Io(e)) if is_would_block(&e) => {}
            Err(_) => break,
        }

        // also pushes out the Pong/Close tungstenite queued by itself
        match ws.flush() {
            Ok(()) => {}
            Err(WsError::Io(e)) if is_would_block(&e) => {}
            Err(_) => break,
        }
    }
    // a triggered capture can wait forever: never leave one running for a client that is gone
    if let Some(stop) = session.take() {
        stop();
    }
    ctx.clients.lock().unwrap().retain(|(c, _)| *c != id);
    println!("Client disconnected");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn route(stream: &TcpStream, reader: &mut http::Reader, req: &http::Request, ctx: &Ctx) -> Result<(), HttpError> {
    let raw = req.target.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let pathname = http::percent_decode(raw).ok_or(HttpError(400))?;

    // the user's files
    if pathname == "/api/fs" || pathname.starts_with("/api/fs/") {
        let requested = pathname.strip_prefix("/api/fs/").unwrap_or("");
        println!("FS Request: {} {requested}", req.method);
        let mut extra = Vec::new();
        if let Some(origin) = req.header("origin") {
            if !is_origin_allowed(Some(origin), req.header("host"), &ctx.settings) {
                return Err(HttpError(403));
            }
            extra.push(("Access-Control-Allow-Origin".to_string(), origin.to_string()));
            extra.push(("Vary".to_string(), "Origin".to_string()));
        }
        if req.method == "OPTIONS" {
            // CORS preflight for PUT / DELETE from an allowed page on another origin
            extra.push(("Access-Control-Allow-Methods".into(), "GET, HEAD, PUT, DELETE".into()));
            extra.push(("Access-Control-Allow-Headers".into(), req.header("access-control-request-headers").unwrap_or("").into()));
            extra.push(("Access-Control-Allow-Private-Network".into(), "true".into()));
            extra.push(("Access-Control-Max-Age".into(), "600".into()));
            http::respond_with(stream, 204, None, &extra, &[], false)?;
            return Ok(());
        }
        if !matches!(req.method.as_str(), "GET" | "HEAD" | "PUT" | "DELETE") {
            return Err(HttpError(405));
        }
        return http::serve_fs(stream, reader, req, &ctx.data_dir, requested, &extra);
    }

    // the Python decoder extension: /python/runtime/..., /python/decoders/... (read only)
    if let Some((name, sub)) = pathname.strip_prefix("/python/").and_then(|r| r.split_once('/')) {
        if let Some((_, dir)) = ctx.python.iter().find(|(n, _)| *n == name) {
            if req.method != "GET" && req.method != "HEAD" {
                return Err(HttpError(405));
            }
            let dir = dir.as_ref().ok_or(HttpError(404))?;
            return http::serve_fs(stream, reader, req, dir, sub, &[]);
        }
    }
    http::serve_static(stream, req, &ctx.public_dir, &pathname)
}

/// Is the request for this computer (DNS rebinding)? Each refused name is logged once.
fn check_host(ctx: &Ctx, req: &http::Request) -> bool {
    let host = req.header("host");
    if is_host_allowed(host, &ctx.settings, &ctx.local_names) {
        return true;
    }
    let host = host.unwrap_or("");
    if ctx.refused_hosts.lock().unwrap().insert(host.to_string()) {
        let name = settings::hostname(host).unwrap_or_else(|| host.to_string());
        eprintln!("Request for host {host} refused (start with --allow-host {name} to allow it)");
    }
    false
}

fn handle_connection(stream: TcpStream, ctx: Arc<Ctx>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = io::BufReader::new(&stream);

    let req = match http::read_request(&mut reader) {
        Ok(r) => r,
        Err(e) => {
            if e.kind() == io::ErrorKind::InvalidData {
                http::respond_error(&stream, 400);
            }
            return;
        }
    };

    if !check_host(&ctx, &req) {
        let _ = http::respond(&stream, 403, Some("text/plain; charset=utf-8"), b"Forbidden: unknown host name, see the backend's --allow-host", false);
        drop(reader);
        return http::finish(&stream);
    }

    // WebSocket upgrade shares the HTTP port. WebSockets have no CORS: the browser sends the page's Origin
    // and the server decides.
    let wants_ws = req.method == "GET" && req.header("upgrade").map_or(false, |v| v.eq_ignore_ascii_case("websocket"));
    if wants_ws {
        if !is_origin_allowed(req.header("origin"), req.header("host"), &ctx.settings) {
            let origin = req.header("origin").unwrap_or("");
            eprintln!("WebSocket from {origin} refused (start with --allow-origin {origin} to allow it)");
            return http::respond_error(&stream, 401);
        }
        let Some(key) = req.header("sec-websocket-key").map(str::to_owned) else {
            return http::respond_error(&stream, 400);
        };
        if !reader.buffer().is_empty() {
            return http::respond_error(&stream, 400); // client must wait for the 101 before sending frames
        }
        drop(reader);

        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
        let head = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        if (&stream).write_all(head.as_bytes()).is_err() {
            return;
        }
        return ws_session(stream, ctx);
    }

    if let Err(HttpError(status)) = route(&stream, &mut reader, &req, &ctx) {
        http::respond_error(&stream, status);
    }
    drop(reader);
    http::finish(&stream);
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

/// The WebScope folder: the first folder, from the executable's folder (a stand-alone copy keeps
/// frontend/ next to it) and then from the current folder upwards, that has frontend/index.html.
fn find_root(exe_dir: Option<&Path>) -> Option<PathBuf> {
    let cwd = env::current_dir().ok();
    [exe_dir.map(Path::to_path_buf), cwd]
        .into_iter()
        .flatten()
        .find_map(|base| base.ancestors().find(|d| d.join("frontend").join("index.html").is_file()).map(Path::to_path_buf))
}

/// Opens the page in the default browser (--open).
fn open_browser(url: &str) {
    let r = if cfg!(windows) {
        process::Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else if cfg!(target_os = "macos") {
        process::Command::new("open").arg(url).spawn()
    } else {
        process::Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(e) = r {
        eprintln!("could not open the browser: {e}");
    }
}

/// Root (Linux/macOS) or an elevated administrator (Windows)? Without a crate: the commands that tell.
fn is_admin() -> bool {
    let ok = |cmd: &str, args: &[&str]| {
        process::Command::new(cmd).args(args).stdin(process::Stdio::null()).stdout(process::Stdio::piped())
            .stderr(process::Stdio::null()).output().ok().filter(|o| o.status.success())
    };
    if cfg!(windows) {
        // both only succeed elevated; fltmc also works when the Server service ("net session") is stopped
        ok("fltmc", &[]).is_some() || ok("net", &["session"]).is_some()
    } else {
        ok("id", &["-u"]).is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
    }
}

/// The console on stdin: help, e / exit.
fn console() {
    let prompt = || {
        print!("WebScope> ");
        let _ = io::stdout().flush();
    };
    prompt();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        match line.trim().to_lowercase().as_str() {
            "help" => println!("Commands: help, e/exit"),
            "e" | "exit" => {
                println!("Stopping WebScope...");
                process::exit(0);
            }
            "" => {}
            other => println!("Unknown command: {other}"),
        }
        prompt();
    }
    println!("Console closed.");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let exe_dir = env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let root = find_root(exe_dir.as_deref());

    // settings.json next to the executable, else in the current folder; then the command line
    let default_file = exe_dir.iter().map(|d| d.join("settings.json")).chain([PathBuf::from("settings.json")]).find(|f| f.is_file());
    let mut base = Settings::default();
    if let Some(p) = env::var("PORT").ok().and_then(|p| p.parse().ok()) {
        base.port = p;
    }
    let settings = match settings::load_settings(&args, default_file.as_deref(), base) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            process::exit(1);
        }
    };
    // Elevated, a file request can be raced with a symlink into a file only root/admin may open (TOCTOU between
    // the checks in http.rs and the read/write): any user who can write in user_data_fs would get root's access.
    if is_admin() {
        if !settings.allow_admin {
            eprintln!("Refusing to run as root/administrator: anyone who can write in user_data_fs could then read and write any file.");
            eprintln!("Run it as a normal user (Linux: serial ports need the dialout or uucp group, not sudo), or start with --allow-admin.");
            process::exit(1);
        }
        eprintln!("Running as root/administrator (--allow-admin): anyone who can write in user_data_fs can read and write any file");
    }
    // the drivers read these from the environment; an environment variable that is set wins over settings.json
    if let Some(cli) = &settings.sigrok_cli {
        if env::var_os("SIGROK_CLI").is_none() {
            env::set_var("SIGROK_CLI", cli);
        }
    }
    if !settings.logic_analyzer_hosts.is_empty() && env::var_os("LOGICANALYZER_HOSTS").is_none() {
        env::set_var("LOGICANALYZER_HOSTS", settings.logic_analyzer_hosts.join(","));
    }

    let in_root = |name: &str| root.as_ref().map_or_else(|| PathBuf::from("..").join(name), |r| r.join(name));
    let public_dir = env::var_os("WEBSCOPE_PUBLIC").map(PathBuf::from).unwrap_or_else(|| in_root("frontend"));
    let data_raw = env::var_os("WEBSCOPE_DATA").map(PathBuf::from).unwrap_or_else(|| in_root("user_data_fs"));
    let data_dir = match fs::create_dir_all(&data_raw).and_then(|_| fs::canonicalize(&data_raw)) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{}: {e}", data_raw.display());
            process::exit(1);
        }
    };
    let python = vec![
        ("runtime", fs::canonicalize(in_root("python_runtime")).ok()),
        ("decoders", fs::canonicalize(in_root("python_decoders")).ok()),
    ];

    let port = settings.port;
    let bind = env::var("WEBSCOPE_BIND").unwrap_or_else(|_| "0.0.0.0".into());
    let listener = match TcpListener::bind((bind.as_str(), port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {bind}:{port}: {e}");
            process::exit(1);
        }
    };
    println!("WebScope: http://localhost:{port}");
    println!("WebSocket: ws://localhost:{port}");
    println!("Frontend: {}", public_dir.display());
    if let Some(f) = &settings.file {
        println!("Settings: {}", f.display());
    }
    if !settings.allow_origins.is_empty() {
        println!("Allowed origins: {}", settings.allow_origins.join(", "));
    }
    if !settings.allow_hosts.is_empty() {
        println!("Allowed host names: {}", settings.allow_hosts.join(", "));
    }
    if !settings.host_check {
        eprintln!("Host check off (--no-host-check): open to DNS rebinding from any web page");
    }
    if settings.open {
        open_browser(&format!("http://localhost:{port}?ws=localhost:{port}"));
    }

    let demo = Arc::new(DemoDevice::new());
    let ctx = Arc::new(Ctx {
        local_names: local_hostnames(),
        settings,
        public_dir,
        data_dir,
        python,
        devices: Mutex::new(Vec::new()),
        demo,
        sigrok_kinds: Mutex::new(HashMap::new()),
        clients: Mutex::new(Vec::new()),
        refused_hosts: Mutex::new(HashSet::new()),
    });
    *ctx.devices.lock().unwrap() = vec![demo_entry(&ctx)];

    thread::spawn(console);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let ctx = ctx.clone();
                thread::spawn(move || handle_connection(stream, ctx));
            }
            Err(e) => eprintln!("accept failed: {e}"),
        }
    }
}
