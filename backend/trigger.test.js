// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerCapture, startTriggered, parseTriggerConfig } from './trigger.js';

/* ---------- helpers ---------- */
const bit = (stream, unit, ch, i) => (stream[i * unit + (ch >> 3)] >> (ch & 7)) & 1;

function randomStream(n, unit, activity) {
    const s = new Uint8Array(n * unit);
    let cur = new Uint8Array(unit).map(() => (Math.random() * 256) | 0);
    for (let i = 0; i < n; i++) {
        if (Math.random() < activity) cur[(Math.random() * unit) | 0] ^= 1 << ((Math.random() * 8) | 0);
        s.set(cur, i * unit);
    }
    return s;
}

/** Brute-force reference: first sample g >= pre where the trigger condition holds. */
function referenceTrigger(stream, unit, ch, type, len, pre) {
    const n = stream.length / unit;
    for (let g = Math.max(pre, 1); g < n; g++) {
        const cur = bit(stream, unit, ch, g), prev = bit(stream, unit, ch, g - 1);
        if (type === 'L2H' && prev === 0 && cur === 1) return g;
        if (type === 'H2L' && prev === 1 && cur === 0) return g;
        if (type === 'PulseH' || type === 'PulseL') {
            const lvl = type === 'PulseH' ? 1 : 0;
            if (cur !== lvl) continue;
            const s = g - len + 1;                       // first sample of the pulse
            if (s < 1) continue;                         // a pulse needs an observed starting edge
            let ok = bit(stream, unit, ch, s - 1) !== lvl;
            for (let k = s; ok && k <= g; k++) if (bit(stream, unit, ch, k) !== lvl) ok = false;
            if (ok) return g;
        }
    }
    return -1;
}

function feed(cap, stream, unit, rnd) {
    let pos = 0;
    while (pos < stream.length) {
        const bytes = rnd(unit) ;
        const chunk = stream.subarray(pos, Math.min(stream.length, pos + bytes));
        pos += chunk.length;
        if (cap.push(Uint8Array.from(chunk))) return true;   // copy, like a reused socket buffer
    }
    return cap.state === 'done';
}

/* ---------- engine + ring buffer vs. reference ---------- */
test('random streams, random chunking, all trigger types and sample widths', () => {
    let checked = 0;
    for (let iter = 0; iter < 1500; iter++) {
        const unit = 1 + (iter % 4);
        const ch = (Math.random() * unit * 8) | 0;
        const type = ['L2H', 'H2L', 'PulseH', 'PulseL'][(Math.random() * 4) | 0];
        const len = 1 + ((Math.random() * 6) | 0);
        const pre = (Math.random() * 40) | 0, post = (Math.random() * 40) | 0;
        const stream = randomStream(400, unit, 0.06);
        const g = referenceTrigger(stream, unit, ch, type, len, pre);

        const cap = new TriggerCapture({ unitSize: unit, channel: ch, type, pulseLength: len, preTrigger: pre, postTrigger: post });
        const mode = iter % 3;   // 1 byte at a time / sample-multiple chunks / arbitrary byte counts
        const done = feed(cap, stream, unit, mode === 0 ? () => 1 : mode === 1 ? (u) => u * (1 + ((Math.random() * 30) | 0)) : () => 1 + ((Math.random() * 90) | 0));

        const enough = g >= 0 && g + post < stream.length / unit;
        if (!enough) { assert.equal(done, false, `iter ${iter}: should not be complete`); continue; }
        assert.equal(done, true, `iter ${iter} ${type} len=${len} pre=${pre} post=${post}: not complete`);
        const r = cap.result();
        assert.equal(r.samples, pre + 1 + post);
        assert.equal(r.trigger, pre);
        assert.deepEqual(Array.from(r.data), Array.from(stream.subarray((g - pre) * unit, (g + post + 1) * unit)), `iter ${iter} ${type}`);
        assert.equal(cap.engine.fireIndex, g);
        checked++;
    }
    assert.ok(checked > 300, `only ${checked} captures were checked`);
});

test('a trigger before the pre-trigger window is full is ignored', () => {
    // ch0: 0 0 0 1 0 0 0 0 0 0 1 0 0 0 0  -> rising edges at 3 and 10, pre = 5 -> must use index 10
    const lv = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    const stream = Uint8Array.from(lv);
    const cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'L2H', preTrigger: 5, postTrigger: 2 });
    assert.equal(cap.push(stream), true);
    assert.deepEqual(Array.from(cap.result().data), lv.slice(5, 13));
    assert.equal(cap.engine.fireIndex, 10);
});

