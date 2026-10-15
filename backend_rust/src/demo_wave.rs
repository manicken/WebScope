//! Port of DemoWave.js: builds edge lists for 8 channels and renders them to packed samples.

pub struct DemoWave {
    edges: [Vec<(f64, bool)>; 8],
}

impl DemoWave {
    pub fn new() -> Self {
        Self { edges: Default::default() }
    }

    /// Set a new logic level at time `t` (seconds).
    pub fn set(&mut self, ch: usize, t: f64, value: bool) {
        self.edges[ch].push((t, value));
    }

    /// UART 8N1, idle-high, one extra bit time between characters (11 bit spacing).
    pub fn uart(&mut self, ch: usize, mut t: f64, baud: f64, data: &[u8]) {
        let bt = 1.0 / baud;
        for &byte in data {
            self.set(ch, t, false); // start bit
            for i in 0..8u32 {
                self.set(ch, t + bt * f64::from(1 + i), (byte >> i) & 1 == 1);
            }
            self.set(ch, t + bt * 9.0, true); // stop bit
            t += bt * 11.0;
        }
    }

    pub fn i2c(&mut self, scl: usize, sda: usize, mut t: f64, hz: f64, segments: &[&[u8]], nack_last: bool) {
        let q = 1.0 / hz / 4.0;
        let count: usize = segments.iter().map(|s| s.len()).sum();
        let mut total = 0usize;

        for segment in segments {
            // (repeated) START
            self.set(sda, t, true);
            self.set(scl, t + q, true);
            self.set(sda, t + 2.0 * q, false);
            self.set(scl, t + 3.0 * q, false);
            t += 4.0 * q;

            for &byte in *segment {
                for bit in (0..8).rev() {
                    self.set(sda, t + q, (byte >> bit) & 1 == 1);
                    self.set(scl, t + 2.0 * q, true);
                    self.set(scl, t + 4.0 * q, false);
                    t += 4.0 * q;
                }
                total += 1;

                // ACK is low; the last byte of a read can be NACKed (SDA high)
                let nack = nack_last && total == count;
                self.set(sda, t + q, nack);
                self.set(scl, t + 2.0 * q, true);
                self.set(scl, t + 4.0 * q, false);
                t += 4.0 * q;
            }
        }

        // STOP
        self.set(sda, t + q, false);
        self.set(scl, t + 2.0 * q, true);
        self.set(sda, t + 3.0 * q, true);
    }

    pub fn spi(&mut self, pins: [usize; 4], mut t: f64, hz: f64, tx: &[u8], rx: &[u8]) {
        let [clk, mosi, miso, cs] = pins;
        let h = 0.5 / hz;

        self.set(cs, t, false); // CS active
        t += h * 2.0;

        for i in 0..tx.len().min(rx.len()) {
            let (tx_byte, rx_byte) = (tx[i], rx[i]);
            for bit in (0..8).rev() {
                self.set(mosi, t, (tx_byte >> bit) & 1 == 1);
                self.set(miso, t, (rx_byte >> bit) & 1 == 1);
                self.set(clk, t + h, true);
                self.set(clk, t + 2.0 * h, false);
                t += 2.0 * h;
            }
            t += h * 2.0;
        }

        self.set(cs, t + h, true); // CS inactive
    }

    /// One byte per sample, bit N = channel N.
    pub fn render(&mut self, rate: f64, duration: f64) -> Vec<u8> {
        let n = (duration * rate).floor() as usize;
        let mut out = vec![0u8; n];

        for (ch, edges) in self.edges.iter_mut().enumerate() {
            // stable sort, same as Array.prototype.sort
            edges.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

            // idle-high channels
            let mut level = matches!(ch, 0 | 1 | 2 | 6);
            let mut k = 0;

            for (i, sample) in out.iter_mut().enumerate() {
                let t = i as f64 / rate;
                while k < edges.len() && edges[k].0 <= t {
                    level = edges[k].1;
                    k += 1;
                }
                if level {
                    *sample |= 1 << ch;
                }
            }
        }
        out
    }
}
