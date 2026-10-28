// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentity, pinNames, bufferSamples, samplerates, planCapture, SampleDecoder, PicoCoderSigrokPicoKind } from './PicoCoderSigrokPicoDevice.js';

const DEV = { analogCount: 3, channelCount: 21, version: '02' };
const HALF = 4096;   // samples per buffer half of the fake board (a multiple of 8, like the firmware's)

/* ---- the firmware's encoders (pico_sdk_sigrok.c), one buffer half at a time ---- */

/** send_slices_1B/2B/4B: 7 bits per byte, check_rle() between changes. */
function encodeGeneral(samples, bytes) {
    const out = [];
    const tx = (v) => { for (let b = 0; b < bytes; b++) { out.push((v | 0x80) & 0xff); v >>>= 7; } };
    let rle = 0;
    const checkRle = () => {
        while (rle >= 1568) { out.push(127); rle -= 1568; }
        if (rle > 32) { const d = rle >> 5; out.push(d + 78); rle -= d << 5; }
        if (rle) { out.push(47 + rle); rle = 0; }
    };
    tx(samples[0]);
    let last = samples[0];
    for (let i = 1; i < samples.length; i++) {
        if (samples[i] === last) rle++;
        else { checkRle(); tx(samples[i]); }
        last = samples[i];
    }
    checkRle();
    return out;
}

/** A signal with short and long runs (beyond the 640 / 1568 run codes), on `pins` pins. */
function signal(n, pins, seed = 1) {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const lengths = [1, 1, 2, 3, 7, 8, 9, 31, 32, 33, 100, 639, 641, 700, 1567, 1569, 2000, 5000];
    const mask = pins === 32 ? 0xffffffff : 2 ** pins - 1;
    const out = new Uint32Array(n);
    for (let i = 0; i < n;) {
        const len = lengths[(rnd() * lengths.length) | 0], v = ((rnd() * 2 ** 32) >>> 0) & mask;
        for (let k = 0; k < len && i < n; k++) out[i++] = v;
    }
    return out;
}

/** Only `channels` of each sample, at their own bit: what the browser should get. */
const expected = (samples, channels) => Array.from(samples, (v) => (v & channels.reduce((m, ch) => m | (1 << ch), 0)) >>> 0);

/** The browser format back to numbers. */
function unpack(chunks, channels) {
    const unit = Math.ceil((channels.at(-1) + 1) / 8), all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const out = [];
    for (let i = 0; i < all.length; i += unit) { let v = 0; for (let j = 0; j < unit; j++) v |= all[i + j] << (8 * j); out.push(v >>> 0); }
    return out;
}

/**
 * A sigrok-pico board as the firmware behaves: commands, F / C captures sent in buffer halves (each half
 * encoded on its own), '+' stops, the end mark. `overflowAfter`: halves before it aborts with "!!!" "$0+".
 */
