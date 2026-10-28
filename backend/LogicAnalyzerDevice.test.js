// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { frame, captureRequest, parseIdentity, planCapture, samplerates, CaptureReader, LogicAnalyzerKind } from './LogicAnalyzerDevice.js';

const PICO = { board: 'PICO', version: 'V6_0', maxFrequency: 100_000_000, blastFrequency: 200_000_000, bufferSize: 131072, channelCount: 24 };
const ID_LINES = ['LOGIC_ANALYZER_PICO_V6_0', 'FREQ:100000000', 'BLASTFREQ:200000000', 'BUFFER:131072', 'CHANNELS:24'];

/** What the firmware does with a received frame: strip start / stop, undo the escaping. */
function unframe(bytes) {
    assert.deepEqual([bytes[0], bytes[1]], [0x55, 0xAA]);
    assert.deepEqual([bytes.at(-2), bytes.at(-1)], [0xAA, 0x55]);
    const out = [];
    for (let i = 2; i < bytes.length - 2; i++) out.push(bytes[i] === 0xF0 ? bytes[++i] ^ 0xF0 : bytes[i]);
    return Uint8Array.from(out);
}

/** The firmware's CAPTURE_REQUEST, read the way the C struct lays it out. */
function readRequest(p) {
    const v = new DataView(p.buffer, p.byteOffset);
    return {
        command: p[0], triggerType: p[1], trigger: p[2], inverted: p[3], triggerValue: v.getUint16(5, true),
        channels: Array.from(p.subarray(7, 7 + p[31])), frequency: v.getUint32(33, true),
        preSamples: v.getUint32(37, true), postSamples: v.getUint32(41, true), loopCount: p[45], measure: p[46], captureMode: p[47],
    };
}

/** Sample i of the board: bit k = the k-th requested channel = bit k of i (a binary counter). */
const boardSample = (i, unit) => Array.from({ length: unit }, (_, b) => (i >> (8 * b)) & 0xff);

/**
 * A fake board behind the link interface of LogicAnalyzerDevice.js: answers the ID request and captures
 * (pre + post counter samples, sent in random pieces). hang: the capture never finishes (until cancelled).
 */
function fakeBoard({ hang = false } = {}) {
    const board = { requests: [], cancelled: false, opens: 0, open: null };
    board.open = async () => {
        board.opens++;
        let rx = [];
        let capturing = false;
        const link = { onData: null, onClose: null };
        const reply = (bytes) => setImmediate(() => link.onData?.(Buffer.from(bytes)));
        const replyLines = (lines) => reply(Buffer.from(lines.map((l) => l + '\r\n').join(''), 'latin1'));
        link.send = async (bytes) => {
            for (const b of bytes) {
                if (capturing) { board.cancelled = true; capturing = false; continue; }   // any byte cancels
                rx.push(b);
                if (rx.length >= 4 && rx.at(-2) === 0xAA && rx.at(-1) === 0x55) {
                    const p = unframe(Uint8Array.from(rx));
                    rx = [];
                    if (p[0] === 0) { replyLines(['garbage from before', ...ID_LINES]); continue; }
                    const r = readRequest(p);
                    board.requests.push(r);
                    replyLines(['CAPTURE_STARTED']);
                    capturing = true;
                    if (hang) continue;
                    const unit = [1, 2, 4][r.captureMode], total = r.preSamples + r.postSamples;
                    const data = [];
                    const len = Buffer.alloc(4); len.writeUInt32LE(total);
                    data.push(...len);
                    for (let i = 0; i < total; i++) data.push(...boardSample(i, unit));
                    data.push(0);    // no timestamps
                    setTimeout(() => {
                        if (!capturing) return;
                        capturing = false;
                        for (let pos = 0; pos < data.length;) {
                            const n = 1 + ((Math.random() * 700) | 0);
                            reply(data.slice(pos, pos + n));
                            pos += n;
                        }
                    }, 5);
                }
            }
        };
        link.close = async () => {};
        return link;
    };
    return board;
}

/** Run one capture on a fake board: resolves with { data, done, status }, or rejects on onError. */
function capture(kind, msg) {
    return new Promise((resolve, reject) => {
        const chunks = [], status = [];
        kind.start(msg,
            (chunk, offset) => chunks.push({ chunk: Uint8Array.from(chunk), offset }),
            (done) => resolve({ data: Buffer.concat(chunks.map((c) => c.chunk)), chunks, done, status }),
            (m) => reject(new Error(m)),
            (s) => status.push(s.state));
    });
}

/* ---------- protocol pieces ---------- */
test('frames escape 0x55 / 0xAA / 0xF0 like the firmware expects', () => {
    assert.deepEqual(Array.from(frame([0])), [0x55, 0xAA, 0x00, 0xAA, 0x55]);
    const payload = [1, 0x55, 0xAA, 0xF0, 7];
    const f = frame(payload);
    assert.deepEqual(Array.from(f), [0x55, 0xAA, 1, 0xF0, 0xA5, 0xF0, 0x5A, 0xF0, 0x00, 7, 0xAA, 0x55]);
    assert.deepEqual(Array.from(unframe(f)), payload);
});

