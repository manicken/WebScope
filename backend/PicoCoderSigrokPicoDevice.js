// PicoCoderSigrokPicoDevice.js - Raspberry Pi Pico boards running pico-coder's sigrok-pico firmware
// (https://github.com/pico-coder/sigrok-pico), talking the board's own serial protocol (no sigrok-cli needed).
//
//   scanSigrokPicos() -> Promise<info[]>   one info per board: the Pico SDK USB serial ports (2e8a:000a)
//                                          that answer the identify command
//   info.deviceKind.start(msg, onData, onDone, onError) -> {stop()} / .stop()   (same shape as DemoDevice)
//
// The board streams: with a sample count it runs a fixed capture ('F'), without one it runs until it is
// stopped ('C'), so Looping, One shot and the trigger (trigger.js, on the stream) all work. It has no trigger
// of its own (removed from the firmware). A fixed capture that fits the board's buffer works at any
// samplerate; anything longer is streamed through the buffer, and when USB cannot keep up the board aborts.
//
// Protocol (see TECHNICAL.md and sr_device.c in the firmware):
//   '*' reset, '+' stop a capture: single characters. Other commands end with '\n':
//   i -> "SRPICO,A<nn><s>D<nn>,<vv>"    R<rate> / L<count> / D<en><ch> / A<en><ch> -> '*' (nothing when refused)
//   F / C start a fixed / continuous capture. Replies have no line end.
//   Data: see SampleDecoder. The end: "$<byte count>+"; an overflow: "!!!" then "$0+".

import { makeChannelPacker } from './channels.js';

const USB_IDS = [{ vendorId: '2e8a', productId: '000a' }];   // Raspberry Pi, Pico SDK USB serial
const REPLY_TIMEOUT = 1000;         // ms the board may take to answer a command
const SETTLE = 100;                 // ms after a stop / reset before the board is talked to
const STOP_WAIT = 2000;             // ms a stopped board may take to send the rest and its end mark
const DATA_TIMEOUT = 5000;          // ms more than the board needs to fill its buffer before it is given up
const MIN_RATE = 5000, MAX_RATE = 120_000_000;
const DMA_BUF_SIZE = 220_000;       // bytes, RP2040 (an RP2350 has 476000; the board does not say which it is)
const OUT_SAMPLES = 65536;          // samples per onSamples() call at most
// Always enabled, at least: with only D0-D3 enabled the board uses its 4-bit mode ("D4"), which sends wrong,
// almost constant data (measured on a 26-channel board; sigrok-cli shows the same). From D4 on it uses its
// byte mode, which is right and, without RLE, just as many bytes on the wire.
const MIN_HIGHEST = 4;

/* ============================== protocol ============================== */

/** The answer to 'i', e.g. "SRPICO,A031D21,02" (3 analog channels, 21 digital). Null when it is not one. */
export function parseIdentity(text) {
    const m = text.match(/SRPICO,A(\d\d)\dD(\d\d),(\d\d)/);
    if (!m) return null;
    return { analogCount: Number(m[1]), channelCount: Number(m[2]), version: m[3] };
}

/** The GPIO pin of each digital channel, as the firmware's builds map them (its 'n' command does the same). */
export function pinNames(channelCount) {
    return Array.from({ length: channelCount }, (_, i) =>
        'GP' + (channelCount === 21 ? i + 2 : channelCount === 26 && i > 22 ? i + 3 : i));
}

/** Bytes the board stores per sample, from the highest enabled channel (its PIO samples 8, 16 or 32 pins:
 *  4 is not used, see MIN_HIGHEST). */
const storedBytes = (highest) => (highest < 8 ? 1 : highest < 16 ? 2 : 4);

/** The longest fixed capture that fits the board's buffer, in samples: the firmware's own calculation
 *  (chunks of 32 * nibbles * nibbles bytes, an even number of them; it fits when it needs fewer chunks,
 *  counted as (samples / chunk + 2) rounded down to even, with the samples rounded up to a multiple of 4). */
export function bufferSamples(highest, bufSize = DMA_BUF_SIZE) {
    const nibbles = storedBytes(highest) * 2;
    const chunkBytes = 32 * nibbles * nibbles, chunkSamples = (chunkBytes * 2) / nibbles;
    const chunks = Math.floor(bufSize / chunkBytes) & ~1;
    return (chunks - 2) * chunkSamples - 4;
}

/** 1-2-5 steps from 5 kHz to 100 MHz, and 120 MHz (the firmware takes any even rate in between). */
export function samplerates() {
    const list = [];
    for (let decade = 1000; decade <= MAX_RATE; decade *= 10) {
        for (const f of [decade, 2 * decade, 5 * decade]) if (f >= MIN_RATE && f <= MAX_RATE) list.push(f);
    }
    list.push(MAX_RATE);
    return list;
}

