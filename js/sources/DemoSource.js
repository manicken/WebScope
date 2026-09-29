class DemoWave {
  constructor() {
    this.edges = Array.from({ length: 8 }, () => []);
  }

  /**
   * Set a new logic level at a specific time.
   *
   * @param {number} ch
   * @param {number} t Time in seconds.
   * @param {boolean} value
   */
  set(ch, t, value) {
    this.edges[ch].push([t, value]);
  }

  /**
   * Generate UART, 8N1, idle-high.
   *
   * The Rust implementation leaves one extra bit time between
   * characters, hence the 11 bit character spacing.
   *
   * @param {number} ch
   * @param {number} t Start time in seconds.
   * @param {number} baud
   * @param {Uint8Array|number[]} data
   */
  uart(ch, t, baud, data) {
    const bt = 1 / baud;

    for (const byte of data) {
      // Start bit.
      this.set(ch, t, false);

      // 8 data bits, LSB first.
      for (let i = 0; i < 8; i++) {
        this.set(ch, t + bt * (1 + i), ((byte >> i) & 1) === 1);
      }

      // Stop bit / idle.
      this.set(ch, t + bt * 9, true);

      // Next character.
      t += bt * 11;
    }
  }

  /**
   * Generate an I2C transaction.
   *
   * @param {number} scl
   * @param {number} sda
   * @param {number} t Start time in seconds.
   * @param {number} hz Bus frequency.
   * @param {Array<Uint8Array|number[]>} segments
   * @param {boolean} nackLast
   */
  i2c(scl, sda, t, hz, segments, nackLast) {
    const q = 1 / hz / 4;

    let total = 0;
    const count = segments.reduce((sum, segment) => sum + segment.length, 0);

    for (const segment of segments) {
      // Repeated START:
      //
      // SDA high
      // SCL high
      // SDA low
      // SCL low
      this.set(sda, t, true);
      this.set(scl, t + q, true);
      this.set(sda, t + 2 * q, false);
      this.set(scl, t + 3 * q, false);

      t += 4 * q;

      for (const byte of segment) {
        // MSB first.
        for (let bit = 7; bit >= 0; bit--) {
          this.set(sda, t + q, ((byte >> bit) & 1) === 1);
          this.set(scl, t + 2 * q, true);
          this.set(scl, t + 4 * q, false);

          t += 4 * q;
        }

        total++;

        // ACK is low.
        // For the final byte of a read transaction, the master
        // can instead generate a NACK (SDA high).
        const nack = nackLast && total === count;

        this.set(sda, t + q, nack);
        this.set(scl, t + 2 * q, true);
        this.set(scl, t + 4 * q, false);

        t += 4 * q;
      }
    }

    // STOP:
    //
    // SDA low
    // SCL high
    // SDA high
    this.set(sda, t + q, false);
    this.set(scl, t + 2 * q, true);
    this.set(sda, t + 3 * q, true);
  }

  /**
   * Generate SPI transaction.
   *
   * @param {[number, number, number, number]} pins
   * @param {number} t Start time in seconds.
   * @param {number} hz Clock frequency.
   * @param {Uint8Array|number[]} tx
   * @param {Uint8Array|number[]} rx
   */
  spi(pins, t, hz, tx, rx) {
    const [clk, mosi, miso, cs] = pins;
    const h = 0.5 / hz;

    // CS active.
    this.set(cs, t, false);

    t += h * 2;

    for (let i = 0; i < Math.min(tx.length, rx.length); i++) {
      const txByte = tx[i];
      const rxByte = rx[i];

      // MSB first.
      for (let bit = 7; bit >= 0; bit--) {
        this.set(mosi, t, ((txByte >> bit) & 1) === 1);
        this.set(miso, t, ((rxByte >> bit) & 1) === 1);

        this.set(clk, t + h, true);
        this.set(clk, t + 2 * h, false);

        t += 2 * h;
      }

      t += h * 2;
    }

    // CS inactive.
    this.set(cs, t + h, true);
  }

  /**
   * Render edge representation into packed digital samples.
   *
   * One byte contains the logic level of all 8 channels.
   *
   * @param {number} rate
   * @param {number} duration
   * @returns {Uint8Array}
   */
  render(rate, duration = 0.02) {
    const n = Math.floor(duration * rate);
    const out = new Uint8Array(n);

    for (let ch = 0; ch < this.edges.length; ch++) {
      const edges = this.edges[ch];

      // Same ordering semantics as Rust's sort_by().
      edges.sort((a, b) => a[0] - b[0]);

      // Rust:
      //
      // let mut level = matches!(ch, 0 | 1 | 2 | 6);
      //
      // These channels are idle-high.
      let level = ch === 0 || ch === 1 || ch === 2 || ch === 6;

      let k = 0;

      for (let i = 0; i < n; i++) {
        const t = i / rate;

        while (k < edges.length && edges[k][0] <= t) {
          level = edges[k][1];
          k++;
        }

        if (level) {
          out[i] |= 1 << ch;
        }
      }
    }

    return out;
  }
}