test('capture request has the layout of the firmware struct', () => {
    const p = captureRequest({ triggerType: 0, trigger: 3, inverted: true, channels: [0, 2, 9], frequency: 0x01020304, preSamples: 0x55AA, postSamples: 1000, captureMode: 1 });
    assert.equal(p.length, 1 + 48);
    assert.deepEqual(readRequest(p), { command: 1, triggerType: 0, trigger: 3, inverted: 1, triggerValue: 0, channels: [0, 2, 9], frequency: 0x01020304, preSamples: 0x55AA, postSamples: 1000, loopCount: 0, measure: 0, captureMode: 1 });
});

test('identity lines', () => {
    assert.deepEqual(parseIdentity(ID_LINES), PICO);
    assert.equal(parseIdentity(['LOGIC_ANALYZER_PICO_2_V6_5', ...ID_LINES.slice(1)]).board, 'PICO_2');
    assert.throws(() => parseIdentity(['LOGIC_ANALYZER_PICO_V5_1', ...ID_LINES.slice(1)]), /too old/);
    assert.throws(() => parseIdentity(['hello']), /not a LogicAnalyzer/);
    assert.throws(() => parseIdentity([ID_LINES[0], 'FREQ:x']), /FREQ/);
});

test('samplerates are 1-2-5 steps the board can do', () => {
    assert.deepEqual(samplerates(PICO), [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6, 100e6]);
    assert.equal(samplerates({ ...PICO, maxFrequency: 200_000_000 }).at(-1), 200_000_000);
});

test('capture plans: sample width, trigger position, limits', () => {
    const t = planCapture({ channels: [0, 1, 2], samplerate: 1e6, triggerOn: { channel: 5, type: 'H2L' }, preTrigger: 10, postTrigger: 100 }, PICO);
    assert.equal(t.unit, 1);
    assert.deepEqual({ ...t.request, channels: undefined }, { channels: undefined, frequency: 1e6, captureMode: 0, triggerType: 0, trigger: 5, inverted: true, preSamples: 11, postSamples: 100 });
    assert.deepEqual([t.skip, t.count, t.trigger], [0, 111, 10]);

    const z = planCapture({ channels: [3, 17], samplerate: 1e6, triggerOn: { channel: 3, type: 'L2H' }, preTrigger: 0, postTrigger: 0 }, PICO);
    assert.equal(z.unit, 4);
    assert.deepEqual([z.request.preSamples, z.request.postSamples, z.skip, z.count, z.trigger, z.request.inverted], [2, 2, 1, 1, 0, false]);

    const free = planCapture({ channels: [0, 8], samplerate: 1e6, samplecount: 5000 }, PICO);
    assert.deepEqual([free.unit, free.request.trigger, free.request.inverted, free.skip, free.count], [2, 24, true, 2, 5000]);
    const full = planCapture({ channels: [0], samplerate: 1e6 }, PICO);
    assert.equal(full.count, 131070);
    const big = planCapture({ channels: [0], samplerate: 1e6, samplecount: 1e6 }, PICO);
    assert.equal(big.count, 131070);
    assert.match(big.warning, /only 131070 of 1000000/);

    const m = (o) => ({ channels: [0], samplerate: 1e6, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 10, postTrigger: 10, ...o });
    assert.throws(() => planCapture(m({ triggerOn: { channel: 0, type: 'PulseH', pulseLength: 3 } }), PICO), /L2H/);
    assert.throws(() => planCapture(m({ triggerOn: { channel: 0, type: 'L2H', conditions: { 1: 'hi' } } }), PICO), /other channels/);
    assert.throws(() => planCapture(m({ preTrigger: 20000 }), PICO), /before the trigger/);
    assert.throws(() => planCapture(m({ postTrigger: 131072 }), PICO), /too long/);
    assert.throws(() => planCapture(m({ samplerate: 1000 }), PICO), /samplerate/);
    assert.throws(() => planCapture(m({ samplerate: 200e6 }), PICO), /samplerate/);
});

test('the reader keeps only [skip, skip + count) whatever the chunking', () => {
    for (let iter = 0; iter < 200; iter++) {
        const unit = [1, 2, 4][iter % 3], total = 50 + iter, skip = iter % 5, count = total - skip - (iter % 7);
        const bytes = [...Buffer.from('\r\nCAPTURE_STARTED\r\n', 'latin1')];
        const len = Buffer.alloc(4); len.writeUInt32LE(total); bytes.push(...len);
        for (let i = 0; i < total; i++) bytes.push(...boardSample(i, unit));
        bytes.push(2, 1, 2, 3, 4, 5, 6, 7, 8);   // 2 timestamps
        const got = [];
        let ended = null, started = 0, length = null;
        const r = new CaptureReader({ unit, skip, count, onStarted: () => started++, onLength: (n) => (length = n), onSamples: (b, off) => { assert.equal(off * unit, got.length); got.push(...b); }, onEnd: (n) => (ended = n), onFailed: assert.fail });
        for (let pos = 0; pos < bytes.length;) {
            const n = 1 + ((Math.random() * 40) | 0);
            r.push(Buffer.from(bytes.slice(pos, pos + n)));
            pos += n;
        }
        const want = [];
        for (let i = skip; i < skip + count; i++) want.push(...boardSample(i, unit));
        assert.deepEqual(got, want, `iter ${iter}`);
        assert.deepEqual([started, length, ended, r.state], [1, total, count, 'done']);
    }
});

