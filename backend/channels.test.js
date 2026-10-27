// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannels, makeRepacker } from './channels.js';
import { parseTriggerConfig, TriggerCapture } from './trigger.js';

const device = { channels: [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({ index, name: 'D' + index, type: 'logic' })) };

test('resolveChannels: all channels without a list, the list when it is valid', () => {
    assert.deepEqual(resolveChannels({}, device), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(resolveChannels({ channels: [0, 3, 5] }, device), [0, 3, 5]);
    for (const channels of [[], [8], [3, 1], [1, 1], ['D0'], 'all', [0.5]]) {
        assert.throws(() => resolveChannels({ channels }, device), JSON.stringify(channels));
    }
});

test('makeRepacker: bit k of the output = bit bits[k] of the input', () => {
    // 2-byte input samples; take channels 1, 9 and 15 -> 3 bits in 1 byte
    const r = makeRepacker(2, [1, 9, 15]);
    assert.equal(r.dstUnit, 1);
    const src = Uint8Array.of(0x02, 0x00,  0x00, 0x02,  0x00, 0x80,  0xFF, 0xFF,  0xFD, 0x7D);
    assert.deepEqual(Array.from(r.run(src)), [0b001, 0b010, 0b100, 0b111, 0b000]);
});

test('makeRepacker: raw 4-byte samples (sigrok-pico) with the first 9 channels -> 2 bytes, other bits cleared', () => {
    const r = makeRepacker(4, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(r.dstUnit, 2);
    assert.deepEqual(Array.from(r.run(Uint8Array.of(0xAB, 0xFF, 0xFF, 0xFF))), [0xAB, 0x01]);
});

test('makeRepacker: 32 channels, bit 31 survives', () => {
    const bits = Array.from({ length: 32 }, (_, i) => 31 - i);   // reversed
    const r = makeRepacker(4, bits);
    assert.deepEqual(Array.from(r.run(Uint8Array.of(0x00, 0x00, 0x00, 0x80))), [0x01, 0x00, 0x00, 0x00]);
    assert.deepEqual(Array.from(r.run(Uint8Array.of(0x01, 0x00, 0x00, 0x00))), [0x00, 0x00, 0x00, 0x80]);
});

test('makeRepacker: the identity layout is passed through unchanged', () => {
    const src = Uint8Array.of(1, 2, 3);
    assert.equal(makeRepacker(1, [0, 1, 2, 3, 4, 5, 6, 7]).run(src), src);
});

test('trigger channel and conditions are device indexes, mapped to their bit in the stream', () => {
    const cfg = parseTriggerConfig({ channels: [0, 3, 5], triggerOn: { channel: 5, type: 'L2H', conditions: { 3: 'hi' } } }, device);
    assert.equal(cfg.channel, 2);
    assert.deepEqual(cfg.conditions, { 1: 'hi' });
    assert.equal(cfg.channelCount, 3);
    // the stream has bits [ch0, ch3, ch5]: ch5 rises at 2 while ch3 is low, at 4 while ch3 is high
    const cap = new TriggerCapture({ ...cfg, preTrigger: 0, postTrigger: 0 });
    cap.push(Uint8Array.of(0b000, 0b000, 0b100, 0b000, 0b110, 0b000));
    assert.equal(cap.engine.fireIndex, 4);
    assert.throws(() => parseTriggerConfig({ channels: [0, 3], triggerOn: { channel: 5, type: 'L2H' } }, device), /not captured/);
    assert.throws(() => parseTriggerConfig({ channels: [0, 3], triggerOn: { channel: 0, type: 'L2H', conditions: { 5: 'lo' } } }, device), /not captured/);
});