test('pulse is measured across chunk boundaries (one sample per chunk)', () => {
    const lv = [0, 1, 1, 1, 1, 0, 0];                 // PulseH 4 fires on index 4
    const cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'PulseH', pulseLength: 4, preTrigger: 1, postTrigger: 1 });
    let done = false;
    for (const v of lv) done = cap.push(Uint8Array.of(v));
    assert.equal(done, true);
    assert.equal(cap.engine.fireIndex, 4);
    assert.deepEqual(Array.from(cap.result().data), [1, 1, 0]);
});

test('a level that was already there at the start is not a pulse', () => {
    const cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'PulseH', pulseLength: 3, preTrigger: 0, postTrigger: 0 });
    assert.equal(cap.push(Uint8Array.of(1, 1, 1, 1, 1, 0, 0)), false);   // high from the start: length unknown
    assert.equal(cap.push(Uint8Array.of(1, 1, 1)), true);                // a real pulse
});

test('pre = 0 and post = 0 give exactly the trigger sample', () => {
    const cap = new TriggerCapture({ unitSize: 1, channel: 2, type: 'H2L', preTrigger: 0, postTrigger: 0 });
    assert.equal(cap.push(Uint8Array.of(4, 4, 0, 0)), true);
    assert.deepEqual(Array.from(cap.result().data), [0]);
});

/* ---------- glue: startTriggered with a fake device ---------- */
function fakeDevice({ channels = 8, chunks }) {
    const dev = { channels, started: null, stops: 0, onData: null, onDone: null };
    dev.deviceKind = {
        start(cfg, onData, onDone) { dev.started = cfg; dev.onData = onData; dev.onDone = onDone; },
        stop() { dev.stops++; },
    };
    dev.run = () => { for (const c of chunks) dev.onData(c, 0); };
    return dev;
}
function sinks() {
    const s = { data: [], done: null, errors: [], status: [] };
    s.cb = {
        onData: (c, off) => s.data.push({ c: Uint8Array.from(c), off }),
        onDone: (i) => { s.done = i; }, onError: (m) => s.errors.push(m), onStatus: (x) => s.status.push(x),
    };
    return s;
}

test('startTriggered: whole capture is delivered in order, with trigger index and status', () => {
    const lv = Array.from({ length: 200 }, (_, i) => (i >= 120 ? 1 : 0));   // rising edge at 120
    const dev = fakeDevice({ chunks: [Uint8Array.from(lv.slice(0, 77)), Uint8Array.from(lv.slice(77))] });
    const s = sinks();
    const h = startTriggered(dev, { samplerate: 1000, channels: 8, samplecount: 999, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 30, postTrigger: 20 }, s.cb);
    assert.ok(h);
    assert.equal('samplecount' in dev.started, false, 'device must run without a sample count');
    dev.run();
    assert.equal(dev.stops, 1);
    assert.deepEqual(s.status.map((x) => x.state), ['armed', 'triggered']);
    assert.equal(s.status[1].sample, 120);
    const all = s.data.flatMap((d) => Array.from(d.c));
    assert.deepEqual(all, lv.slice(90, 141));
    assert.equal(s.data[0].off, 0);
    assert.equal(s.done.samples, 51); assert.equal(s.done.trigger, 30); assert.equal(s.done.samplerate, 1000); assert.equal(s.done.channels, 8);
    dev.onDone({ stopped: true });                         // the device's own "done" after stop() is ignored
    assert.equal(s.errors.length, 0);
});

test('startTriggered: 12 channels = 2 bytes per sample', () => {
    const smp = (hi) => [0x00, hi ? 0x08 : 0x00];          // channel 11 = bit 3 of byte 1
    const bytes = [];
    for (let i = 0; i < 50; i++) bytes.push(...smp(i >= 25));
    const dev = fakeDevice({ channels: 12, chunks: [Uint8Array.from(bytes)] });
    const s = sinks();
    startTriggered(dev, { channels: 12, triggerOn: { channel: 11, type: 'L2H' }, preTrigger: 5, postTrigger: 4 }, s.cb);
    dev.run();
    assert.equal(s.done.samples, 10);
    assert.deepEqual(Array.from(s.data[0].c), bytes.slice(20 * 2, 30 * 2));
});

