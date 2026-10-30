//! Port of DemoDevice.js: a generated signal (UART, I²C, SPI, PWM), streamed in real time, with settings.

use crate::channels::channel_packer;
use crate::demo_wave::DemoWave;
use crate::device::{as_pos_int, get, thousands, DeviceKind, EventsRef, Session};
use crate::device_settings::validate_settings;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The signal generators, each on fixed channels: on when its checkbox is on and the device has its channels.
struct Generator {
    key: &'static str,
    label: &'static str,
    channels: &'static [u32],
    place: &'static str,
}

const GENERATORS: [Generator; 4] = [
    Generator { key: "uart", label: "UART", channels: &[0], place: "D0" },
    Generator { key: "i2c", label: "I²C", channels: &[1, 2], place: "D1/D2" },
    Generator { key: "spi", label: "SPI", channels: &[3, 4, 5, 6], place: "D3–D6" },
    Generator { key: "pwm", label: "PWM", channels: &[7], place: "D7" },
];

pub struct DemoDevice {
    /// The settings (see device_settings.rs), until the backend is restarted.
    config: Mutex<Map<String, Value>>,
    /// Stop flag of the capture currently running (a new start stops the old one).
    stop: Mutex<Arc<AtomicBool>>,
}

impl DemoDevice {
    pub fn new() -> Self {
        let config = json!({
            "channels": 8,
            "uart": true, "i2c": true, "spi": true, "pwm": true,
            "uartText": "Hello from WebScope Backend!",
            "uartBaud": 115_200,
            "pwmFrequency": 10_000,
        });
        Self { config: Mutex::new(config.as_object().unwrap().clone()), stop: Mutex::new(Arc::new(AtomicBool::new(true))) }
    }

    fn is_on(c: &Map<String, Value>, g: &Generator) -> bool {
        let channels = c["channels"].as_u64().unwrap_or(0);
        c[g.key].as_bool() == Some(true) && g.channels.iter().all(|&ch| u64::from(ch) < channels)
    }

    pub fn info(&self) -> Value {
        let c = self.config.lock().unwrap().clone();
        let channels = c["channels"].as_u64().unwrap_or(8);
        let note: Vec<String> = GENERATORS.iter().filter(|g| Self::is_on(&c, g)).map(|g| format!("{} {}", g.label, g.place)).collect();
        let mut fields = vec![
            json!({ "key": "channels", "label": "Channels", "type": "number", "min": 1, "max": 8, "integer": true }),
            json!({ "type": "heading", "label": "Signals" }),
        ];
        for g in &GENERATORS {
            fields.push(json!({ "key": g.key, "label": format!("{} on {}", g.label, g.place), "type": "checkbox",
                "help": format!("needs {} channels", g.channels.last().unwrap() + 1) }));
        }
        fields.extend([
            json!({ "type": "heading", "label": "UART" }),
            json!({ "key": "uartText", "label": "Text", "type": "text", "maxLength": 200 }),
            json!({ "key": "uartBaud", "label": "Baud rate", "type": "select",
                "options": ([9600u64, 57_600, 115_200, 1_000_000].iter().map(|b| json!({ "value": b, "label": format!("{} baud", thousands(*b)) })).collect::<Vec<_>>()) }),
            json!({ "type": "heading", "label": "PWM" }),
            json!({ "key": "pwmFrequency", "label": "Frequency (Hz)", "type": "number", "min": 100, "max": 1_000_000, "integer": true }),
        ]);
        json!({
            "id": "remotedemo",
            "name": "Remote Demo device",
            "channels": (0..channels).map(|i| json!({ "index": i, "name": format!("D{i}"), "type": "logic" })).collect::<Vec<_>>(),
            "samplerates": [4_000_000u64, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000],
            "defaultSamplerate": 20_000_000u64,
            "note": if note.is_empty() { "no signals".to_string() } else { note.join(" · ") },
            "missingFirmware": null,
            "settings": {
                "title": "Remote Demo device settings",
                "note": "Kept in the backend until it is restarted. The next capture uses them.",
                "fields": fields,
                "values": c,
            },
        })
    }

