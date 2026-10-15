//! Shared plumbing between the connection thread and the device back-ends.

use serde_json::{json, Map, Value};
use std::sync::mpsc::Sender;

/// Something a device thread wants sent to the browser.
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
}

/// Handle a device thread uses to talk to the client that started it.
/// All `send` failures mean "the client is gone" -> the device should stop.
#[derive(Clone)]
pub struct Sink {
    tx: Sender<Out>,
}

impl Sink {
    pub fn new(tx: Sender<Out>) -> Self {
        Self { tx }
    }

    pub fn json(&self, v: &Value) -> bool {
        self.tx.send(Out::Text(v.to_string())).is_ok()
    }

    /// Raw packed samples (binary WebSocket frame).
    pub fn data(&self, chunk: Vec<u8>) -> bool {
        self.tx.send(Out::Binary(chunk)).is_ok()
    }

    pub fn error(&self, message: &str) {
        eprintln!("Error: {message}");
        self.json(&json!({ "type": "error", "message": message }));
    }

    /// Sends `{type:"done", ...info}`.
    pub fn done(&self, info: Value) {
        let mut m: Map<String, Value> = match info {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        m.insert("type".into(), "done".into());
        self.json(&Value::Object(m));
    }
}

/// Same shape as `deviceKind` in the JS version: start(msg, ...) / stop().
pub trait DeviceKind: Send + Sync {
    fn start(&self, msg: &Value, sink: Sink);
    fn stop(&self);
}

/// Mirrors JS `Number.isInteger(x) && x > 0`.
pub fn as_pos_int(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return (n > 0).then_some(n);
    }
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f > 0.0 && f < 9.0e15).then(|| f as u64)
}
