class DemoSource {

    static info() {
        return {
            id: 'localdemo',
            name: 'Local Demo device',
            sourceKind: DemoSource,
            channels: [
                {index:0, name:'D0', type: 'logic'},
                {index:1, name:'D1', type: 'logic'},
                {index:2, name:'D2', type: 'logic'},
                {index:3, name:'D3', type: 'logic'},
                {index:4, name:'D4', type: 'logic'},
                {index:5, name:'D5', type: 'logic'},
                {index:6, name:'D6', type: 'logic'},
                {index:7, name:'D7', type: 'logic'},
                {index:8, name:'D8', type: 'logic'},
                {index:9, name:'D9', type: 'logic'},
                {index:10, name:'D10', type: 'logic'},
                {index:11, name:'D11', type: 'logic'},
                {index:12, name:'D12', type: 'logic'},
                {index:13, name:'D13', type: 'logic'},
                {index:14, name:'D14', type: 'logic'},
                {index:15, name:'D15', type: 'logic'},
                {index:16, name:'D16', type: 'logic'},
                {index:17, name:'D17', type: 'logic'},
                {index:18, name:'D18', type: 'logic'},
                {index:19, name:'D19', type: 'logic'},
                {index:20, name:'D20', type: 'logic'},
                {index:21, name:'D21', type: 'logic'},
                {index:22, name:'D22', type: 'logic'},
                {index:23, name:'D23', type: 'logic'},
                {index:24, name:'D24', type: 'logic'},
                {index:25, name:'D25', type: 'logic'},
                {index:26, name:'D26', type: 'logic'},
                {index:27, name:'D27', type: 'logic'},
                {index:28, name:'D28', type: 'logic'},
                {index:29, name:'D29', type: 'logic'},
                {index:30, name:'D30', type: 'logic'},
                {index:31, name:'D31', type: 'logic'},
            ],
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
        const w = new DemoWave({channels:DemoSource.info().channels.length});
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
        t = w.usb({dp:14, dm:15, t, bytes:[0xD2]}) + 2e-6;
        //t = w.usb({dp:14, dm:15, t, bytes:DemoWave.usbData(0x3, [0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00,0x80, 0x06, 0xFF, 0x01, 0x00, 0x00, 0x40, 0x00])}) + 2e-6;

        return w.render({rate});
    }

    // id of the running acquisition, 0 = stopped. A stream loop ends as soon as it is not the
    // current run, so a stop() directly followed by a start() never leaves two loops running.
    static run = 0;
    static #runs = 0;

    static start(cfg, onData, onDone) {
        const run = DemoSource.run = ++DemoSource.#runs;

        const rate = cfg.samplerate;
        const buffer = new Uint32Array(DemoSource.pattern(rate).buffer);
        const total = cfg.samplecount??Number.MAX_VALUE;
        console.log({total, samplecount:cfg.samplecount});
        const chunk = Math.max(1, Math.floor(rate / 100));
        // the pattern has all channels (bit n = channel n): clear the ones that are not active
        const mask = cfg.activeChannels ? cfg.activeChannels.reduce((m, ch) => m | 2 ** ch, 0) : null;
        const pick = mask === null ? null : (src) => src.map((v) => v & mask);

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (DemoSource.run !== run) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                DemoSource.run = 0;
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

            onData(pick ? pick(tmp) : tmp, sent);
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
        DemoSource.run = 0;
    }
}