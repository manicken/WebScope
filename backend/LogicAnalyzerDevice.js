// LogicAnalyzerDevice.js - gusmanb/logicanalyzer boards (https://github.com/gusmanb/logicanalyzer, firmware V6_x)
// from the Node.js backend, talking the board's own protocol (no extra program needed).
//
//   scanLogicAnalyzers() -> Promise<info[]>   one info per board: the USB serial ports with the LogicAnalyzer's
//                                             vendor / product id (1209:3020), plus the WiFi boards listed in
//                                             env LOGICANALYZER_HOSTS, e.g. "192.168.1.20:4045,192.168.1.21:4045"
//   info.deviceKind.start(msg, onData, onDone, onError, onStatus) -> {stop()} / .stop()   (same shape as DemoDevice)
//
// The board does not stream: it captures into its own memory (128 KB on a Pico = 131072 samples when only
// channels 1-8 are used, half of that up to channel 16, a quarter above) and sends it when the capture is done.
// So it has to trigger itself: info.deviceKind.hardwareTrigger tells index.js not to use trigger.js.
//   L2H / H2L   the board's "edge" trigger, which really fires on the level: at the first sample where the
//               channel is high (L2H) / low (H2L), also when the channel already is at that level when armed
//   PulseH / PulseL and the other channel conditions are not supported
// A capture without a trigger triggers on the board's external trigger input (GPIO1 on a Pico) being low,
// which it is when nothing drives it (the pin's pull-down).
//
// WiFi settings (deviceSettings.js): a board with a WiFi firmware build (ID "LOGIC_ANALYZER_WIFI_..." on a Pico W,
// any board name ending in WIFI for other builds, e.g. "P2WIFI")
// takes its network name, password, IP address and port with command 2, over USB, and keeps them in its flash.
// It joins the network (WPA2) and uses that IP address itself (no DHCP). The board cannot tell its settings back.

import net from 'node:net';
import { makeChannelPacker } from './channels.js';
import { validateSettings } from './deviceSettings.js';

const USB_IDS = [{ vendorId: '1209', productId: '3020' }];
const MIN_MAJOR_VERSION = 6;        // the CAPTURE_REQUEST layout below is the one of firmware V6_x
const REPLY_TIMEOUT = 5000;         // ms the board may take to answer a request
const CANCEL_WAIT = 2500;           // ms: a capturing board only looks for the cancel byte every 2 s
const START_TIMEOUT = 5000;         // ms more than the capture itself before a capture without trigger is given up
const SKIP_UNTRIGGERED = 2;         // pre-trigger samples asked for (and thrown away) in a capture without trigger

/* ============================== protocol ============================== */

/** A frame to the board: 0x55 0xAA, the payload with 0xAA / 0x55 / 0xF0 escaped as 0xF0 (b ^ 0xF0), 0xAA 0x55. */
export function frame(payload) {
    const out = [0x55, 0xAA];
    for (const b of payload) {
        if (b === 0xAA || b === 0x55 || b === 0xF0) out.push(0xF0, b ^ 0xF0);
        else out.push(b);
    }
    out.push(0xAA, 0x55);
    return Uint8Array.from(out);
}

/** Command 1 + the firmware's CAPTURE_REQUEST struct (48 bytes, little endian, natural alignment). */
export function captureRequest(r) {
    const b = new Uint8Array(1 + 48);
    const v = new DataView(b.buffer);
    b[0] = 1;                                   // command: capture request
    b[1] = r.triggerType;                       // 0 = edge (simple), 1 = complex, 2 = fast, 3 = blast
    b[2] = r.trigger;                           // trigger channel, channelCount = the external trigger input
    b[3] = r.inverted ? 1 : 0;
    v.setUint16(5, r.triggerValue ?? 0, true);
    b.set(r.channels, 7);                       // channels[24]
    b[31] = r.channels.length;
    v.setUint32(33, r.frequency, true);
    v.setUint32(37, r.preSamples, true);
    v.setUint32(41, r.postSamples, true);
    b[45] = r.loopCount ?? 0;
    b[46] = r.measure ?? 0;
    b[47] = r.captureMode;                      // 0 = 8 channels (1 byte per sample), 1 = 16 (2), 2 = 24 (4)
    return b;
}