    /// The demo signal at `rate`: one byte per sample, bit n = channel n (exactly as DemoDevice.js).
    pub fn pattern(c: &Map<String, Value>, rate: f64) -> Vec<u8> {
        let on = |key: &str| Self::is_on(c, GENERATORS.iter().find(|g| g.key == key).unwrap());
        let mut w = DemoWave::new();

        if on("uart") {
            let baud = c["uartBaud"].as_f64().unwrap_or(115_200.0);
            let text = format!("{}\r\n", c["uartText"].as_str().unwrap_or(""));
            w.uart(0, 0.0010, baud, text.as_bytes());
            w.uart(0, 0.0120, baud, b"temp=30.5C\r\n");
        }
        if on("i2c") {
            w.i2c(1, 2, 0.0040, 400_000.0, &[&[0xA0, 0x10, 0xDE, 0xAD]], false);
            w.i2c(1, 2, 0.0065, 400_000.0, &[&[0xA0, 0x10], &[0xA1, 0xBE, 0xEF]], true);
        }
        if on("spi") {
            w.spi([3, 4, 5, 6], 0.0090, 2_000_000.0, &[0x9F, 0, 0, 0], &[0xFF, 0xEF, 0x40, 0x18]);
            w.spi([3, 4, 5, 6], 0.0160, 2_000_000.0, &[0x03, 0x00, 0x10, 0x00, 0, 0], &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        }
        // PWM with a duty-cycle sweep
        if on("pwm") {
            let period = 1.0 / c["pwmFrequency"].as_f64().unwrap_or(10_000.0);
            let periods = (0.02 / period).floor() as u32;
            for i in 0..periods {
                let t = f64::from(i) * period;
                let duty = 0.1 + 0.8 * (f64::from(i) / f64::from(periods));
                w.set(7, t, true);
                w.set(7, t + period * duty, false);
            }
        }
        w.render(rate, 0.02)
    }
}

impl DeviceKind for DemoDevice {
    fn start(&self, msg: &Value, events: EventsRef) -> Option<Session> {
        let Some(rate) = msg.get("samplerate").and_then(as_pos_int) else {
            events.error("bad samplerate", None);
            return None;
        };
        // no samplecount = run until stop() (triggered capture)
        let total = get(msg, "samplecount").and_then(as_pos_int).unwrap_or(u64::MAX);
        // the pattern has all 8 channels (1 byte per sample, bit n = channel n): clear the ones not asked for
        let channels: Vec<u32> = match msg["channels"].as_array() {
            Some(a) => a.iter().filter_map(|c| c.as_u64().map(|n| n as u32)).collect(),
            None => (0..8).collect(),
        };
        let config = self.config.lock().unwrap().clone();

        println!("Demo Device acquire started");
        let stopped = Arc::new(AtomicBool::new(false));
        let previous = std::mem::replace(&mut *self.stop.lock().unwrap(), stopped.clone());
        previous.store(true, Ordering::SeqCst);

        thread::spawn(move || {
            let buffer = DemoDevice::pattern(&config, rate as f64);
            if buffer.is_empty() {
                return events.error("samplerate too low for the demo pattern", None);
            }
            let repack = channel_packer(1, &channels, None);
            let chunk = (rate / 100).max(1);
            let (mut pos, mut sent) = (0usize, 0u64);
            let t0 = Instant::now();

            loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                let count = chunk.min(total - sent);
                if count == 0 {
                    stopped.store(true, Ordering::SeqCst);
                    events.done(json!({ "samples": sent, "samplerate": rate, "channels": channels.last().map_or(0, |c| c + 1) }));
                    return;
                }
                let count = count as usize;
                let mut tmp = Vec::with_capacity(count);
                while tmp.len() < count {
                    let take = (count - tmp.len()).min(buffer.len() - pos);
                    tmp.extend_from_slice(&buffer[pos..pos + take]);
                    pos = (pos + take) % buffer.len();
                }
                if !events.data(&repack.run(&tmp), sent) {
                    return; // the client went away
                }
                sent += count as u64;

                // pace the stream to real time
                let due = Duration::from_secs_f64(sent as f64 / rate as f64);
                if let Some(wait) = due.checked_sub(t0.elapsed()) {
                    thread::sleep(wait);
                }
            }
        });
        None
    }

    fn stop(&self) {
        self.stop.lock().unwrap().store(true, Ordering::SeqCst);
        println!("Demo Device acquire stopped");
    }

    fn apply_settings(&self, values: &Value) -> Result<(String, Value), String> {
        let v = validate_settings(&self.info()["settings"], values)?;
        *self.config.lock().unwrap() = v;
        Ok(("Remote Demo device: settings saved, the next capture uses them".into(), self.info()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_change_channels_note_and_pattern() {
        let d = DemoDevice::new();
        let (_, info) = d.apply_settings(&json!({ "channels": 4, "spi": false, "pwm": false })).unwrap();
        assert_eq!(info["channels"].as_array().unwrap().len(), 4);
        assert_eq!(info["note"], "UART D0 · I²C D1/D2");
        assert_eq!(info["settings"]["values"]["channels"], 4);
        let samples = DemoDevice::pattern(&d.config.lock().unwrap(), 1_000_000.0);
        assert!(samples.iter().all(|s| s & 0b1000_1000 == 0));
        assert!(d.apply_settings(&json!({ "channels": 9 })).unwrap_err().contains("Channels: must be at most 8"));
        assert_eq!(d.config.lock().unwrap()["channels"], 4, "a refused save changes nothing");
    }
}