/**
 * Decodes the board's data (its byte mode; the 4-bit mode for D0-D3 only is not used, see MIN_HIGHEST):
 *   a sample is `bytes` bytes >= 0x80 of 7 bits each, low bits first; 48..79 = (b - 47) repeats of the
 *   previous sample, 80..127 = (b - 78) * 32 repeats (firmware without RLE sends samples only).
 * '!' = the board aborted (overflow); '$' starts the end mark "$<byte count>+".
 * onSamples(Uint32Array) gets the samples (bit n = channel n), onEnd({ aborted, byteCount, received }) the end.
 */
export class SampleDecoder {
    constructor({ bytes, onSamples, onEnd }) {
        Object.assign(this, { bytes, onSamples, onEnd });
        this.last = null;            // the previous sample, repeated by the run lengths
        this.acc = 0; this.accBytes = 0;
        this.out = new Uint32Array(OUT_SAMPLES); this.n = 0;
        this.received = 0;           // data bytes (what the board counts in its end mark)
        this.aborted = false;
        this.count = null;           // digits of the end mark, null before the '$'
        this.ended = false;
    }

    #emit(v, times = 1) {
        for (let i = 0; i < times; i++) {
            this.out[this.n++] = v;
            if (this.n === this.out.length) this.flush();
        }
    }

    flush() {
        if (this.n === 0) return;
        this.onSamples(this.out.slice(0, this.n));
        this.n = 0;
    }

    #repeat(times) { if (this.last !== null) this.#emit(this.last, times); }

    push(buf) {
        for (const b of buf) {
            if (this.ended) break;
            if (this.count !== null) {                                  // in the end mark
                if (b === 0x2b) this.#end();                            // '+'
                else if (b >= 0x30 && b <= 0x39) this.count += String.fromCharCode(b);
                continue;
            }
            if (b === 0x24) { this.count = ''; continue; }              // '$'
            if (b === 0x21) { this.aborted = true; continue; }          // '!'
            if (b < 48) continue;                                       // reserved
            this.received++;
            if (b >= 0x80) {
                this.acc = (this.acc | ((b & 0x7f) << (7 * this.accBytes))) >>> 0;
                if (++this.accBytes === this.bytes) { this.last = this.acc; this.#emit(this.acc); this.acc = 0; this.accBytes = 0; }
            } else {
                this.#repeat(b < 80 ? b - 47 : (b - 78) * 32);
            }
        }
        this.flush();
    }

    #end() {
        this.ended = true;
        this.flush();
        this.onEnd({ aborted: this.aborted, byteCount: Number(this.count), received: this.received });
    }
}

/**
 * The board's settings for a start message. Throws Error(message). msg.channels is validated by index.js.
 * The board's channels must be enabled from D0 up without gaps: D0..the highest requested channel (at least
 * D0..D4, see MIN_HIGHEST) are captured, and only the requested ones go to the browser.
 */
export function planCapture(msg, dev) {
    const rate = msg.samplerate;
    if (!Number.isInteger(rate) || rate < MIN_RATE || rate > MAX_RATE) throw new Error(`the samplerate must be between ${MIN_RATE} and ${MAX_RATE} Hz`);
    if (msg.channels.at(-1) >= dev.channelCount) throw new Error('bad channel list');
    const highest = Math.min(Math.max(msg.channels.at(-1), MIN_HIGHEST), dev.channelCount - 1);   // the highest enabled
    const count = msg.samplecount;
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) throw new Error('bad samplecount');
    const commands = [`R${rate - (rate % 2)}`];                         // the firmware uses even rates only
    for (let ch = 0; ch < dev.channelCount; ch++) commands.push(`D${ch <= highest ? 1 : 0}${String(ch).padStart(2, '0')}`);
    for (let ch = 0; ch < dev.analogCount; ch++) commands.push(`A0${String(ch).padStart(2, '0')}`);
    // the board captures at least 16 samples, a multiple of 4: the extra ones are not sent on
    if (count !== undefined) commands.push(`L${Math.max(16, Math.ceil(count / 4) * 4)}`);
    return {
        commands,
        start: count !== undefined ? 'F' : 'C',
        count,
        bytes: Math.ceil((highest + 1) / 7),
        // the most the board may take before it sends anything: filling its whole buffer (an RP2350's is larger)
        firstData: (bufferSamples(highest, 476_000) / rate) * 1000 + DATA_TIMEOUT,
    };
}

/* ============================== connection ============================== */