/**
 * Command 2 + the firmware's WIFI_SETTINGS_REQUEST struct (116 bytes): apName[33], passwd[64], ipAddress[16]
 * (ASCII, zero padded, so at most 32 / 63 / 15 characters), 1 byte padding, uint16 port (little endian).
 */
export function wifiSettingsRequest({ ssid, password, ip, port }) {
    const b = new Uint8Array(1 + 116);
    b[0] = 2;
    const put = (text, at, size) => {
        if (!/^[\x20-\x7e]*$/.test(text) || text.length >= size) throw new Error(`"${text}" does not fit the board's settings`);
        b.set(Buffer.from(text, 'latin1'), 1 + at);
    };
    put(ssid, 0, 33);
    put(password, 33, 64);
    put(ip, 97, 16);
    new DataView(b.buffer).setUint16(1 + 114, port, true);
    return b;
}

/** The answer to the ID request (5 lines): board name, version and limits. Throws Error(message). */
export function parseIdentity(lines) {
    const m = lines[0]?.match(/^LOGIC_ANALYZER_(.*?)_?V(\d+)_(\d+)$/);
    if (!m) throw new Error(`not a LogicAnalyzer board (it answered "${lines[0] ?? ''}")`);
    const [, board, major, minor] = m;
    if (Number(major) < MIN_MAJOR_VERSION) throw new Error(`firmware V${major}_${minor} is too old, V${MIN_MAJOR_VERSION}_0 or newer is needed`);
    const value = (i, key) => {
        const n = Number(lines[i]?.match(new RegExp(`^${key}:(\\d+)$`))?.[1]);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`bad ${key} line from the board: "${lines[i] ?? ''}"`);
        return n;
    };
    return {
        board: board || 'board',
        version: `V${major}_${minor}`,
        maxFrequency: value(1, 'FREQ'),
        blastFrequency: value(2, 'BLASTFREQ'),
        bufferSize: value(3, 'BUFFER'),
        channelCount: value(4, 'CHANNELS'),
    };
}

/** The lowest samplerate the board can do (its PIO clock divider is 16 bits), as the LogicAnalyzer software has it. */
const minFrequency = (dev) => Math.ceil((dev.maxFrequency * 2) / 65535);

/** 1-2-5 steps from the lowest to the highest samplerate: all of them divide the board's clock evenly. */
export function samplerates(dev) {
    const list = [];
    for (let decade = 1; decade <= dev.maxFrequency; decade *= 10) {
        for (const f of [decade, 2 * decade, 5 * decade]) {
            if (f >= minFrequency(dev) && f <= dev.maxFrequency) list.push(f);
        }
    }
    if (list.at(-1) !== dev.maxFrequency) list.push(dev.maxFrequency);
    return list;
}

/**
 * What to ask the board for, and which of the samples it sends back go to the browser. Throws Error(message).
 * msg.channels is already validated by index.js (resolveChannels).
 *
 * The board's capture = preSamples - 1 samples, the trigger sample, postSamples samples. For WebScope's
 * preTrigger samples, the trigger sample, postTrigger samples it is asked for at least 2 / 2 (the LogicAnalyzer
 * software's minimum) and the extra samples in front are skipped.
 * @returns {{ request:object, unit:number, skip:number, count:number, trigger?:number, warning?:string }}
 */
