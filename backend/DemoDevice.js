import { DemoWave } from './DemoWave.js'
import { makeChannelPacker } from './channels.js'
import { validateSettings } from './deviceSettings.js'

export class DemoDevice {

    /** The signal generators, each on fixed channels: on when its checkbox is on and the device has its channels. */
    static GENERATORS = [
        { key: 'uart', label: 'UART', channels: [0], where: 'D0' },
        { key: 'i2c', label: 'I²C', channels: [1, 2], where: 'D1/D2' },
        { key: 'spi', label: 'SPI', channels: [3, 4, 5, 6], where: 'D3–D6' },
        { key: 'pwm', label: 'PWM', channels: [7], where: 'D7' },
    ];

    /** The settings (see deviceSettings.js), until the backend is restarted. */
    static config = {
        channels: 8,
        uart: true, i2c: true, spi: true, pwm: true,
        uartText: 'Hello from WebScope Backend!',
        uartBaud: 115_200,
        pwmFrequency: 10_000,
    };

    static isOn(gen) {
        const c = DemoDevice.config;
        return c[gen.key] && gen.channels.every((ch) => ch < c.channels);
    }

    static info() {
        const c = DemoDevice.config;
        return {
            id: 'remotedemo',
            name: 'Remote Demo device',
            deviceKind: DemoDevice,
            channels: Array.from({ length: c.channels }, (_, i) => ({ index: i, name: 'D' + i, type: 'logic' })),
            samplerates: [4_000_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000 ],
            defaultSamplerate: 20_000_000,
            note: DemoDevice.GENERATORS.filter(DemoDevice.isOn).map((g) => `${g.label} ${g.where}`).join(' · ') || 'no signals',
            missingFirmware: null,
            settings: {
                title: 'Remote Demo device settings',
                note: 'Kept in the backend until it is restarted. The next capture uses them.',
                fields: [
                    { key: 'channels', label: 'Channels', type: 'number', min: 1, max: 8, integer: true },
                    { type: 'heading', label: 'Signals' },
                    ...DemoDevice.GENERATORS.map((g) => ({
                        key: g.key, label: `${g.label} on ${g.where}`, type: 'checkbox',
                        help: `needs ${g.channels.at(-1) + 1} channels`,
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

    static async applySettings(values) {
        DemoDevice.config = validateSettings(DemoDevice.info().settings, values);
        return { message: 'Remote Demo device: settings saved, the next capture uses them', info: DemoDevice.info() };
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
        const c = DemoDevice.config;
        const on = (key) => DemoDevice.isOn(DemoDevice.GENERATORS.find((g) => g.key === key));
        const w = new DemoWave();

        // UART
        if (on('uart')) {
            w.uart( 0, 0.0010, c.uartBaud, DemoDevice.bytes(c.uartText + '\r\n'), );
            w.uart( 0, 0.0120, c.uartBaud, DemoDevice.bytes('temp=30.5C\r\n'), );
        }

        // I2C
        if (on('i2c')) {
            w.i2c( 1, 2, 0.0040, 400_000, [ [0xA0, 0x10, 0xDE, 0xAD], ], false, );
            w.i2c( 1, 2, 0.0065, 400_000, [ [0xA0, 0x10], [0xA1, 0xBE, 0xEF], ], true, );
        }

        // SPI
        if (on('spi')) {
            w.spi( [3, 4, 5, 6], 0.0090, 2_000_000, [0x9F, 0, 0, 0], [0xFF, 0xEF, 0x40, 0x18], );
            w.spi( [3, 4, 5, 6], 0.0160, 2_000_000, [0x03, 0x00, 0x10, 0x00, 0, 0], [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], );
        }

        // PWM with a duty-cycle sweep.
        if (on('pwm')) {
            const period = 1 / c.pwmFrequency;
            const periods = Math.floor(0.02 / period);

            for (let i = 0; i < periods; i++) {
                const t = i * period;
                const duty = 0.1 + 0.8 * (i / periods);

                w.set(7, t, true);
                w.set(7, t + period * duty, false);
            }
        }

        return w.render(rate);
    }

    // id of the running acquisition, 0 = stopped. A stream loop ends as soon as it is not the
    // current run, so a stop() directly followed by a start() never leaves two loops running.
    static run = 0;
    static #runs = 0;

    static start(cfg, onData, onDone) {
        console.log("Demo Device acquire started");
        const run = DemoDevice.run = ++DemoDevice.#runs;

        const rate = cfg.samplerate;
        const buffer = DemoDevice.pattern(rate);
        const total = cfg.samplecount ?? Infinity;   // no samplecount = run until stop() (triggered capture)
        const chunk = Math.max(1, Math.floor(rate / 100));
        // the pattern has all 8 channels (1 byte per sample, bit n = channel n): clear the ones not asked for
        const channels = cfg.channels ?? [0, 1, 2, 3, 4, 5, 6, 7];
        const repack = makeChannelPacker(1, channels);

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (DemoDevice.run !== run) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                DemoDevice.run = 0;
                onDone({ samples: sent, samplerate: rate, channels: channels.at(-1) + 1 });
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

            onData(repack.run(tmp), sent);
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
        DemoDevice.run = 0;
        console.log("Demo Device acquire stopped");
    }
}