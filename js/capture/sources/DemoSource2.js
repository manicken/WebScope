class DemoSource2 {

    start(cfg, onData, onDone) {
      const n = Math.max(64, Math.round(cfg.samplerate * cfg.duration));
      const samples = new Uint32Array(n);
      const spb = cfg.samplerate / 115200; // UART bit period for channel 0
      const msg = 'Hello, WebScope!\r\n';
      let bitPos = 0, phase = 'idle', charIdx = 0, curByte = 0, curBit = 0;
      for (let i = 0; i < n; i++) {
        let word = 0;
        // ---- channel 0: UART TX ----
        let ch0 = 1;
        const bitsElapsed = i / spb;
        if (phase === 'idle') { ch0 = 1; if (charIdx < msg.length && bitsElapsed - bitPos >= 3) { phase = 'start'; bitPos = bitsElapsed; } }
        else if (phase === 'start') { ch0 = 0; if (bitsElapsed - bitPos >= 1) { phase = 'data'; curBit = 0; curByte = msg.charCodeAt(charIdx); bitPos = bitsElapsed; } }
        else if (phase === 'data') {
          ch0 = (curByte >> curBit) & 1;
          if (bitsElapsed - bitPos >= 1) { curBit++; bitPos = bitsElapsed; if (curBit >= 8) phase = 'stop'; }
        } else if (phase === 'stop') { ch0 = 1; if (bitsElapsed - bitPos >= 1) { phase = 'idle'; charIdx = (charIdx + 1) % msg.length; bitPos = bitsElapsed; } }
        if (ch0) word |= 1 << 0;
        // ---- channel 1: SCL-ish clock, channel 2: SDA-ish data (loose I2C-shaped toggling) ----
        const period = Math.max(4, Math.round(cfg.samplerate / 20000));
        if ((i % period) < period / 2) word |= 1 << 1;
        if ((i % (period * 3)) < period * 1.5) word |= 1 << 2;
        // ---- channels 3-6: SPI-ish clock/mosi/miso/cs ----
        const spiPeriod = Math.max(4, Math.round(cfg.samplerate / 40000));
        const csWindow = spiPeriod * 20;
        const csOn = (i % (csWindow * 2)) < csWindow;
        if (!csOn) word |= 1 << 6; // cs active low -> idle high
        if (csOn && (i % spiPeriod) < spiPeriod / 2) word |= 1 << 3; // clk
        if (csOn && ((i / spiPeriod) | 0) % 2 === 0) word |= 1 << 4; // mosi
        samples[i] = word;
      }
      // Stream it in chunks via requestAnimationFrame so the UI shows progress, like a real capture.
      let offset = 0;
      const STEP = Math.max(1024, Math.round(n / 30));
      const tick = () => {
        const end = Math.min(n, offset + STEP);
        onData(samples.subarray(offset, end), offset);
        offset = end;
        if (offset < n) requestAnimationFrame(tick);
        else onDone({ samples: n, samplerate: cfg.samplerate, channels: 8 });
      };
      requestAnimationFrame(tick);
    }
    stop() {}
  }