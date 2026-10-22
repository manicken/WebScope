export class DemoWave {
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