export function planCapture(msg, dev) {
    const channels = msg.channels;
    const maxChannel = channels.at(-1);
    const captureMode = maxChannel < 8 ? 0 : maxChannel < 16 ? 1 : 2;
    const unit = [1, 2, 4][captureMode];          // bytes per sample from the board
    const maxSamples = Math.floor(dev.bufferSize / unit);
    const memory = `the board holds ${maxSamples} samples ${captureMode === 0 ? 'with channels 1-8' : captureMode === 1 ? 'with channels up to 16' : 'with channels above 16'}`;

    const frequency = msg.samplerate;
    if (!Number.isInteger(frequency) || frequency < minFrequency(dev) || frequency > dev.maxFrequency) {
        throw new Error(`the samplerate must be between ${minFrequency(dev)} and ${dev.maxFrequency} Hz`);
    }
    const request = { channels, frequency, captureMode };

    if (msg.triggerOn) {
        const t = msg.triggerOn;
        if (t.type !== 'L2H' && t.type !== 'H2L') throw new Error('the board only triggers on L2H / H2L');
        if (t.conditions && Object.keys(t.conditions).length) throw new Error('the board cannot check other channels at the trigger');
        if (!Number.isInteger(t.channel) || t.channel < 0 || t.channel >= dev.channelCount) throw new Error('bad trigger channel');
        const pre = msg.preTrigger ?? 0, post = msg.postTrigger ?? 0;
        if (!Number.isInteger(pre) || pre < 0) throw new Error('bad preTrigger');
        if (!Number.isInteger(post) || post < 0) throw new Error('bad postTrigger');
        const preSamples = Math.max(pre + 1, 2), postSamples = Math.max(post, 2);
        const maxPre = Math.floor(maxSamples / 10);   // the LogicAnalyzer software's limit
        if (preSamples > maxPre) throw new Error(`at most ${maxPre - 1} samples before the trigger: ${memory}, a tenth of them before the trigger`);
        if (preSamples + postSamples > maxSamples) throw new Error(`the capture is too long: ${memory}`);
        return {
            request: { ...request, triggerType: 0, trigger: t.channel, inverted: t.type === 'H2L', preSamples, postSamples },
            unit, skip: preSamples - (pre + 1), count: pre + 1 + post, trigger: pre,
        };
    }

    const available = maxSamples - SKIP_UNTRIGGERED;
    let count = msg.samplecount ?? available;     // no samplecount (one shot / looping): fill the board's memory
    if (!Number.isInteger(count) || count <= 0) throw new Error('bad samplecount');
    let warning;
    if (count > available) {
        warning = `The board captured only ${available} of ${count} samples: ${memory}`;
        count = available;
    }
    return {
        // the external trigger input, inverted: it is low when nothing drives it, so the capture starts at once
        request: { ...request, triggerType: 0, trigger: dev.channelCount, inverted: true, preSamples: SKIP_UNTRIGGERED, postSamples: Math.max(count, 2) },
        unit, skip: SKIP_UNTRIGGERED, count, ...(warning && { warning }),
    };
}

/**
 * Reads the board's answer to a capture request:
 *   "CAPTURE_STARTED\n" (or "CAPTURE_ERROR\n"), when the capture is done: sample count (uint32 LE),
 *   the samples (`unit` bytes each, bit k = the k-th requested channel), timestamp count (1 byte),
 *   the timestamps (uint32 each, only sent when there are more than 1).
 * Of the samples, `count` from sample `skip` on go to onSamples(bytes, offsetInSamples), in whole samples.
 */
export class CaptureReader {
    constructor({ unit, skip, count, onStarted, onLength, onSamples, onEnd, onFailed }) {
        Object.assign(this, { unit, skip, count, onStarted, onLength, onSamples, onEnd, onFailed });
        this.state = 'reply';
        this.pending = Buffer.alloc(0);
        this.left = 0;           // bytes still to come in 'samples' / 'stamps'
        this.pos = 0;            // samples received from the board
        this.sent = 0;           // samples given to onSamples
    }

    push(data) {
        let buf = this.pending.length ? Buffer.concat([this.pending, data]) : Buffer.from(data);
        this.pending = Buffer.alloc(0);
        while (buf.length && this.state !== 'done' && this.state !== 'failed') {
            buf = this[this.state](buf);
            if (buf === null) return;    // needs more data, the rest is in this.pending
        }
    }