test('startTriggered: stop before the trigger delivers nothing; stop afterwards keeps a partial capture', () => {
    let dev = fakeDevice({ chunks: [] });
    let s = sinks();
    let h = startTriggered(dev, { samplerate: 1000, channels: 8, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 3, postTrigger: 10 }, s.cb);
    dev.onData(Uint8Array.of(0, 0, 0, 0));
    h.stop();
    assert.equal(dev.stops, 1); assert.equal(s.done, null); assert.deepEqual(s.errors, []);

    dev = fakeDevice({ chunks: [] }); s = sinks();
    h = startTriggered(dev, { samplerate: 1000, channels: 8, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 3, postTrigger: 10 }, s.cb);
    dev.onData(Uint8Array.of(0, 0, 0, 0, 1, 1, 1));        // trigger at 4, 2 more samples after it
    h.stop();
    assert.equal(s.done.samples, 3 + 1 + 2); assert.equal(s.done.stopped, true); assert.equal(s.done.trigger, 3);
    assert.deepEqual(s.data.flatMap((d) => Array.from(d.c)), [0, 0, 0, 1, 1, 1]);
});

test('startTriggered rejects bad configuration', () => {
    const dev = fakeDevice({ chunks: [] });
    const bad = [
        { channels: 8, triggerOn: { channel: 8, type: 'L2H' } },
        { channels: 8, triggerOn: { channel: 0, type: 'Rising' } },
        { channels: 8, triggerOn: { channel: 0, type: 'PulseH' } },
        { channels: 8, triggerOn: { channel: 0, type: 'PulseL', pulseLength: 0 } },
        { channels: 8, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: -1 },
        { channels: 8, triggerOn: { channel: 0, type: 'L2H' }, postTrigger: 1.5 },
        { channels: 8, triggerOn: { channel: 0, type: 'L2H' }, preTrigger: 1e12 },
    ];
    for (const m of bad) {
        const s = sinks();
        assert.equal(startTriggered(dev, m, s.cb), null);
        assert.equal(s.errors.length, 1, JSON.stringify(m));
    }
    assert.equal(dev.started, null);
    assert.ok(parseTriggerConfig({ triggerOn: { channel: 1, type: 'H2L' }, channels: ['D0', 'D1'] }, dev));
});

test('other channel conditions: the trigger only fires while the other channels match', () => {
    // ch0 rises at 2, 5 and 8; ch1 is high at 5 and 8, ch2 is high only at 8
    const lv = [0, 0, 1, 0, 0, 3, 0, 0, 7, 0];
    let cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'L2H', conditions: { 1: 'hi' }, preTrigger: 0, postTrigger: 0 });
    assert.equal(cap.push(Uint8Array.from(lv)), true);
    assert.equal(cap.engine.fireIndex, 5);
    cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'L2H', conditions: { 1: 'hi', 2: 'hi' }, preTrigger: 0, postTrigger: 0 });
    cap.push(Uint8Array.from(lv));
    assert.equal(cap.engine.fireIndex, 8);
    cap = new TriggerCapture({ unitSize: 1, channel: 0, type: 'L2H', conditions: { 1: 'lo' }, preTrigger: 0, postTrigger: 0 });
    cap.push(Uint8Array.from(lv));
    assert.equal(cap.engine.fireIndex, 2);
});

test('other channel conditions in another byte of the sample, pulse trigger', () => {
    // 2 bytes per sample, trigger PulseL 2 on ch0, condition ch12 (bit 4 of byte 1) high
    const s = (b0, b1) => [b0, b1];
    const bytes = [...s(1, 0), ...s(0, 0), ...s(0, 0), ...s(1, 0), ...s(0, 0x10), ...s(0, 0x10), ...s(1, 0)];
    const cap = new TriggerCapture({ unitSize: 2, channel: 0, type: 'PulseL', pulseLength: 2, conditions: { 12: 'hi' }, preTrigger: 1, postTrigger: 0 });
    assert.equal(cap.push(Uint8Array.from(bytes)), true);
    assert.equal(cap.engine.fireIndex, 5);
});

test('parseTriggerConfig validates the conditions', () => {
    const dev = { channels: 8 };
    const ok = parseTriggerConfig({ triggerOn: { channel: 0, type: 'L2H', conditions: { 3: 'hi', '4': 'lo' } } }, dev);
    assert.deepEqual(ok.conditions, { 3: 'hi', 4: 'lo' });
    for (const conditions of [{ 0: 'hi' }, { 8: 'hi' }, { 1: 'high' }, { x: 'lo' }, [], null]) {
        assert.throws(() => parseTriggerConfig({ triggerOn: { channel: 0, type: 'L2H', conditions } }, dev), JSON.stringify(conditions));
    }
});
