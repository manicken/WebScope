class DemoSource {

    static info() {
        return {
            id: 'localdemo',
            name: 'Local Demo device',
            sourceKind: DemoSource,
            channels: 32,
            samplerates: [4_000_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000],
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
        const w = new DemoWave({channels:DemoSource.info().channels});
        const tOffset = 0.01;
        // UART
        w.uart({ch:0, t:0+tOffset, baud:115_200, data:DemoSource.bytes('Hello from WebScope Frontend!\r\n')});
        w.uart({ch:0, t:0.005+tOffset, baud:115_200, data:DemoSource.bytes('temp=22.5C\r\n')});

        // I2C
        w.i2c({scl:1, sda:2, t:0+tOffset, hz:400_000, segments:[[0xA0, 0x10, 0xDE, 0xAD]], nackLast:false});
        w.i2c({scl:1, sda:2, t:0.005+tOffset, hz:400_000, segments:[[0xA0, 0x10], [0xA1, 0xBE, 0xEF]], nackLast:true});

        // SPI
        w.spi({clk:3, mosi:4, miso:5, cs:6, t:0+tOffset, hz:2_000_000, tx:[0x9F, 0, 0, 0], rx:[0xFF, 0xEF, 0x40, 0x18]});
        w.spi({clk:3, mosi:4, miso:5, cs:6, t:0.005+tOffset, hz:2_000_000, tx:[0x03, 0x00, 0x10, 0x00, 0, 0], rx:[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]});

        // PWM
        w.pwm({ch:7, t:0/*+tOffset*/, hz:10_000, dutyStart:0.1, dutyEnd:0.9});

        // 1-Wire: Skip ROM + Read Scratchpad
        w.onewire({ch:8, t:0+tOffset, tx:[0xCC, 0xBE], rx:[0x50, 0x05, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10, 0x1C]});

        // WS2812: röd, grön, blå
        w.ws2812({ch:9, t:0+tOffset, pixels:[[255, 0, 0], [0, 255, 0], [0, 0, 255]], order:'RGB'});
        w.ws2812({ch:9, t:0.001+tOffset, pixels:[[0x55, 0, 0], [0, 0x55, 0], [0, 0, 0x55]], order:'RGB'});
        w.ws2812({ch:9, t:0.002+tOffset, pixels:[[0xAA, 0, 0], [0, 0xAA, 0], [0, 0, 0xAA]], order:'RGB'});

        // CAN
        w.can({ch:10, t:0+tOffset, id:0x123, data:[0xDE, 0xAD, 0xBE, 0xEF]});

        // I2S: sinus, 48 kHz, 16 bit
        const sine = Array.from({ length: 32 }, (_, i) => {
        const s = Math.round(Math.sin(i / 32 * 2 * Math.PI) * 12000);
        return [s, -s];
        });
        w.i2s({sck:11, ws:12, sd:13, t:0+tOffset, fs:48000, frames:sine});

        // USB full-speed: SETUP + DATA0 (GET_DESCRIPTOR) + ACK
        let t = tOffset;
        t = w.usb({dp:14, dm:15, t, bytes:DemoWave.usbToken(0xD, 0, 0)}) + 2e-6;
        t = w.usb({dp:14, dm:15, t, bytes:DemoWave.usbData(0x3, [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00])}) + 2e-6;
        w.usb({dp:14, dm:15, t, bytes:[0xD2]});

        return w.render({rate});
    }

    static stopped = false;

    static start(cfg, onData, onDone) {
        DemoSource.stopped = false;

        const rate = cfg.samplerate;
        const buffer = new Uint32Array(DemoSource.pattern(rate).buffer);
        const total = cfg.samplecount;
        const chunk = Math.max(1, Math.floor(rate / 100));

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (DemoSource.stopped) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                DemoSource.stopped = true;
                onDone({
                    samples: sent,
                    samplerate: rate,
                    channels: cfg.channels
                });
                return;
            }

            const tmp = new Uint32Array(count);
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