/** A USB serial connection: link.onData(data) / link.onClose() are set by the user; send(text) -> Promise; close() -> Promise. */
async function openLink(path) {
    const link = { onData: null, onClose: null };
    const { SerialPort } = await import('serialport');
    const sp = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())));
    await new Promise((resolve) => sp.set({ dtr: true, rts: true }, () => resolve()));
    sp.on('data', (d) => link.onData?.(d));
    sp.on('error', () => {});
    sp.on('close', () => link.onClose?.());
    link.send = (text) => new Promise((resolve, reject) => sp.write(Buffer.from(text, 'latin1'), (e) => (e ? reject(e) : sp.drain(resolve))));
    link.close = () => new Promise((resolve) => (sp.isOpen ? sp.close(() => resolve()) : resolve()));
    return link;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends text and waits until what came back makes `done(received)` true (its result is returned). */
function ask(link, text, done, what) {
    return new Promise((resolve, reject) => {
        let got = '';
        const finish = (fn, arg) => { clearTimeout(timer); link.onData = null; fn(arg); };
        const timer = setTimeout(() => finish(reject, new Error(`no answer to ${what}`)), REPLY_TIMEOUT);
        link.onData = (d) => {
            got += d.toString('latin1');
            const r = done(got);
            if (r) finish(resolve, r);
        };
        link.send(text).catch((err) => finish(reject, err));
    });
}

/** Stop the board (it may still be capturing from before), reset it, and throw away what it still sends. */
async function reset(link) {
    link.onData = null;
    await link.send('+');
    await sleep(SETTLE);
    await link.send('*');
    await sleep(SETTLE);
}

const identify = (link) => ask(link, 'i\n', parseIdentity, 'the identify command: is it a sigrok-pico board?');
const command = (link, cmd) => ask(link, cmd + '\n', (got) => got.includes('*'), `"${cmd}" (the board refused it)`);

/* ============================== device kind ============================== */

export class PicoCoderSigrokPicoKind {
    #queue = Promise.resolve();
    #session = null;

    /** @param open  opens the connection (a fake board in the tests) */
    constructor(conn, dev, open = openLink) {
        this.conn = conn;
        this.dev = dev;         // parseIdentity() of the board
        this.open = open;
    }

