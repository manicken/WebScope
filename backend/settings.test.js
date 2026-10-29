// node --test        (Node 18+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
    defaultSettings, applySettingsJson, applyArgs, hostname, isHostAllowed, isOriginAllowed,
} from './settings.js';

const req = (headers) => ({ headers });

test('applySettingsJson: known keys with the right type, errors for a wrong type', () => {
    const s = applySettingsJson(defaultSettings(), { port: 9000, allowHosts: ['scope.lan'], hostCheck: false });
    assert.equal(s.port, 9000);
    assert.deepEqual(s.allowHosts, ['scope.lan']);
    assert.equal(s.hostCheck, false);
    assert.throws(() => applySettingsJson(defaultSettings(), { port: '9000' }), /port/);
    assert.throws(() => applySettingsJson(defaultSettings(), { allowHosts: 'scope.lan' }), /allowHosts/);
    assert.throws(() => applySettingsJson(defaultSettings(), [1]), /object/);
});

test('applyArgs: wins over settings.json, the lists add to it', () => {
    const s = applySettingsJson(defaultSettings(), { port: 9000, allowOrigins: ['https://a.example'] });
    applyArgs(s, ['--port', '8081', '--open', '--allow-origin', 'https://b.example', '--no-host-check', '--settings', 'x.json']);
    assert.equal(s.port, 8081);
    assert.equal(s.open, true);
    assert.deepEqual(s.allowOrigins, ['https://a.example', 'https://b.example']);
    assert.equal(s.hostCheck, false);
    assert.throws(() => applyArgs(defaultSettings(), ['--allow-host']), /needs a value/);
});

test('hostname: drops the port, keeps IPv6 without brackets', () => {
    assert.equal(hostname('Example.com:8080'), 'example.com');
    assert.equal(hostname('192.168.1.50'), '192.168.1.50');
    assert.equal(hostname('[::1]:8080'), '::1');
    assert.equal(hostname('a:b:c'), undefined);
});

test('isHostAllowed: this computer\'s names and allowHosts, not other names', () => {
    const s = defaultSettings();
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'scope.localhost:8080', `${os.hostname()}:8080`]) {
        assert.ok(isHostAllowed(req({ host }), s), host);
    }
    assert.ok(isHostAllowed(req({}), s), 'no Host header');
    assert.ok(!isHostAllowed(req({ host: 'evil.example:8080' }), s));
    assert.ok(isHostAllowed(req({ host: 'Scope.Lan:8080' }), { ...s, allowHosts: ['scope.lan'] }));
    assert.ok(isHostAllowed(req({ host: 'evil.example:8080' }), { ...s, hostCheck: false }));
});

test('isOriginAllowed: own pages, listed origins, "*"', () => {
    const s = defaultSettings();
    assert.ok(isOriginAllowed(req({ host: 'localhost:8080' }), s), 'no Origin header');
    assert.ok(isOriginAllowed(req({ host: 'localhost:8080', origin: 'http://localhost:8080' }), s));
    assert.ok(!isOriginAllowed(req({ host: 'localhost:8080', origin: 'https://other.example' }), s));
    assert.ok(isOriginAllowed(req({ host: 'localhost:8080', origin: 'https://other.example' }), { ...s, allowOrigins: ['https://other.example'] }));
    assert.ok(isOriginAllowed(req({ host: 'localhost:8080', origin: 'https://other.example' }), { ...s, allowOrigins: ['*'] }));
});