    reply(buf) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) { this.pending = buf; return null; }
        const line = buf.subarray(0, nl).toString('latin1').trim();
        const rest = buf.subarray(nl + 1);
        if (line === '') return rest;
        if (line === 'CAPTURE_STARTED') { this.state = 'length'; this.onStarted?.(); return rest; }
        this.state = 'failed';
        this.onFailed(line === 'CAPTURE_ERROR' ? 'the board refused the capture settings' : `unexpected answer from the board: "${line}"`);
        return null;
    }

    length(buf) {
        if (buf.length < 4) { this.pending = buf; return null; }
        const samples = buf.readUInt32LE(0);
        this.left = samples * this.unit;
        this.state = this.left ? 'samples' : 'stampCount';
        this.onLength?.(samples);
        return buf.subarray(4);
    }

    samples(buf) {
        const take = Math.min(buf.length, this.left);
        const whole = take - (take % this.unit);
        if (whole === 0 && take < this.left) { this.pending = buf; return null; }
        const n = whole / this.unit;
        // the part of these n samples (from this.pos on) that is within [skip, skip + count)
        const from = Math.max(this.skip, this.pos), to = Math.min(this.skip + this.count, this.pos + n);
        if (to > from) {
            this.onSamples(buf.subarray((from - this.pos) * this.unit, (to - this.pos) * this.unit), this.sent);
            this.sent += to - from;
        }
        this.pos += n;
        this.left -= whole;
        if (this.left === 0) this.state = 'stampCount';
        return buf.subarray(whole);
    }

    stampCount(buf) {
        const stamps = buf[0];
        this.left = stamps > 1 ? stamps * 4 : 0;
        this.state = this.left ? 'stamps' : 'done';
        if (this.state === 'done') this.onEnd(this.sent);
        return buf.subarray(1);
    }

    stamps(buf) {
        const take = Math.min(buf.length, this.left);   // not used: WebScope does no burst captures
        this.left -= take;
        if (this.left === 0) { this.state = 'done'; this.onEnd(this.sent); }
        return buf.subarray(take);
    }
}

/* ============================== connection ============================== */

/**
 * A connection to a board: "COM5" / "/dev/ttyACM0" (USB serial) or "192.168.1.20:4045" (WiFi).
 * link.onData(data) / link.onClose() are set by the user; send(bytes) -> Promise; close() -> Promise.
 */