function fakeBoard({ overflowAfter = Infinity } = {}) {
    const board = { commands: [], opens: 0, open: null, sample: null };
    board.open = async () => {
        board.opens++;
        const st = { rate: 5000, limit: 10, mask: 0, line: '', capturing: null };
        const link = { onData: null, onClose: null };
        const reply = (bytes) => setImmediate(() => link.onData?.(Buffer.from(bytes)));
        const sendChunked = (bytes) => { for (let p = 0; p < bytes.length;) { const n = 1 + ((Math.random() * 300) | 0); reply(bytes.slice(p, p + n)); p += n; } };
        const capture = (cont) => {
            let highest = 31; while (highest > 0 && !((st.mask >>> highest) & 1)) highest--;
            const pins = highest < 4 ? 4 : highest < 8 ? 8 : highest < 16 ? 16 : 32;   // the PIO samples whole groups
            if (pins === 4) throw new Error('the driver must not use the 4-bit mode');
            const bytes = Math.ceil((highest + 1) / 7);
            const total = cont ? Infinity : Math.max(16, Math.ceil(st.limit / 4) * 4);
            const c = { sent: 0, bytes: 0, halves: 0, stop: false };
            st.capturing = c;
            const sample = board.sample = board.sample ?? signal(200_000, pins);
            const end = (mark) => { clearInterval(c.timer); st.capturing = null; reply(Buffer.from(mark, 'latin1')); };
            c.timer = setInterval(() => {
                if (c.stop) { end(`$${c.bytes}+`); return; }
                if (c.halves === overflowAfter) { reply(Buffer.from('!!!', 'latin1')); end('$0+'); return; }
                const n = Math.min(HALF, total - c.sent);
                const half = Array.from(sample.subarray(c.sent % 100_000, c.sent % 100_000 + n), (v) => (v & (pins === 32 ? 0xffffffff : 2 ** pins - 1)) >>> 0);
                const enc = encodeGeneral(half, bytes);
                c.sent += n; c.bytes += enc.length; c.halves++;
                sendChunked(enc);
                if (c.sent >= total) end(`$${c.bytes}+`);
            }, 1);
        };
        link.send = async (text) => {
            for (const ch of text) {
                if (ch === '+') { if (st.capturing) st.capturing.stop = true; continue; }
                if (ch === '*') { st.line = ''; continue; }
                if (ch !== '\n') { st.line += ch; continue; }
                const cmd = st.line; st.line = '';
                board.commands.push(cmd);
                if (cmd === 'i') reply(Buffer.from('SRPICO,A031D21,02', 'latin1'));
                else if (cmd[0] === 'R') { st.rate = Number(cmd.slice(1)); reply([0x2a]); }
                else if (cmd[0] === 'L') { st.limit = Number(cmd.slice(1)); reply([0x2a]); }
                else if (cmd[0] === 'D') { const ch = Number(cmd.slice(2)); st.mask = (st.mask & ~(1 << ch)) | (Number(cmd[1]) << ch); reply([0x2a]); }
                else if (cmd[0] === 'A') reply([0x2a]);
                else if (cmd === 'F' || cmd === 'C') capture(cmd === 'C');
            }
        };
        link.close = async () => { if (st.capturing) clearInterval(st.capturing.timer); };
        return link;
    };
    return board;
}

/** Runs one capture on a fake board: { chunks, done, error }. */
function run(kind, msg, { stopAfter } = {}) {
    return new Promise((resolve) => {
        const chunks = [];
        let handle;
        handle = kind.start(msg,
            (chunk) => { chunks.push(chunk); if (stopAfter && chunks.length === stopAfter) handle.stop(); },
            (done) => resolve({ chunks, done }),
            (error) => resolve({ chunks, error }));
    });
}

/* ---- tests ---- */

test('identity, pin names and samplerates', () => {
    assert.deepEqual(parseIdentity('junk*SRPICO,A031D21,02'), DEV);
    assert.deepEqual(parseIdentity('SRPICO,A001D32,02'), { analogCount: 0, channelCount: 32, version: '02' });
    assert.equal(parseIdentity('LOGIC_ANALYZER_PICO_V6_0'), null);
    assert.deepEqual(pinNames(21).slice(0, 2), ['GP2', 'GP3']);
    assert.deepEqual(pinNames(26).slice(22), ['GP22', 'GP26', 'GP27', 'GP28']);
    assert.equal(pinNames(32)[31], 'GP31');
    const rates = samplerates();
    assert.equal(rates[0], 5000);
    assert.equal(rates.at(-1), 120_000_000);
    assert.ok(rates.every((r) => r % 2 === 0));
});

test('buffer sizes are the firmware calculation (220000 bytes, RP2040)', () => {
    assert.equal(bufferSamples(7), 219_644);
    assert.equal(bufferSamples(15), 109_052);
    assert.equal(bufferSamples(31), 53_244);
});

test('plans enable D0..highest and pick the encoding', () => {
    const p = planCapture({ samplerate: 1_000_001, channels: [2, 9], samplecount: 10 }, DEV);
    assert.equal(p.commands[0], 'R1000000');
    assert.deepEqual(p.commands.filter((c) => c.startsWith('D1')).length, 10);           // D0..D9
    assert.ok(p.commands.includes('D010') && p.commands.includes('D020') && p.commands.includes('A002'));
    assert.equal(p.commands.at(-1), 'L16');
    assert.equal(p.start, 'F');
    assert.equal(p.bytes, 2);
    // never the board's 4-bit mode: D0-D4 at least
    const low = planCapture({ samplerate: 5000, channels: [2] }, DEV);
    assert.deepEqual(low.commands.filter((c) => c.startsWith('D1')), ['D100', 'D101', 'D102', 'D103', 'D104']);
    assert.equal(low.bytes, 1);
    assert.equal(planCapture({ samplerate: 5000, channels: [0] }, DEV).start, 'C');
    assert.throws(() => planCapture({ samplerate: 4000, channels: [0] }, DEV), /samplerate/);
});

