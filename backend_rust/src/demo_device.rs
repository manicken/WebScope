//! Port of DemoDevice.js.

use crate::demo_wave::DemoWave;
use crate::device::{as_pos_int, DeviceKind, Sink};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub struct DemoDevice {
    /// Stop flag of the capture currently running (a new start stops the old one).
    stop: Mutex<Arc<AtomicBool>>,
}

impl DemoDevice {
    pub fn new() -> Self {
        Self { stop: Mutex::new(Arc::new(AtomicBool::new(true))) }
    }

    pub fn info() -> Value {
        json!({
            "id": "remotedemo",
            "name": "Remote Demo device",
            "channels": 8,
            "samplerates": [4_000_000u64, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000],
            "defaultSamplerate": 20_000_000u64,
            "note": "UART D0 · I²C D1/D2 · SPI D3–D6 · PWM D7",
            "missingFirmware": null,
        })
    }

    pub fn pattern(rate: f64) -> Vec<u8> {
        let mut w = DemoWave::new();

        // UART
        w.uart(0, 0.0010, 115_200.0, b"Hello from WebScope Backend!\r\n");
        w.uart(0, 0.0120, 115_200.0, b"temp=30.5C\r\n");

        // I2C
        w.i2c(1, 2, 0.0040, 400_000.0, &[&[0xA0, 0x10, 0xDE, 0xAD]], false);
        w.i2c(1, 2, 0.0065, 400_000.0, &[&[0xA0, 0x10], &[0xA1, 0xBE, 0xEF]], true);

        // SPI
        w.spi([3, 4, 5, 6], 0.0090, 2_000_000.0, &[0x9F, 0, 0, 0], &[0xFF, 0xEF, 0x40, 0x18]);
        w.spi(
            [3, 4, 5, 6],
            0.0160,
            2_000_000.0,
            &[0x03, 0x00, 0x10, 0x00, 0, 0],
            &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        );

        // PWM at 10 kHz with a duty-cycle sweep
        let period: f64 = 1e-4;
        let periods = (0.02 / period).floor() as u32;
        for i in 0..periods {
            let t = f64::from(i) * period;
            let duty = 0.1 + 0.8 * (f64::from(i) / f64::from(periods));
            w.set(7, t, true);
            w.set(7, t + period * duty, false);
        }

        w.render(rate, 0.02)
    }
}

impl DeviceKind for DemoDevice {
    fn start(&self, msg: &Value, sink: Sink) {
        let Some(rate) = msg.get("samplerate").and_then(as_pos_int) else {
            return sink.error("bad samplerate");
        };
        // no samplecount -> run until stopped
        let total = msg.get("samplecount").and_then(as_pos_int).unwrap_or(u64::MAX);

        println!("Demo Device acquire started");
        let stopped = Arc::new(AtomicBool::new(false));
        let previous = std::mem::replace(&mut *self.stop.lock().unwrap(), stopped.clone());
        previous.store(true, Ordering::SeqCst);

        thread::spawn(move || {
            let buffer = DemoDevice::pattern(rate as f64);
            if buffer.is_empty() {
                return sink.error("samplerate too low for the demo pattern");
            }
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
                    sink.done(json!({ "samples": sent, "samplerate": rate, "channels": 8 }));
                    return;
                }

                let count = count as usize;
                let mut tmp = Vec::with_capacity(count);
                while tmp.len() < count {
                    let take = (count - tmp.len()).min(buffer.len() - pos);
                    tmp.extend_from_slice(&buffer[pos..pos + take]);
                    pos = (pos + take) % buffer.len();
                }

                if !sink.data(tmp) {
                    return; // client went away
                }
                sent += count as u64;

                // pace the stream to real time
                let due = Duration::from_secs_f64(sent as f64 / rate as f64);
                if let Some(wait) = due.checked_sub(t0.elapsed()) {
                    thread::sleep(wait);
                }
            }
        });
    }

    fn stop(&self) {
        self.stop.lock().unwrap().store(true, Ordering::SeqCst);
        println!("Demo Device acquire stopped");
    }
}