test('the reader reports a refused capture', () => {
    let failed = null;
    const r = new CaptureReader({ unit: 1, skip: 0, count: 1, onSamples: assert.fail, onEnd: assert.fail, onFailed: (m) => (failed = m) });
    r.push(Buffer.from('CAPTURE_ERROR\n'));
    assert.match(failed, /refused/);
});

/* ---------- whole captures against a fake board ---------- */
test('triggered capture: the trigger sample is at preTrigger, channels repacked', async () => {
    const board = fakeBoard();
    const kind = new LogicAnalyzerKind('COM99', PICO, board.open);
    // channels 0 and 9: the board sends 2 bytes per sample (bits 0, 1), WebScope gets bit 0 and bit 9
    const { data, done, status } = await capture(kind, { channels: [0, 9], samplerate: 1e6, triggerOn: { channel: 9, type: 'L2H' }, preTrigger: 100, postTrigger: 300 });
    const r = board.requests[0];
    assert.deepEqual([r.channels, r.captureMode, r.preSamples, r.postSamples, r.trigger, r.inverted], [[0, 9], 1, 101, 300, 9, 0]);
    // the board's trigger sample is its sample preSamples - 1 = 100
    assert.equal(data.length, 401 * 2);
    for (let m = 0; m < 401; m++) assert.deepEqual([data[2 * m], data[2 * m + 1]], [m & 1, (m >> 1) & 1 ? 0x02 : 0], `sample ${m}`);
    assert.deepEqual([done.samples, done.trigger, done.stopped, done.ok], [401, 100, false, true]);
    assert.deepEqual(status, ['armed', 'triggered']);
    assert.equal(kind.busy, false);
});

test('capture without trigger: samplecount samples, ext trigger input', async () => {
    const board = fakeBoard();
    const kind = new LogicAnalyzerKind('COM99', PICO, board.open);
    const { data, done } = await capture(kind, { channels: [0, 1, 2, 3, 4, 5, 6, 7, 16], samplerate: 2e6, samplecount: 1000 });
    const r = board.requests[0];
    assert.deepEqual([r.trigger, r.inverted, r.captureMode, r.preSamples, r.postSamples], [24, 1, 2, 2, 1000]);
    // channels 0-7 and 16: 4 bytes per sample, the board's bit 8 is channel 16
    assert.equal(data.length, 1000 * 4);
    for (let m = 0; m < 1000; m++) {
        const i = m + 2;
        assert.deepEqual([...data.subarray(4 * m, 4 * m + 4)], [i & 0xff, 0, (i >> 8) & 1, 0], `sample ${m}`);
    }
    assert.equal(done.samples, 1000);
    assert.equal(done.trigger, undefined);
});

test('bad settings are refused before anything is sent', async () => {
    const board = fakeBoard();
    const kind = new LogicAnalyzerKind('COM99', PICO, board.open);
    await assert.rejects(capture(kind, { channels: [0], samplerate: 1e6, triggerOn: { channel: 0, type: 'PulseL', pulseLength: 2 } }), /L2H/);
    assert.equal(board.opens, 0);
});

test('stop: done at once, the board gets the cancel byte, the next capture waits for it', async () => {
    const board = fakeBoard({ hang: true });
    const kind = new LogicAnalyzerKind('COM99', PICO, board.open);
    const p = capture(kind, { channels: [0], samplerate: 1e6, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 10, postTrigger: 10 });
    await new Promise((r) => setTimeout(r, 50));
    kind.stop();
    const { done, status } = await p;
    assert.deepEqual([done.stopped, done.samples, done.trigger], [true, 0, undefined]);
    assert.deepEqual(status, ['armed']);
    assert.equal(board.cancelled, true);
    assert.equal(kind.busy, false);

    // the board answers normally again, the second capture only opens it after the cancel wait
    const t0 = performance.now();
    const second = fakeBoard();
    kind.open = second.open;
    const { done: d2 } = await capture(kind, { channels: [0], samplerate: 1e6, samplecount: 50 });
    assert.equal(d2.samples, 50);
    assert.ok(performance.now() - t0 > 1500, 'the second capture did not wait for the cancelled one');
});

test('a second start while capturing is refused', async () => {
    const board = fakeBoard({ hang: true });
    const kind = new LogicAnalyzerKind('COM99', PICO, board.open);
    const p = capture(kind, { channels: [0], samplerate: 1e6, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 10, postTrigger: 10 });
    await assert.rejects(capture(kind, { channels: [0], samplerate: 1e6, samplecount: 10 }), /already capturing/);
    kind.stop();
    await p;
});
