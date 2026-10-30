//! Port of deviceSettings.js - device settings: a device describes its settings, the browser draws the form.
//!
//! A device info may have `settings: { title, note?, disabled?, fields: [...], values: {...} }` (see
//! deviceSettings.js for the field types). Browser -> backend: { type: 'deviceSettings', reqId, deviceId,
//! values }; backend -> browser: { type: 'deviceSettings', reqId, ok, message }, then to every browser
//! { type: 'deviceUpdated', device: info }. The browser checks the same rules, but anything can send the
//! backend a message: validate_settings() checks them again.

use crate::device::{js_display, js_int};
use serde_json::{Map, Value};

/// The values checked against the settings' fields: every field's value, from `values` or else the current
/// one. Err names the field.
pub fn validate_settings(settings: &Value, values: &Value) -> Result<Map<String, Value>, String> {
    if let Some(reason) = settings.get("disabled").and_then(Value::as_str) {
        return Err(reason.to_string());
    }
    let mut out = Map::new();
    for f in settings["fields"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(key) = f.get("key").and_then(Value::as_str) else { continue }; // a heading
        let v = values.get(key).filter(|v| !v.is_null()).or_else(|| settings["values"].get(key)).cloned().unwrap_or(Value::Null);
        let label = f["label"].as_str().unwrap_or(key);
        let bad = |why: String| format!("{label}: {why}");
        let num = |k: &str| f.get(k).and_then(Value::as_f64);
        match f["type"].as_str().unwrap_or("") {
            "number" => {
                let n = v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| bad("must be a number".into()))?;
                if f["integer"].as_bool() == Some(true) && js_int(&v).is_none() {
                    return Err(bad("must be a whole number".into()));
                }
                if let Some(min) = num("min").filter(|&m| n < m) {
                    return Err(bad(format!("must be at least {}", crate::device::js_num(min))));
                }
                if let Some(max) = num("max").filter(|&m| n > m) {
                    return Err(bad(format!("must be at most {}", crate::device::js_num(max))));
                }
            }
            "text" | "password" => {
                let s = v.as_str().ok_or_else(|| bad("must be text".into()))?;
                let len = s.encode_utf16().count() as f64; // JavaScript's length
                if let Some(min) = num("minLength").filter(|&m| len < m) {
                    return Err(bad(if min == 1.0 { "is needed".into() } else { format!("at least {} characters", crate::device::js_num(min)) }));
                }
                if let Some(max) = num("maxLength").filter(|&m| len > m) {
                    return Err(bad(format!("at most {} characters", crate::device::js_num(max))));
                }
                if let Some(pattern) = f.get("pattern").and_then(Value::as_str) {
                    let re = regex_lite::Regex::new(&format!("^(?:{pattern})$")).map_err(|e| bad(format!("bad pattern: {e}")))?;
                    if !re.is_match(s) {
                        return Err(bad(f["patternHint"].as_str().unwrap_or("wrong format").to_string()));
                    }
                }
            }
            "select" => {
                let options = f["options"].as_array().map(Vec::as_slice).unwrap_or_default();
                if !options.iter().any(|o| strict_eq(&o["value"], &v)) {
                    return Err(bad(format!("\"{}\" is not one of the choices", js_display(&v))));
                }
            }
            "checkbox" => {
                if !v.is_boolean() {
                    return Err(bad("must be on or off".into()));
                }
            }
            other => return Err(bad(format!("unknown field type \"{other}\""))),
        }
        out.insert(key.to_string(), v);
    }
    Ok(out)
}

/// JavaScript's `===` for JSON values (numbers by value: 9600 === 9600.0).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(_) | Value::Object(_), _) => false,
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> Value {
        json!({
            "fields": [
                { "type": "heading", "label": "Network" },
                { "key": "name", "label": "Name", "type": "text", "maxLength": 4 },
                { "key": "port", "label": "Port", "type": "number", "min": 1, "max": 65535, "integer": true },
                { "key": "baud", "label": "Baud", "type": "select", "options": [{ "value": 9600 }, { "value": 115200 }] },
                { "key": "on", "label": "On", "type": "checkbox" },
            ],
            "values": { "name": "ab", "port": 4045, "baud": 9600, "on": false },
        })
    }

    #[test]
    fn values_with_current_ones_for_missing() {
        let v = validate_settings(&settings(), &json!({ "port": 80, "on": true })).unwrap();
        assert_eq!(Value::Object(v), json!({ "name": "ab", "port": 80, "baud": 9600, "on": true }));
    }

    #[test]
    fn each_rule_with_the_label() {
        for (values, want) in [
            (json!({ "name": "abcde" }), "Name: at most 4"),
            (json!({ "name": 5 }), "Name: must be text"),
            (json!({ "port": "80" }), "Port: must be a number"),
            (json!({ "port": 80.5 }), "Port: must be a whole number"),
            (json!({ "port": 0 }), "Port: must be at least 1"),
            (json!({ "port": 70000 }), "Port: must be at most 65535"),
            (json!({ "baud": "9600" }), "Baud: \"9600\" is not one of the choices"),
            (json!({ "on": "yes" }), "On: must be on or off"),
        ] {
            let err = validate_settings(&settings(), &values).unwrap_err();
            assert!(err.contains(want), "{values}: {err}");
        }
    }

    #[test]
    fn patterns_and_disabled() {
        let s = json!({ "fields": [{ "key": "ip", "label": "IP address", "type": "text",
            "pattern": "((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)", "patternHint": "an IPv4 address" }],
            "values": { "ip": "" } });
        assert!(validate_settings(&s, &json!({ "ip": "192.168.1.20" })).is_ok());
        assert!(validate_settings(&s, &json!({ "ip": "192.168.1.300" })).unwrap_err().contains("IP address: an IPv4 address"));
        let d = json!({ "disabled": "no WiFi", "fields": [] });
        assert_eq!(validate_settings(&d, &json!({})).unwrap_err(), "no WiFi");
    }
}
