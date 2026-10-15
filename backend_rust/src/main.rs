//! WebScope backend (Rust port of server.js): HTTP + WebSocket on one port.
//!
//!   env PORT             default 8080
//!   env WEBSCOPE_BIND    default 0.0.0.0
//!   env WEBSCOPE_PUBLIC  default ../frontend      (static files)
//!   env WEBSCOPE_DATA    default ../user_data_fs  (/api/fs root)
//!   env SIGROK_CLI       full path to sigrok-cli(.exe), otherwise auto-detected

mod demo_device;
mod demo_wave;
mod device;
mod http;
mod sigrok_device;

use demo_device::DemoDevice;
use device::{DeviceKind, Out, Sink};
use http::HttpError;
use serde_json::{json, Value};
use sigrok_device::SigrokKind;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{self, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{env, fs, io, thread};
use tungstenite::protocol::Role;
use tungstenite::{Error as WsError, Message, WebSocket};

struct Entry {
    id: String,
    info: Value,
    kind: Arc<dyn DeviceKind>,
}

struct Ctx {
    public_dir: PathBuf,
    data_dir: PathBuf, // canonical
    devices: Mutex<Vec<Entry>>,
    demo: Arc<DemoDevice>,
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

fn find_kind(ctx: &Ctx, id: Option<&str>) -> Option<Arc<dyn DeviceKind>> {
    let id = id?;
    ctx.devices.lock().unwrap().iter().find(|e| e.id == id).map(|e| e.kind.clone())
}

/// Scans in the background; the full device list is sent to `sink` when the scan is finished.
fn refresh_devices(ctx: &Arc<Ctx>, sink: &Sink) {
    let ctx = ctx.clone();
    let sink = sink.clone();
    thread::spawn(move || {
        let found = match sigrok_device::scan() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("sigrok scan failed: {e}");
                Vec::new()
            }
        };

        let infos: Vec<Value> = {
            let mut devs = ctx.devices.lock().unwrap();
            let mut next = vec![Entry { id: "remotedemo".into(), info: DemoDevice::info(), kind: ctx.demo.clone() }];
            for f in found {
                let sigrok_device::Found { id, spec, channels, info } = f;
                // keep the existing kind so a running capture can still be stopped after a rescan
                let kind = devs
                    .iter()
                    .find(|e| e.id == id)
                    .map(|e| e.kind.clone())
                    .unwrap_or_else(|| Arc::new(SigrokKind::new(spec, channels)) as Arc<dyn DeviceKind>);
                next.push(Entry { id, info, kind });
            }
            *devs = next;
            devs.iter().map(|e| e.info.clone()).collect()
        };
        sink.json(&json!({ "type": "devices", "devices": infos }));
    });
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

fn handle_message(text: &str, ctx: &Arc<Ctx>, sink: &Sink) {
    let msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return eprintln!("{e}"),
    };
    match msg["type"].as_str() {
        Some("start") => {
            println!("{msg}");
            match find_kind(ctx, msg["deviceId"].as_str()) {
                Some(kind) => kind.start(&msg, sink.clone()),
                None => sink.error("unknown device"),
            }
        }
        Some("stop") => {
            println!("{msg}");
            if let Some(kind) = find_kind(ctx, msg["deviceId"].as_str()) {
                kind.stop();
            }
        }
        Some("refreshdevices") => refresh_devices(ctx, sink),
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
    println!("Client connected");
    refresh_devices(&ctx, &sink);

    loop {
        // outgoing: everything the device threads queued
        loop {
            match rx.try_recv() {
                Ok(out) => {
                    let msg = match out {
                        Out::Text(s) => Message::Text(s),
                        Out::Binary(b) => Message::Binary(b),
                    };
                    if ws.write(msg).is_err() {
                        return;
                    }
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }

        // incoming
        match ws.read() {
            Ok(Message::Text(t)) => handle_message(&t, &ctx, &sink),
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
    println!("Client disconnected");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn route(stream: &TcpStream, reader: &mut http::Reader, req: &http::Request, ctx: &Ctx) -> Result<(), HttpError> {
    let raw = req.target.split(|c| c == '?' || c == '#').next().unwrap_or("");
    let pathname = http::percent_decode(raw).ok_or(HttpError(400))?;

    if pathname == "/api/fs" || pathname.starts_with("/api/fs/") {
        if !matches!(req.method.as_str(), "GET" | "HEAD" | "PUT" | "DELETE") {
            return Err(HttpError(405));
        }
        let requested = pathname.strip_prefix("/api/fs/").unwrap_or("");
        return http::serve_fs(stream, reader, req, &ctx.data_dir, requested);
    }
    http::serve_static(stream, req, &ctx.public_dir, &pathname)
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

    // WebSocket upgrade shares the HTTP port
    let wants_ws = req.method == "GET" && req.header("upgrade").map_or(false, |v| v.eq_ignore_ascii_case("websocket"));
    if wants_ws {
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

fn main() -> io::Result<()> {
    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let bind = env::var("WEBSCOPE_BIND").unwrap_or_else(|_| "0.0.0.0".into());
    let public_dir = PathBuf::from(env::var_os("WEBSCOPE_PUBLIC").unwrap_or_else(|| "../frontend".into()));
    let data_raw = PathBuf::from(env::var_os("WEBSCOPE_DATA").unwrap_or_else(|| "../user_data_fs".into()));
    fs::create_dir_all(&data_raw)?;
    let data_dir = fs::canonicalize(&data_raw)?;

    let demo = Arc::new(DemoDevice::new());
    let ctx = Arc::new(Ctx {
        public_dir,
        data_dir,
        devices: Mutex::new(vec![Entry { id: "remotedemo".into(), info: DemoDevice::info(), kind: demo.clone() }]),
        demo,
    });

    let listener = TcpListener::bind((bind.as_str(), port))?;
    println!("WebScope: http://localhost:{port}");
    println!("WebSocket: ws://localhost:{port}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let ctx = ctx.clone();
                thread::spawn(move || handle_connection(stream, ctx));
            }
            Err(e) => eprintln!("accept failed: {e}"),
        }
    }
    Ok(())
}
