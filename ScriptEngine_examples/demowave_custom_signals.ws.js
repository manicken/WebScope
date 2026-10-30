({
    /**
     * Makes a capture of its own, like the demo device but with complete freedom: DemoWave (the demo
     * device's signal generator, frontend/js/sources/DemoWave.js) for the usual protocols, and set()
     * for anything else. ws.setCapture() replaces the capture on screen and every decoder runs on it.
     */
    run(ws) {
        const samplerate = 10_000_000;   // 10 MS/s
        const duration = 0.02;           // 20 ms
        const names = ['UART', 'SCL', 'SDA', 'SPI CLK', 'SPI MOSI', 'SPI MISO', 'SPI CS', 'CHIRP', 'GLITCH'];
        const w = new DemoWave({ channels: names.length });

        /* ---- the usual protocols, from DemoWave ---- */
        w.uart({ ch: 0, t: 0.001, baud: 115_200, data: [...'Hello'].map((c) => c.charCodeAt(0)) });
        w.i2c({ scl: 1, sda: 2, t: 0.004, hz: 400_000, segments: [[0xA0, 0x10], [0xA1, 0xBE, 0xEF]], nackLast: true });
        w.setIdle(3, false);
        w.setIdle(6, true);
        w.spi({ clk: 3, mosi: 4, miso: 5, cs: 6, t: 0.007, hz: 2_000_000, tx: [0x9F, 0, 0], rx: [0xFF, 0xEF, 0x40] });

        /* ---- anything else, edge by edge with set(ch, t, level) ---- */

        // a UART byte with a broken stop bit (low instead of high): the decoders show a frame error
        const bt = 1 / 115_200;
        let t = 0.010;
        const bad = 0x55;
        w.set(0, t, false);                                                  // start bit
        for (let i = 0; i < 8; i++) w.set(0, t + bt * (1 + i), ((bad >> i) & 1) === 1);
        w.set(0, t + bt * 9, false);                                         // stop bit: should be high
        w.set(0, t + bt * 12, true);                                         // back to idle

        // a chirp: a square wave whose frequency rises from 1 kHz to 50 kHz over the whole capture
        w.setIdle(7, false);
        t = 0;
        let level = false;
        while (t < duration) {
            const f = 1_000 + (50_000 - 1_000) * (t / duration);
            t += 1 / f / 2;
            level = !level;
            w.set(7, t, level);
        }

        // glitches: pulses of 1 to 5 samples, the kind of thing a real line has
        w.setIdle(8, false);
        for (let k = 1; k <= 5; k++) {
            const at = 0.002 * k;
            w.set(8, at, true);
            w.set(8, at + k / samplerate, false);
        }

        ws.setCapture({ samplerate, samples: w.render({ rate: samplerate, duration }), channels: names });
        ws.log(`${names.length} channels, ${duration * samplerate} samples at ${samplerate / 1e6} MS/s`);
    },
})