class DemoSource {
  static ID = 'demo';

  static info() {
    return {
      id: 'demo',
      name: 'Demo device',
      driver: 'demo',
      channels: 8,
      samplerates: [
        4_000_000,
        8_000_000,
        10_000_000,
        20_000_000,
        25_000_000,
        50_000_000,
        100_000_000,
      ],
      defaultSamplerate: 20_000_000,
      note: 'UART D0 · I²C D1/D2 · SPI D3–D6 · PWM D7',
      missingFirmware: null,
    };
  }

  /**
   * Convert a normal string to the byte representation used by
   * the Rust b"..." literals.
   *
   * @param {string} text
   * @returns {Uint8Array}
   */
  static bytes(text) {
    return new TextEncoder().encode(text);
  }

  /**
   * Generate exactly the same waveform as Rust pattern().
   *
   * @param {number} rate
   * @returns {Uint8Array}
   */
  static pattern(rate) {
    const w = new DemoWave();

    // UART
    w.uart( 0, 0.0010, 115_200, DemoSource.bytes('Hello from WebScope!\r\n'), );

    w.uart( 0, 0.0120, 115_200, DemoSource.bytes('temp=22.5C\r\n'), );

    // I2C
    w.i2c( 1, 2, 0.0040, 400_000,
      [
        [0xA0, 0x10, 0xDE, 0xAD],
      ],
      false,
    );

    w.i2c( 1, 2, 0.0065, 400_000,
      [
        [0xA0, 0x10],
        [0xA1, 0xBE, 0xEF],
      ],
      true,
    );

    // SPI
    w.spi(
      [3, 4, 5, 6],
      0.0090,
      2_000_000,
      [0x9F, 0, 0, 0],
      [0xFF, 0xEF, 0x40, 0x18],
    );

    w.spi(
      [3, 4, 5, 6],
      0.0160,
      2_000_000,
      [0x03, 0x00, 0x10, 0x00, 0, 0],
      [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
    );

    // PWM at 10 kHz with a duty-cycle sweep.
    const period = 1e-4;
    const periods = Math.floor(0.02 / period);

    for (let i = 0; i < periods; i++) {
      const t = i * period;
      const duty = 0.1 + 0.8 * (i / periods);

      w.set(7, t, true);
      w.set(7, t + period * duty, false);
    }

    return w.render(rate);
  }

  constructor() {
    this.stopped = false;
  }
  
    start(cfg, onData, onDone) {
        this.stopped = false;

        const rate = cfg.samplerate;
        const buffer = DemoSource.pattern(rate);
        const total = Math.max(1, Math.round(rate * cfg.duration));
        const chunk = Math.max(1, Math.floor(rate / 100));

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (this.stopped) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                this.stopped = true;
                onDone({ samples: sent, samplerate: rate, channels: 8 });
                return;
            }

            const tmp = new Uint8Array(count);
            let offset = 0;

            while (offset < count) {
                const take = Math.min(count - offset, buffer.length - pos);

                tmp.set(buffer.subarray(pos, pos + take), offset);

                offset += take;
                pos = (pos + take) % buffer.length;
            }

            onData(tmp, sent);
            sent += count;

            const dueMs = sent / rate * 1000;
            const elapsedMs = performance.now() - t0;
            const delay = Math.max(0, dueMs - elapsedMs);

            setTimeout(streamChunk, delay);
            
        };

        const t0 = performance.now();
        streamChunk();
    }

  stop() {
    this.stopped = true;
  }
}