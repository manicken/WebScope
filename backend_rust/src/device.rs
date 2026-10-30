//! Shared plumbing between the connection thread and the device back-ends (device kinds), and the few
//! JavaScript value rules the browser's messages are checked with (the Node backend's semantics).

use serde_json::{Map, Value};
use std::sync::mpsc::Sender;
use std::sync::Arc;

/// Something a device thread wants sent to the browser.
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
}

/// The outgoing queue of one client. All `send` failures mean "the client is gone".
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
}

/// What a capture reports, the onData / onDone / onError / onStatus callbacks of the Node device kinds.
/// A device may call them from any thread, but never while it holds one of its own locks that stop() takes.
pub trait Events: Send + Sync {
    /// Samples in the browser's format (see channels.rs), `offset` in samples. False: nobody wants
    /// them any more (the client is gone), the device may stop.
    fn data(&self, chunk: &[u8], offset: u64) -> bool;
    /// The capture is over: { samples, samplerate?, stopped, ok, trigger?, warning?, details? }
    fn done(&self, info: Value);
    /// `details`: the extended message for the frontend's message log
    fn error(&self, message: &str, details: Option<&str>);
    /// { state: 'armed' } / { state: 'triggered', sample }
    fn status(&self, _status: Value) {}
}

pub type EventsRef = Arc<dyn Events>;

/// Stops one running capture (the handle start() returns).
pub type Session = Box<dyn Fn() + Send + Sync>;

/// Same shape as `deviceKind` in the Node backend.
pub trait DeviceKind: Send + Sync {
    /// `msg.channels` is already resolved (channels.rs). Returns a handle when the capture can be
    /// stopped on its own (else stop() is used); None also when it was refused (events.error was called).
    fn start(&self, msg: &Value, events: EventsRef) -> Option<Session>;
    fn stop(&self);
    /// It triggers itself: it gets the trigger settings instead of running trigger.rs.
    fn hardware_trigger(&self) -> bool {
        false
    }
    /// Saves the values of the device's settings form (see device_settings.rs): (message, the new device info).
    fn apply_settings(&self, _values: &Value) -> Result<(String, Value), String> {
        Err("This device has no settings".into())
    }
}

/* ============================== JavaScript value rules ============================== */

/// `Number.isInteger(v) ? v : None` (also 5.0, which JSON may carry).
pub fn js_int(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15).then(|| f as i64)
}

/// `Number.isInteger(v) && v > 0`
pub fn as_pos_int(v: &Value) -> Option<u64> {
    js_int(v).filter(|&n| n > 0).map(|n| n as u64)
}

/// JavaScript truthiness of a JSON value.
pub fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `msg.key ?? default` for an optional message value (null counts as missing).
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

/// A number as JavaScript prints it: 1000000, 80.5.
pub fn js_num(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        format!("{f}")
    }
}

/// `${v}` of a JSON value in a JavaScript template string.
pub fn js_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(js_num).unwrap_or_else(|| n.to_string()),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(js_display).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `n.toLocaleString('en')`: 131072 -> "131,072".
pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `{ ...a, ...b }` for objects (`b` wins).
pub fn merge(a: Value, b: Value) -> Value {
    let mut m: Map<String, Value> = match a {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if let Value::Object(bm) = b {
        m.extend(bm);
    }
    Value::Object(m)
}

/// Latin-1 text of bytes (every byte one character), as Node's `toString('latin1')`.
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_rules() {
        assert_eq!(js_int(&json!(5)), Some(5));
        assert_eq!(js_int(&json!(5.0)), Some(5));
        assert_eq!(js_int(&json!(5.5)), None);
        assert_eq!(js_int(&json!("5")), None);
        assert!(js_truthy(Some(&json!({}))));
        assert!(!js_truthy(Some(&json!(null))));
        assert!(!js_truthy(None));
        assert_eq!(js_num(1e6), "1000000");
        assert_eq!(js_num(80.5), "80.5");
        assert_eq!(thousands(131072), "131,072");
        assert_eq!(thousands(999), "999");
        assert_eq!(js_display(&json!("9600")), "9600");
    }
}
