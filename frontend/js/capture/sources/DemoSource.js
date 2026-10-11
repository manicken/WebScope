

class DemoSource {

    static info() {
        return {
            id: 'localdemo',
            name: 'Local Demo device',
            sourceKind: DemoSource,
            channels: 8,
            samplerates: [4_000_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000 ],
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
        w.uart( 0, 0.0010, 115_200, DemoSource.bytes('Hello from WebScope Frontend!\r\n'), );
        w.uart( 0, 0.0120, 115_200, DemoSource.bytes('temp=22.5C\r\n'), );

        // I2C
        w.i2c( 1, 2, 0.0040, 400_000, [ [0xA0, 0x10, 0xDE, 0xAD], ], false, );
        w.i2c( 1, 2, 0.0065, 400_000, [ [0xA0, 0x10], [0xA1, 0xBE, 0xEF], ], true, );

        // SPI
        w.spi( [3, 4, 5, 6], 0.0090, 2_000_000, [0x9F, 0, 0, 0], [0xFF, 0xEF, 0x40, 0x18], );
        w.spi( [3, 4, 5, 6], 0.0160, 2_000_000, [0x03, 0x00, 0x10, 0x00, 0, 0], [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], );

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

    static stopped = false;
    
    static start(cfg, onData, onDone) {
        DemoSource.stopped = false;

        const rate = cfg.samplerate;
        const buffer = DemoSource.pattern(rate);
        const total = cfg.samplecount;
        const chunk = Math.max(1, Math.floor(rate / 100));

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (DemoSource.stopped) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                DemoSource.stopped = true;
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

    static stop() {
        DemoSource.stopped = true;
    }
}