class DemoSource {

    /** The signal generators, each on fixed channels: on when its checkbox is on and the device has its channels. */
    static GENERATORS = [
        { key: 'uart', label: 'UART', channels: [0], where: 'D0' },
        { key: 'i2c', label: 'I²C', channels: [1, 2], where: 'D1/D2' },
        { key: 'spi', label: 'SPI', channels: [3, 4, 5, 6], where: 'D3–D6' },
        { key: 'pwm', label: 'PWM', channels: [7], where: 'D7' },
        { key: 'onewire', label: '1-Wire', channels: [8], where: 'D8' },
        { key: 'ws2812', label: 'WS2812', channels: [9], where: 'D9' },
        { key: 'can', label: 'CAN', channels: [10], where: 'D10' },
        { key: 'i2s', label: 'I²S', channels: [11, 12, 13], where: 'D11–D13' },
        { key: 'usb', label: 'USB', channels: [14, 15], where: 'D14/D15' },
    ];

    /** The settings (see backend/deviceSettings.js), until the page is reloaded. */
    static config = {
        channels: 32,
        ...Object.fromEntries(DemoSource.GENERATORS.map((g) => [g.key, true])),
        uartText: 'Hello from WebScope Frontend!',
        uartBaud: 115_200,
        pwmFrequency: 10_000,
    };

    static isOn(gen) {
        const c = DemoSource.config;
        return c[gen.key] && gen.channels.every((ch) => ch < c.channels);
    }

    static info() {
        const c = DemoSource.config;
        return {
            id: 'localdemo',
            name: 'Local Demo device',
            sourceKind: DemoSource,
            channels: Array.from({ length: c.channels }, (_, i) => ({ index: i, name: 'D' + i, type: 'logic' })),
            samplerates: [4_000_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000],
            defaultSamplerate: 20_000_000,
            note: DemoSource.GENERATORS.filter(DemoSource.isOn).map((g) => `${g.label} ${g.where}`).join(' · ') || 'no signals',
            missingFirmware: null,
            settings: {
                title: 'Local Demo device settings',
                note: 'Kept until the page is reloaded. The next capture uses them.',
                fields: [
                    { key: 'channels', label: 'Channels', type: 'select', options: [8, 16, 24, 32].map((n) => ({ value: n, label: `${n} channels` })) },
                    { type: 'heading', label: 'Signals' },
                    ...DemoSource.GENERATORS.map((g) => ({
                        key: g.key, label: `${g.label} on ${g.where}`, type: 'checkbox',
                        ...(g.channels.at(-1) >= 8 && { help: 'needs 16 channels' }),
                    })),
                    { type: 'heading', label: 'UART' },
                    { key: 'uartText', label: 'Text', type: 'text', maxLength: 200 },
                    { key: 'uartBaud', label: 'Baud rate', type: 'select',
                      options: [9600, 57_600, 115_200, 1_000_000].map((b) => ({ value: b, label: `${b.toLocaleString('en')} baud` })) },
                    { type: 'heading', label: 'PWM' },
                    { key: 'pwmFrequency', label: 'Frequency (Hz)', type: 'number', min: 100, max: 1_000_000, integer: true },
                ],
                values: { ...c },
            },
        };
    }

    /** Called by DeviceSettingsDialog with values it has checked. */
    static async applySettings(device, values) {
        DemoSource.config = { ...DemoSource.config, ...values };
        window.WS.sources.updateDevice(DemoSource.info());
        return { message: 'Local Demo device: settings saved, the next capture uses them' };
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
        const c = DemoSource.config;
        const on = (key) => DemoSource.isOn(DemoSource.GENERATORS.find((g) => g.key === key));
        const w = new DemoWave({channels:c.channels});
        const tOffset = 0.01;
        // UART
        if (on('uart')) {
            w.uart({ch:0, t:0+tOffset, baud:c.uartBaud, data:DemoSource.bytes(c.uartText + '\r\n')});
            w.uart({ch:0, t:0.005+tOffset, baud:c.uartBaud, data:DemoSource.bytes('temp=22.5C\r\n')});
        }

        // I2C
        if (on('i2c')) {
            w.i2c({scl:1, sda:2, t:0+tOffset, hz:400_000, segments:[[0xA0, 0x10, 0xDE, 0xAD]], nackLast:false});
            w.i2c({scl:1, sda:2, t:0.005+tOffset, hz:400_000, segments:[[0xA0, 0x10], [0xA1, 0xBE, 0xEF]], nackLast:true});
        }

        // SPI
        if (on('spi')) {
            w.spi({clk:3, mosi:4, miso:5, cs:6, t:0+tOffset, hz:2_000_000, tx:[0x9F, 0, 0, 0], rx:[0xFF, 0xEF, 0x40, 0x18]});
            w.spi({clk:3, mosi:4, miso:5, cs:6, t:0.005+tOffset, hz:2_000_000, tx:[0x03, 0x00, 0x10, 0x00, 0, 0], rx:[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]});
        }

        // PWM
        if (on('pwm')) w.pwm({ch:7, t:0/*+tOffset*/, hz:c.pwmFrequency, dutyStart:0.1, dutyEnd:0.9});

        // 1-Wire: Skip ROM + Read Scratchpad
        if (on('onewire')) w.onewire({ch:8, t:0+tOffset, tx:[0xCC, 0xBE], rx:[0x50, 0x05, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10, 0x1C]});

        // WS2812: röd, grön, blå
        if (on('ws2812')) {
            w.ws2812({ch:9, t:0+tOffset, pixels:[[255, 0, 0], [0, 255, 0], [0, 0, 255]], order:'RGB'});
            w.ws2812({ch:9, t:0.001+tOffset, pixels:[[0x55, 0, 0], [0, 0x55, 0], [0, 0, 0x55]], order:'RGB'});
            w.ws2812({ch:9, t:0.002+tOffset, pixels:[[0xAA, 0, 0], [0, 0xAA, 0], [0, 0, 0xAA]], order:'RGB'});
        }

        // CAN
        if (on('can')) w.can({ch:10, t:0+tOffset, id:0x123, data:[0xDE, 0xAD, 0xBE, 0xEF]});

        // I2S: sinus, 48 kHz, 16 bit
        if (on('i2s')) {
            const sine = Array.from({ length: 32 }, (_, i) => {
            const s = Math.round(Math.sin(i / 32 * 2 * Math.PI) * 12000);
            return [s, -s];
            });
            w.i2s({sck:11, ws:12, sd:13, t:0+tOffset, fs:48000, frames:sine});
        }

        // USB full-speed: SETUP + DATA0 (GET_DESCRIPTOR) + ACK
        if (on('usb')) {
            let t = tOffset;
            t = w.usb({dp:14, dm:15, t, bytes:DemoWave.usbToken(0xD, 0, 0)}) + 2e-6;
            t = w.usb({dp:14, dm:15, t, bytes:DemoWave.usbData(0x3, [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00])}) + 2e-6;
            t = w.usb({dp:14, dm:15, t, bytes:[0xD2]}) + 2e-6;
        }
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
        // the pattern has 1, 2 or 4 bytes per sample (by the channel count), the capture gets 4
        const buffer = Uint32Array.from(DemoSource.pattern(rate));
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