async function openLink(conn) {
    const link = { onData: null, onClose: null };
    const tcp = conn.match(/^(.+):(\d+)$/);
    if (tcp) {
        const sock = net.connect({ host: tcp[1], port: Number(tcp[2]) });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no connection to ${conn}`)); }, REPLY_TIMEOUT);
            sock.once('connect', () => { clearTimeout(timer); resolve(); });
            sock.once('error', (err) => { clearTimeout(timer); reject(err); });
        });
        sock.setNoDelay(true);
        sock.on('data', (d) => link.onData?.(d));
        sock.on('error', () => {});                              // 'close' follows
        sock.on('close', () => link.onClose?.());
        link.send = (bytes) => new Promise((resolve, reject) => sock.write(bytes, (e) => (e ? reject(e) : resolve())));
        link.close = () => new Promise((resolve) => { sock.once('close', resolve); sock.end(); setTimeout(() => sock.destroy(), 500); });
        return link;
    }

    const { SerialPort } = await import('serialport');
    const sp = new SerialPort({ path: conn, baudRate: 115200, autoOpen: false });
    await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())));
    // the board only sends while the host has DTR set (tud_cdc_connected)
    await new Promise((resolve) => sp.set({ dtr: true, rts: true }, () => resolve()));
    sp.on('data', (d) => link.onData?.(d));
    sp.on('error', () => {});
    sp.on('close', () => link.onClose?.());
    link.send = (bytes) => new Promise((resolve, reject) => sp.write(Buffer.from(bytes), (e) => (e ? reject(e) : sp.drain(resolve))));
    link.close = () => new Promise((resolve) => (sp.isOpen ? sp.close(() => resolve()) : resolve()));
    return link;
}

/** Send the ID request and read the 5 lines of the answer (anything before them is old data and ignored). */
function identify(link) {
    return new Promise((resolve, reject) => {
        let text = '';
        const lines = [];
        const done = (fn, arg) => { clearTimeout(timer); link.onData = null; fn(arg); };
        const timer = setTimeout(() => done(reject, new Error('no answer to the ID request: is it a LogicAnalyzer board?')), REPLY_TIMEOUT);
        link.onData = (d) => {
            text += d.toString('latin1');
            let nl;
            while ((nl = text.indexOf('\n')) >= 0) {
                const line = text.slice(0, nl).trim();
                text = text.slice(nl + 1);
                if (lines.length === 0 && !line.startsWith('LOGIC_ANALYZER_')) continue;
                lines.push(line);
                if (lines.length === 5) {
                    try { done(resolve, parseIdentity(lines)); } catch (err) { done(reject, err); }
                    return;
                }
            }
        };
        link.send(frame([0])).catch((err) => done(reject, err));
    });
}

/** Send a command and read the one line the board answers with. */
function command(link, payload) {
    return new Promise((resolve, reject) => {
        let text = '';
        const done = (fn, arg) => { clearTimeout(timer); link.onData = null; fn(arg); };
        const timer = setTimeout(() => done(reject, new Error('the board did not answer')), REPLY_TIMEOUT);
        link.onData = (d) => {
            text += d.toString('latin1');
            const nl = text.indexOf('\n');
            if (nl >= 0) done(resolve, text.slice(0, nl).trim());
        };
        link.send(frame(payload)).catch((err) => done(reject, err));
    });
}

/** A WiFi build of the firmware: "WIFI" (Pico W), or another name ending in WIFI, e.g. "P2WIFI" (a Pico 2 W build). */
const hasWifi = (dev) => /WIFI$/.test(dev.board);

/** "192.168.1.20:4045" is a WiFi board, anything else a serial port. */
const isNetwork = (conn) => /^.+:\d+$/.test(conn);

/* ============================== device kind ============================== */

export class LogicAnalyzerKind {
    hardwareTrigger = true;     // index.js gives it the trigger settings instead of running trigger.js

    #queue = Promise.resolve();
    #session = null;

    /** @param open  opens the connection (a fake board in the tests) */
    constructor(conn, dev, open = openLink) {
        this.conn = conn;
        this.dev = dev;         // parseIdentity() of the board
        this.open = open;
    }

    get busy() { return this.#session !== null; }

    /** Runs fn when the board is free: one connection at a time, also while a cancelled capture is being torn down. */
    exclusive(fn) {
        const p = this.#queue.then(fn);
        this.#queue = p.catch(() => {});
        return p;
    }

    /** Connect and identify the board again (scan). */
    probe() {
        return this.exclusive(async () => {
            const link = await this.open(this.conn);
            try { this.dev = await identify(link); }
            finally { await link.close(); }
        });
    }

    /** Save WiFi settings on the board (see deviceSettings.js). */
    async applySettings(values) {
        const v = validateSettings(describe(this).settings, values);     // also refuses a board without WiFi
        // the firmware receives a frame into 128 bytes without checking (messageBuffer[128]), and escaping makes
        // every 0x55 / 0xAA / 0xF0 byte two: e.g. a "U" in the name or password
        if (frame(wifiSettingsRequest(v)).length > 128) {
            throw new Error('the network name and password have too many "U" characters for the board\'s receive buffer (at most 7 together)');
        }
        if (this.#session) throw new Error('the board is capturing: stop the capture first');
        await this.exclusive(async () => {
            const link = await this.open(this.conn);
            try {
                this.dev = await identify(link);
                if (!hasWifi(this.dev)) throw new Error(`the board's firmware has no WiFi (it is a ${this.dev.board} build)`);
                const answer = await command(link, wifiSettingsRequest(v));
                if (answer !== 'SETTINGS_SAVED') {
                    throw new Error(answer === 'ERR_UNSUPPORTED' ? 'the board\'s firmware has no WiFi' : `the board answered "${answer}"`);
                }
            } finally {
                link.onData = null;
                await link.close();
            }
        });
        this.wifi = { ssid: v.ssid, ip: v.ip, port: v.port };   // the board cannot tell them back: shown next time
        return {
            message: `LogicAnalyzer: WiFi settings saved, the board joins "${v.ssid}" as ${v.ip}:${v.port}`,
            info: describe(this),
        };
    }

    start(msg, onData, onDone, onError, onStatus) {
        if (this.#session) { onError('LogicAnalyzer - the board is already capturing'); return null; }
        let plan;
        try { plan = planCapture(msg, this.dev); }
        catch (err) { onError('LogicAnalyzer - ' + err.message); return null; }

        // exactly one of onDone / onError per start; after that the session is over, also when the board is
        // still being cancelled (exclusive() makes the next capture wait for that)
        const s = { stopped: false, finished: false, cancel: null, sent: 0 };
        this.#session = s;
        const finish = (fn) => {
            if (s.finished) return;
            s.finished = true;
            if (this.#session === s) this.#session = null;
            fn();
        };
        s.done = (samples, stopped) => finish(() => onDone({
            deviceId: this.conn,
            samples,
            samplerate: msg.samplerate,
            stopped,
            ok: true,
            ...(!stopped && plan.trigger !== undefined && { trigger: plan.trigger }),
            ...(!stopped && plan.warning && { warning: plan.warning }),
        }));
        this.exclusive(() => this.#run(s, plan, msg, onData, onStatus))
            .then((samples) => s.done(samples, false))
            .catch((err) => finish(() => onError('LogicAnalyzer - ' + err.message, `${this.conn} (${this.dev.board} ${this.dev.version})\n\n${err.stack ?? err.message}`)));

        return { stop: () => this.#stop(s) };
    }

    stop() {
        if (this.#session) this.#stop(this.#session);
    }

    #stop(s) {
        if (s.finished || s.stopped) return;
        s.stopped = true;
        s.cancel?.();
        s.done(s.sent, true);
    }

    /** One capture: connect, identify, request, read. Resolves with the number of samples sent. */
    async #run(s, plan, msg, onData, onStatus) {
        if (s.stopped) return 0;
        const link = await this.open(this.conn);
        let cancelSent = false;
        try {
            this.dev = await identify(link);   // also checks that it still is the same kind of board
            if (s.stopped) return 0;
            // the board sends the requested channels as bits 0, 1, ..: bit k = msg.channels[k]
            const repack = makeChannelPacker(plan.unit, msg.channels, (ch) => msg.channels.indexOf(ch));
            return await new Promise((resolve, reject) => {
                let timer = setTimeout(() => reject(new Error('the board did not answer the capture request')), REPLY_TIMEOUT);
                const reader = new CaptureReader({
                    ...plan,
                    onStarted: () => {
                        clearTimeout(timer);
                        onStatus?.({ state: 'armed' });
                        if (plan.trigger === undefined) {
                            const ms = (plan.request.preSamples + plan.request.postSamples) / plan.request.frequency * 1000 + START_TIMEOUT;
                            timer = setTimeout(() => {
                                sendCancel();
                                reject(new Error('the capture did not start. Without a trigger it starts when the board\'s external trigger input (GPIO1 on a Pico) is low: is something driving it high?'));
                            }, ms);
                        }
                    },
                    onLength: () => { clearTimeout(timer); onStatus?.({ state: 'triggered', sample: plan.trigger ?? 0 }); },
                    onSamples: (bytes, offset) => {
                        if (s.stopped) return;
                        onData(repack.run(bytes), offset);
                        s.sent = offset + bytes.length / plan.unit;
                    },
                    onEnd: resolve,
                    onFailed: (m) => { clearTimeout(timer); reject(new Error(m)); },
                });
                // any byte cancels a running capture (the board looks for it every 2 s and then sends nothing)
                const sendCancel = () => {
                    clearTimeout(timer);
                    cancelSent = true;
                    link.send([0xff]).catch(() => {});
                };
                s.cancel = () => { sendCancel(); resolve(reader.sent); };
                link.onData = (d) => reader.push(d);
                link.onClose = () => { clearTimeout(timer); reject(new Error('the connection to the board was lost')); };
                link.send(frame(captureRequest(plan.request))).catch(reject);
            });
        } finally {
            s.cancel = null;
            link.onData = null;
            link.onClose = null;
            // a cancelled board needs its time: the next connection must not reach it while it still captures
            if (cancelSent) await new Promise((r) => setTimeout(r, CANCEL_WAIT));
            await link.close();
        }
    }
}

/* ============================== scan ============================== */

const kinds = new Map();   // connection -> LogicAnalyzerKind: kept between scans, a capturing board is not probed

async function usbPorts() {
    let SerialPort;
    try {
        ({ SerialPort } = await import('serialport'));
    } catch {
        console.warn('LogicAnalyzer: the serialport package is not installed (npm install), USB boards are not scanned');
        return [];
    }
    const ports = await SerialPort.list();
    return ports
        .filter((p) => USB_IDS.some((id) =>
            p.vendorId?.toLowerCase() === id.vendorId && p.productId?.toLowerCase() === id.productId))
        .map((p) => p.path);
}

function hostsFromEnv() {
    return (process.env.LOGICANALYZER_HOSTS ?? '').split(',').map((h) => h.trim()).filter((h) => /^.+:\d+$/.test(h));
}

const IPV4 = '((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const ASCII = '[\\x20-\\x7E]*';

/** The WiFi settings form: open for a WiFi board on USB, grayed out (with the reason) for every other board. */
function wifiSettings(kind) {
    const { dev, conn } = kind;
    const disabled =
        !hasWifi(dev) ? `This board (${dev.board}) has no WiFi. WiFi needs a Pico W or Pico 2 W with a WiFi build of the LogicAnalyzer firmware.` :
        isNetwork(conn) ? 'Connect the board with USB to change its WiFi settings.' :
        undefined;
    return {
        title: 'LogicAnalyzer WiFi settings',
        note: 'Saved in the board\'s flash. The board then joins the network (WPA2) with this IP address, and '
            + 'WebScope finds it when its address is in LOGICANALYZER_HOSTS / logicAnalyzerHosts. '
            + 'The board cannot tell its current settings, so the fields show what was last saved from here.',
        ...(disabled && { disabled }),
        fields: [
            { key: 'ssid', label: 'Network name', type: 'text', minLength: 1, maxLength: 32, pattern: ASCII, patternHint: 'only plain ASCII characters' },
            { key: 'password', label: 'Password', type: 'password', minLength: 8, maxLength: 63, pattern: ASCII, patternHint: 'only plain ASCII characters', help: 'WPA2: 8 to 63 characters' },
            { key: 'ip', label: 'IP address', type: 'text', pattern: IPV4, patternHint: 'an IPv4 address, e.g. 192.168.1.20', help: 'a free address in the network: the board does not use DHCP' },
            { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, integer: true },
        ],
        values: { ssid: '', password: '', ip: '', port: 4045, ...kind.wifi },
    };
}

/** Device info for the browser. */
function describe(kind) {
    const { dev, conn } = kind;
    const rates = samplerates(dev);
    const info = {
        id: 'logicanalyzer:' + conn,
        name: `LogicAnalyzer ${dev.board} ${dev.version} (${conn})`,
        channels: Array.from({ length: dev.channelCount }, (_, i) => ({ index: i, name: `CH${i + 1}`, type: 'logic' })),
        samplerates: rates,
        defaultSamplerate: rates.includes(1_000_000) ? 1_000_000 : rates.at(-1),
        driver: 'logicanalyzer',
        note: `${Math.round(dev.bufferSize / 1024)} KB memory: ${dev.bufferSize} samples with CH1-8, ${dev.bufferSize / 2} up to CH16, ${dev.bufferSize / 4} above. Triggers: L2H / H2L only`,
        // what the frontend can offer, see frontend/js/capture/captureLimits.js (the same rules as planCapture())
        limits: {
            stream: false,
            memory: [
                { below: 8, samples: dev.bufferSize },
                { below: 16, samples: Math.floor(dev.bufferSize / 2) },
                { below: dev.channelCount, samples: Math.floor(dev.bufferSize / 4) },
            ],
            preTriggerShare: 0.1,
            hardwareTrigger: { types: ['L2H', 'H2L'], conditions: false },
        },
        details: [
            { label: 'Board', value: dev.board },
            { label: 'Firmware', value: dev.version },
            { label: 'Connection', value: isNetwork(conn) ? `WiFi, ${conn}` : `USB, ${conn}` },
            { label: 'Memory', value: `${dev.bufferSize.toLocaleString('en')} samples` },
        ],
        settings: wifiSettings(kind),
    };
    // non-enumerable so JSON.stringify(info) sends it to the browser without the kind object
    Object.defineProperty(info, 'deviceKind', { value: kind, enumerable: false });
    return info;
}

export async function scanLogicAnalyzers() {
    const devices = [];
    try {
        for (const conn of [...await usbPorts(), ...hostsFromEnv()]) {
            let kind = kinds.get(conn);
            try {
                if (!kind) {
                    kind = new LogicAnalyzerKind(conn, null);
                    await kind.probe();
                    kinds.set(conn, kind);
                } else if (!kind.busy) {
                    await kind.probe();
                }
                devices.push(describe(kind));
            } catch (err) {
                // e.g. the port is in use by another program, or the board has other firmware
                console.warn(`LogicAnalyzer: no board on ${conn}:`, err.message);
            }
        }
    } catch (err) {
        console.warn('LogicAnalyzer scan failed:', err);
    }
    return devices;
}
