// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings } from './deviceSettings.js';
import { DemoDevice } from './DemoDevice.js';

const settings = {
    fields: [
        { type: 'heading', label: 'Network' },
        { key: 'name', label: 'Name', type: 'text', maxLength: 4 },
        { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, integer: true },
        { key: 'baud', label: 'Baud', type: 'select', options: [{ value: 9600 }, { value: 115200 }] },
        { key: 'on', label: 'On', type: 'checkbox' },
    ],
    values: { name: 'ab', port: 4045, baud: 9600, on: false },
};

test('validateSettings: the values, missing ones from the current values, headings skipped', () => {
    assert.deepEqual(validateSettings(settings, { port: 80, on: true }), { name: 'ab', port: 80, baud: 9600, on: true });
});

test('validateSettings: each rule, with the field\'s label in the message', () => {
    for (const [values, re] of [
        [{ name: 'abcde' }, /Name: at most 4/],
        [{ name: 5 }, /Name: must be text/],
        [{ port: '80' }, /Port: must be a number/],
        [{ port: 80.5 }, /Port: must be a whole number/],
        [{ port: 0 }, /Port: must be at least 1/],
        [{ port: 70000 }, /Port: must be at most 65535/],
        [{ baud: '9600' }, /Baud: "9600" is not one of the choices/],
        [{ on: 'yes' }, /On: must be on or off/],
    ]) {
        assert.throws(() => validateSettings(settings, values), re, JSON.stringify(values));
    }
});

test('DemoDevice: settings change the channels, the note and the pattern', async () => {
    const saved = DemoDevice.config;
    try {
        const { info } = await DemoDevice.applySettings({ channels: 4, spi: false, pwm: false });
        assert.equal(info.channels.length, 4);
        assert.equal(info.note, 'UART D0 · I²C D1/D2');
        assert.equal(info.settings.values.channels, 4);
        // only UART (D0) and I²C (D1/D2) move: D3 stays low, D7 (PWM) stays low
        const samples = DemoDevice.pattern(1_000_000);
        assert.ok(samples.every((s) => (s & 0b1000_1000) === 0));
        await assert.rejects(DemoDevice.applySettings({ channels: 9 }), /Channels: must be at most 8/);
        assert.equal(DemoDevice.config.channels, 4, 'a refused save changes nothing');
    } finally {
        DemoDevice.config = saved;
    }
});