test('the decoder undoes the firmware encoding, at any chunking', () => {
    for (const [pins, highest] of [[8, 4], [8, 7], [16, 13], [32, 20], [32, 31]]) {
        const samples = Array.from(signal(30_000, pins, pins + highest), (v) => (v & (highest === 31 ? 0xffffffff : 2 ** (highest + 1) - 1)) >>> 0);
        const bytes = Math.ceil((highest + 1) / 7);
        const enc = [];
        for (let i = 0; i < samples.length; i += HALF) enc.push(...encodeGeneral(samples.slice(i, i + HALF), bytes));
        const got = [];
        let end = null;
        const dec = new SampleDecoder({ bytes, onSamples: (v) => got.push(...v), onEnd: (e) => { end = e; } });
        const stream = [...enc, ...Buffer.from(`$${enc.length}+`)];
        for (let p = 0; p < stream.length;) { const n = 1 + ((Math.random() * 50) | 0); dec.push(Buffer.from(stream.slice(p, p + n))); p += n; }
        assert.deepEqual(got, samples, `pins ${pins}, highest D${highest}`);
        assert.deepEqual(end, { aborted: false, byteCount: enc.length, received: enc.length });
    }
});

test('fixed capture: exactly samplecount samples, only the requested channels', async () => {
    const board = fakeBoard();
    const kind = new PicoCoderSigrokPicoKind('COM9', DEV, board.open);
    const channels = [0, 2, 5];
    const { chunks, done, error } = await run(kind, { samplerate: 1_000_000, channels, samplecount: 10_001 });
    assert.equal(error, undefined);
    assert.equal(done.samples, 10_001);
    assert.equal(done.warning, undefined);
    assert.ok(board.commands.includes('L10004') && board.commands.includes('F'));
    const want = expected(Array.from(board.sample.subarray(0, 10_001), (v) => v & 0xff), channels);
    assert.deepEqual(unpack(chunks, channels), want);
});

test('continuous capture runs until stopped and keeps the samples in order', async () => {
    const board = fakeBoard();
    const kind = new PicoCoderSigrokPicoKind('COM9', DEV, board.open);
    const channels = [1, 3];
    const { chunks, done } = await run(kind, { samplerate: 1_000_000, channels }, { stopAfter: 5 });
    assert.equal(done.stopped, true);
    assert.ok(board.commands.includes('C'));
    const got = unpack(chunks, channels);
    assert.ok(got.length > 0);
    assert.deepEqual(got, expected(Array.from(board.sample.subarray(0, got.length), (v) => v & 0xff), channels));
    // the next capture waits until the stopped one is torn down, then works
    const again = await run(kind, { samplerate: 1_000_000, channels, samplecount: 100 });
    assert.equal(again.done.samples, 100);
});

test('an overflow ends the capture with a warning and keeps what arrived', async () => {
    const board = fakeBoard({ overflowAfter: 3 });
    const kind = new PicoCoderSigrokPicoKind('COM9', DEV, board.open);
    const { done } = await run(kind, { samplerate: 100_000_000, channels: [0, 1, 2, 3, 4, 5, 6, 7] });
    assert.equal(done.samples, 3 * HALF);
    assert.match(done.warning, /could not send the samples fast enough/);
});

test('a second start while capturing is refused', async () => {
    const kind = new PicoCoderSigrokPicoKind('COM9', DEV, fakeBoard().open);
    const first = kind.start({ samplerate: 1_000_000, channels: [0] }, () => {}, () => {}, () => {});
    let error;
    kind.start({ samplerate: 1_000_000, channels: [0] }, () => {}, () => {}, (m) => { error = m; });
    assert.match(error, /already capturing/);
    first.stop();
});
