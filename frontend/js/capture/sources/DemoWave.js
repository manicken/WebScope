class DemoWave {
  constructor({channels}) {
    this.channels = channels;
    this.edges = Array.from({ length: channels }, () => []);
    // Level before the first edge (defaults match the old hardcoded behaviour).
    this.idle = [true, true, true, false, false, false, true, false];
  }

  setIdle(ch, level) { this.idle[ch] = level; }

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
  uart({ch, t, baud, data}) {
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
  i2c({scl, sda, t, hz, segments, nackLast}) {
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
  spi({clk, mosi, miso, cs, t, hz, tx, rx}) {

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

  pwm({ch, hz, t = 0, dutyStart = 0.1, dutyEnd = 0.9, duration = 0.02}) {
    const period = 1 / hz;
    const periods = Math.floor(duration / period);

    for (let i = 0; i < periods; i++) {
        const _t = t + i * period;
        const duty = dutyStart + (dutyEnd - dutyStart) *
            (periods > 1 ? i / (periods - 1) : 0);

        this.set(ch, _t, true);
        this.set(ch, _t + period * duty, false);
    }
  }

  /**
   * 1-Wire (standard speed): reset + presence, then master writes `tx`, then slave answers `rx`.
   * Bytes are LSB first. Slots are 70 µs.
   */
  onewire({ch, t, tx = [], rx = [], presence = true }) {
    const us = 1e-6;
    this.setIdle(ch, true);

    // Reset pulse, then (optionally) presence pulse from the slave.
    this.set(ch, t, false);
    this.set(ch, t + 480 * us, true);
    if (presence) {
      this.set(ch, t + 510 * us, false);
      this.set(ch, t + 630 * us, true);
    }
    t += 960 * us;

    // low = how long the line is held low in the slot (µs).
    const slot = (low) => {
      this.set(ch, t, false);
      this.set(ch, t + low * us, true);
      t += 70 * us;
    };

    // Write 1: master low 6 µs. Write 0: master low 60 µs.
    for (const byte of tx) for (let i = 0; i < 8; i++) slot((byte >> i) & 1 ? 6 : 60);
    // Read 1: master low 6 µs, slave stays off. Read 0: slave keeps holding the line low.
    for (const byte of rx) for (let i = 0; i < 8; i++) slot((byte >> i) & 1 ? 6 : 45);

    return t;
  }

  /**
   * WS2812 / NeoPixel, 800 kHz. pixels = [[r,g,b], ...], sent as GRB, MSB first.
   */
  ws2812({ch, t, pixels, order= 'RGB', t0h = 0.4e-6, t1h = 0.8e-6, period = 1.25e-6, reset = 80e-6 }) {
    this.setIdle(ch, false);
    for (const pixel of pixels) {
        const color = { r: pixel[0], g: pixel[1], b: pixel[2] };

        for (const component of order) {
            const byte = color[component.toLowerCase()];

            for (let bit = 7; bit >= 0; bit--) {
                this.set(ch, t, true);
                this.set(ch, t + ((byte >> bit) & 1 ? t1h : t0h), false);
                t += period;
            }
        }
    }
    return t + reset; // latch/reset gap
  }

  /**
   * USB packet (SYNC + bytes + EOP) with NRZI and bit stuffing.
   * `bytes` includes the PID byte (PID | ~PID << 4) and CRC, see usbToken/usbData.
   */
  usb({dp, dm, t, bytes, low = false }) {
    const bt = 1 / (low ? 1.5e6 : 12e6);
    const J = low ? [false, true] : [true, false]; // [D+, D-]
    const K = [!J[0], !J[1]];
    this.setIdle(dp, J[0]);
    this.setIdle(dm, J[1]);

    let isK = false, ones = 0;
    const drive = (s) => { this.set(dp, t, s[0]); this.set(dm, t, s[1]); t += bt; };
    const bit = (b) => {
      if (!b) isK = !isK;              // NRZI: 0 = toggle, 1 = hold
      drive(isK ? K : J);
      ones = b ? ones + 1 : 0;
      if (ones === 6) {                // bit stuffing after six 1s
        isK = !isK;
        drive(isK ? K : J);
        ones = 0;
      }
    };

    for (const b of [0, 0, 0, 0, 0, 0, 0, 1]) bit(b);               // SYNC = KJKJKJKK
    for (const byte of bytes) for (let i = 0; i < 8; i++) bit((byte >> i) & 1);
    drive([false, false]); drive([false, false]); drive(J);         // EOP: SE0, SE0, J
    return t;
  }

  static usbCrc5(v11) {
    let crc = 0x1f;
    for (let i = 0; i < 11; i++) {
      crc = ((crc ^ (v11 >> i)) & 1) ? (crc >> 1) ^ 0x14 : crc >> 1;
    }
    return crc ^ 0x1f;
  }

  static usbCrc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
    return crc ^ 0xffff;
  }

  /** Token packet bytes. PIDs: OUT=0x1, IN=0x9, SETUP=0xD. */
  static usbToken(pid, addr, ep) {
    const crc = DemoWave.usbCrc5((addr & 0x7f) | ((ep & 0xf) << 7));
    return [pid | ((~pid & 0xf) << 4), (addr & 0x7f) | ((ep & 1) << 7), (ep >> 1) | (crc << 3)];
  }

  /** Data packet bytes. PIDs: DATA0=0x3, DATA1=0xB. */
  static usbData(pid, payload) {
    const crc = DemoWave.usbCrc16(payload);
    return [pid | ((~pid & 0xf) << 4), ...payload, crc & 0xff, crc >> 8];
  }

  /**
   * Classical CAN, 11-bit ID, single channel (CAN_RX/TX logic level, recessive = 1).
   * Includes CRC15, bit stuffing, ACK slot.
   */
  can({ch, t, id, data = [], baud = 500e3, ack = true }) {
    const bt = 1 / baud;
    this.setIdle(ch, true);

    const bits = [0];                                        // SOF
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(id, 11);
    push(0, 3);                                              // RTR, IDE, r0
    push(data.length, 4);                                    // DLC
    for (const b of data) push(b, 8);

    let crc = 0;                                             // CRC15 over SOF..data
    for (const b of bits) {
      const x = ((crc >> 14) & 1) ^ b;
      crc = (crc << 1) & 0x7fff;
      if (x) crc ^= 0x4599;
    }
    push(crc, 15);

    let last = -1, run = 0;
    const emit = (b, stuff) => {
      this.set(ch, t, b === 1);
      t += bt;
      run = b === last ? run + 1 : 1;
      last = b;
      if (stuff && run === 5) emit(b ^ 1, true);             // stuff bit
    };
    for (const b of bits) emit(b, true);
    emit(1, false);                                          // CRC delimiter
    emit(ack ? 0 : 1, false);                                // ACK slot (dominant if acked)
    emit(1, false);                                          // ACK delimiter
    return t + 10 * bt;                                      // EOF (7) + intermission (3)
  }

  /**
   * I2S (Philips): data changes on the falling BCLK edge, WS changes one BCLK before the MSB.
   * frames = [[left, right], ...] as signed integers.
   */
  i2s({sck, ws, sd, t, fs, frames, bits = 16, slot = bits }) {
    const h = 0.5 / (fs * 2 * slot);   // half BCLK period
    this.setIdle(sck, false);
    this.setIdle(ws, false);
    this.setIdle(sd, false);

    for (const frame of frames) {
      for (let k = 0; k < 2 * slot; k++) {
        const v = frame[k >= slot ? 1 : 0];
        const p = k % slot;
        const bit = p < bits ? (v >>> (bits - 1 - p)) & 1 : 0;
        this.set(ws, t, (k + 1) % (2 * slot) >= slot);       // one clock ahead of the slot
        this.set(sd, t, bit === 1);
        this.set(sck, t + h, true);
        this.set(sck, t + 2 * h, false);
        t += 2 * h;
      }
    }
    return t;
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
  render({rate, duration = 0.02}) {
    
    const n = Math.floor(duration * rate);

    const SampleArray = this.channels <= 8 ? Uint8Array :
                        this.channels <= 16 ? Uint16Array :
                        Uint32Array;

    const out = new SampleArray(n);

    for (let ch = 0; ch < this.edges.length; ch++) {
        const edges = this.edges[ch];

        edges.sort((a, b) => a[0] - b[0]);

        let level = this.idle[ch];
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