    get busy() { return this.#session !== null; }

    /** Runs fn when the board is free: one connection at a time, also while a stopped capture is being torn down. */
    exclusive(fn) {
        const p = this.#queue.then(fn);
        this.#queue = p.catch(() => {});
        return p;
    }

    /** Connect and identify the board again (scan). */
    probe() {
        return this.exclusive(async () => {
            const link = await this.open(this.conn);
            try { await reset(link); this.dev = await identify(link); }
            finally { await link.close(); }
        });
    }

    start(msg, onData, onDone, onError) {
        if (this.#session) { onError('sigrok-pico - the board is already capturing'); return null; }
        let plan;
        try { plan = planCapture(msg, this.dev); }
        catch (err) { onError('sigrok-pico - ' + err.message); return null; }

        // exactly one of onDone / onError per start; after that the session is over, also when the board is
        // still being stopped (exclusive() makes the next capture wait for that)
        const s = { stopped: false, finished: false, stop: null, sent: 0 };
        this.#session = s;
        const finish = (fn) => {
            if (s.finished) return;
            s.finished = true;
            if (this.#session === s) this.#session = null;
            fn();
        };
        s.done = (stopped, warning, details) => finish(() => onDone({
            deviceId: this.conn,
            samples: s.sent,
            samplerate: msg.samplerate,
            stopped,
            ok: true,
            ...(warning && { warning, details }),
        }));
        this.exclusive(() => this.#run(s, plan, msg, onData))
            .then((end) => s.done(false, end.warning, end.details))
            .catch((err) => finish(() => onError('sigrok-pico - ' + err.message, `${this.conn} (sigrok-pico protocol ${this.dev.version})\n\n${err.stack ?? err.message}`)));

        return { stop: () => this.#stop(s) };
    }

    stop() {
        if (this.#session) this.#stop(this.#session);
    }

    #stop(s) {
        if (s.finished || s.stopped) return;
        s.stopped = true;
        s.stop?.();
        s.done(true);
    }

    /** One capture: connect, reset, set up, start, read until the end mark. Resolves with { warning?, details? }. */
    async #run(s, plan, msg, onData) {
        if (s.stopped) return {};
        const link = await this.open(this.conn);
        try {
            await reset(link);
            this.dev = await identify(link);        // also checks that it still is a sigrok-pico board
            for (const cmd of plan.commands) {
                if (s.stopped) return {};
                await command(link, cmd);
            }
            if (s.stopped) return {};
            // the board sends channels 0..highest (bit n = channel n): the ones not requested are cleared
            const repack = makeChannelPacker(4, msg.channels);
            return await new Promise((resolve, reject) => {
                let timer;
                const wait = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => reject(new Error(why)), ms); };
                wait(plan.firstData, 'the board sends no data');
                const decoder = new SampleDecoder({
                    bytes: plan.bytes,
                    onSamples: (values) => {
                        if (s.stopped) return;
                        const want = plan.count === undefined ? values.length : Math.min(values.length, plan.count - s.sent);
                        if (want <= 0) return;
                        const bytes = new Uint8Array(values.buffer, values.byteOffset, want * 4);
                        onData(repack.run(bytes), s.sent);
                        s.sent += want;
                    },
                    onEnd: (end) => {
                        clearTimeout(timer);
                        if (s.stopped) { resolve({}); return; }
                        const how = `${msg.samplerate} Hz, channels up to D${msg.channels.at(-1)}: ${end.received} data bytes, the board counted ${end.byteCount}`;
                        if (end.aborted) {
                            resolve({ warning: `The board could not send the samples fast enough and stopped after ${s.sent} samples: use a lower samplerate or fewer channels`, details: how });
                        } else if (end.byteCount !== end.received) {
                            resolve({ warning: `${Math.abs(end.byteCount - end.received)} bytes from the board were lost: the capture may have gaps`, details: how });
                        } else if (plan.count !== undefined && s.sent < plan.count) {
                            resolve({ warning: `The board sent only ${s.sent} of ${plan.count} samples`, details: how });
                        } else resolve({});
                    },
                });
                link.onData = (d) => {
                    decoder.push(d);
                    if (!decoder.ended && !s.stopped) wait(plan.firstData, 'the board stopped sending data');
                };
                link.onClose = () => { clearTimeout(timer); reject(new Error('the connection to the board was lost')); };
                // a stop: the board sends what it still has and its end mark; give it STOP_WAIT for that
                s.stop = () => {
                    link.send('+').catch(() => {});
                    wait(STOP_WAIT, 'stopped');
                };
                link.send(plan.start + '\n').catch(reject);
            }).catch((err) => { if (s.stopped) return {}; throw err; });
        } finally {
            s.stop = null;
            link.onData = null;
            link.onClose = null;
            await link.send('+*').catch(() => {});
            await link.close();
        }
    }
}

/* ============================== scan ============================== */

const kinds = new Map();   // port -> PicoCoderSigrokPicoKind: kept between scans, a capturing board is not probed

async function usbPorts() {
    let SerialPort;
    try {
        ({ SerialPort } = await import('serialport'));
    } catch {
        console.warn('sigrok-pico: the serialport package is not installed (npm install), sigrok-pico boards are not scanned');
        return [];
    }
    const ports = await SerialPort.list();
    return ports
        .filter((p) => USB_IDS.some((id) =>
            p.vendorId?.toLowerCase() === id.vendorId && p.productId?.toLowerCase() === id.productId))
        .map((p) => p.path);
}

/** Device info for the browser. */
function describe(kind) {
    const { dev, conn } = kind;
    const buffer = (highest) => bufferSamples(highest);
    const info = {
        id: 'sigrok-pico:' + conn,
        name: `sigrok-pico ${dev.channelCount}ch (${conn})`,
        channels: pinNames(dev.channelCount).map((name, i) => ({ index: i, name, type: 'logic' })),
        samplerates: samplerates(),
        defaultSamplerate: 1_000_000,
        driver: 'sigrok-pico',
        note: `pico-coder sigrok-pico firmware, protocol ${dev.version}. A Timer capture of up to ${buffer(7)} samples (up to D7), ${buffer(15)} (up to D15), ${buffer(31)} (above) fits the board's buffer and works at any samplerate`,
        // what the frontend can offer, see frontend/js/capture/captureLimits.js
        limits: {
            buffer: [
                { below: 8, samples: buffer(7) },
                { below: 16, samples: buffer(15) },
                { below: 32, samples: buffer(31) },
            ],
            // the firmware's notes: 8 or more channels are reliable up to 60 MS/s
            maxSamplerate: [{ below: 7, samplerate: MAX_RATE }, { below: 32, samplerate: 60_000_000 }],
        },
    };
    // non-enumerable so JSON.stringify(info) sends it to the browser without the kind object
    Object.defineProperty(info, 'deviceKind', { value: kind, enumerable: false });
    return info;
}

export async function scanSigrokPicos() {
    const devices = [];
    try {
        for (const conn of await usbPorts()) {
            let kind = kinds.get(conn);
            try {
                if (!kind) {
                    kind = new PicoCoderSigrokPicoKind(conn, null);
                    await kind.probe();
                    kinds.set(conn, kind);
                } else if (!kind.busy) {
                    await kind.probe();
                }
                devices.push(describe(kind));
            } catch (err) {
                // e.g. the port is in use by another program, or the board has other firmware
                console.warn(`sigrok-pico: no board on ${conn}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('sigrok-pico scan failed:', err);
    }
    return devices;
}
