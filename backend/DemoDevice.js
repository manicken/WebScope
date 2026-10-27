import { DemoWave } from './DemoWave.js'
import { makeRepacker } from './channels.js'

export class DemoDevice {

    static info() {
        return {
            id: 'remotedemo',
            name: 'Remote Demo device',
            deviceKind: DemoDevice,
            channels: [
                {index:0, name:'D0', type: 'logic'},
                {index:1, name:'D1', type: 'logic'},
                {index:2, name:'D2', type: 'logic'},
                {index:3, name:'D3', type: 'logic'},
                {index:4, name:'D4', type: 'logic'},
                {index:5, name:'D5', type: 'logic'},
                {index:6, name:'D6', type: 'logic'},
                {index:7, name:'D7', type: 'logic'},
            ],
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
        w.uart( 0, 0.0010, 115_200, DemoDevice.bytes('Hello from WebScope Backend!\r\n'), );
        w.uart( 0, 0.0120, 115_200, DemoDevice.bytes('temp=30.5C\r\n'), );

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
        // the pattern has all 8 channels (1 byte per sample): send only the ones asked for
        const channels = cfg.channels ?? [0, 1, 2, 3, 4, 5, 6, 7];
        const repack = makeRepacker(1, channels);

        let pos = 0;
        let sent = 0;

        const streamChunk = () => {
            if (DemoDevice.run !== run) return;

            const count = Math.min(chunk, total - sent);

            if (count <= 0) {
                DemoDevice.run = 0;
                onDone({ samples: sent, samplerate: rate, channels: channels.length });
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