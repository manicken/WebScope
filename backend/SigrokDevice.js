// SigrokDevice.js - use sigrok-cli from the Node.js backend (no native addon needed).
//
//   scanSigrok()  -> Promise<info[]>   one info object per device found by `sigrok-cli --scan`,
//                                      (sigrok-pico boards have their own driver: PicoCoderSigrokPicoDevice.js)
//   info.deviceKind.start(msg, onData, onDone, onError) / .stop()   (same shape as DemoDevice)
//   onError(message, details) and onDone({ ..., warning?, details? }): details is the extended message
//   for the frontend's message log (the sigrok-cli command line, exit code and its whole stderr)
//
// Only logic channels are handled (raw packed bytes via `-O binary`).
// sigrok-cli is located automatically (env SIGROK_CLI, PATH, next to this file, usual install folders).

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChannelPacker } from './channels.js';

// ---- locating sigrok-cli ----------------------------------------------------
// Tried in this order, the first one that answers `--version` wins:
//   1. $SIGROK_CLI            2. PATH            3. next to this file (bundle it with WebScope)
//   4. usual install folders (guesses - add your own to the list below)
const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? 'sigrok-cli.exe' : 'sigrok-cli';

function candidates() {
    const list = [];
    if (process.env.SIGROK_CLI) list.push(process.env.SIGROK_CLI);
    list.push(exe);                                              // via PATH
    list.push(path.join(here, 'sigrok-cli', exe), path.join(here, exe));
    if (process.platform === 'win32') {
        const roots = [
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
        ].filter(Boolean);
        for (const r of roots) {
            list.push(path.join(r, 'sigrok', 'sigrok-cli', exe));
            list.push(path.join(r, 'sigrok', 'PulseView', exe));
            list.push(path.join(r, 'sigrok-cli', exe));
        }
        list.push('C:\\msys64\\mingw64\\bin\\' + exe, 'C:\\msys64\\ucrt64\\bin\\' + exe);
    } else {
        list.push('/usr/local/bin/sigrok-cli', '/opt/homebrew/bin/sigrok-cli', '/usr/bin/sigrok-cli');
    }
    return list;
}

let sigrokCli = null;   // resolved path, set by resolveSigrokCli()

export async function resolveSigrokCli() {
    if (sigrokCli) return sigrokCli;
    const tried = [];
    for (const c of candidates()) {
        if (path.isAbsolute(c) && !existsSync(c)) { tried.push(c); continue; }
        try {
            await new Promise((resolve, reject) =>
                execFile(c, ['--version'], { timeout: 10000 }, (e) => (e ? reject(e) : resolve())));
            sigrokCli = c;
            console.log('Using sigrok-cli: ' + c);
            return c;
        } catch {
            tried.push(c);
        }
    }
    throw new Error('sigrok-cli not found. Tried:\n  ' + tried.join('\n  ') +
        '\nSet SIGROK_CLI to the full path of sigrok-cli(.exe), or add its folder to PATH.');
}

// sigrok-cli --scan does not report channel types. Treat D0, D1, ... / 0, 1, ... as logic.
const isLogicChannel = (name) => /^D?\d+$/.test(name);

// How sigrok-cli's binary output holds the enabled channels (-C) depends on the driver (measured):
//   raw     the device's own sample: channel n = bit n, ceil(all logic channels / 8) bytes, the bits of
//           disabled channels are not cleared (fx2lafw) -
//           libsigrok's own convention, so the default
//   packed  only the enabled channels: the k-th enabled channel = bit k, ceil(enabled / 8) bytes (demo)
const PACKED_DRIVERS = ['demo'];

// The sample count for "until stopped" on a device that cannot sample continuously (no --continuous):
// 2^31 - 1, so it fits a 32-bit signed number in the driver / firmware; 35 minutes at 1 MHz
const UNTIL_STOPPED_SAMPLES = 2 ** 31 - 1;

class SigrokKind {
    constructor(driverSpec, channels, continuous = true) {
        this.driverSpec = driverSpec;   // what goes after -d, e.g. "demo" or "fx2lafw:conn=1.5"
        this.channels = channels;       // all channel names reported by the scan
        this.continuous = continuous;   // it can run until stopped (--continuous), else it needs a sample count
        this.proc = null;
    }

    start(msg, onData, onDone, onError) {
        console.log("sigrock device start");
        if (!sigrokCli) return onError('sigrok-cli has not been located (scanSigrok() must run first)');
        if (this.proc) return onError('SigrokDevice - device is already capturing');

        // msg comes from the browser: validate everything before it reaches the command line
        const args = ['-d', this.driverSpec];

        if (msg.samplerate !== undefined) {
            if (!Number.isInteger(msg.samplerate) || msg.samplerate <= 0) return onError('SigrokDevice - bad samplerate');
            args.push('--config', `samplerate=${msg.samplerate}`);
        }
        // msg.channels: indexes into the logic channels (= the device info's channels), all when missing
        const logic = this.channels.filter(isLogicChannel);
        const indexes = msg.channels ?? logic.map((_, i) => i);
        if (!Array.isArray(indexes) || indexes.length === 0 || !indexes.every((i) => Number.isInteger(i) && logic[i] !== undefined)) {
            return onError('SigrokDevice - bad channel list');
        }
        const driver = this.driverSpec.split(':')[0];
        args.push('-C', indexes.map((i) => logic[i]).join(','));

        if (msg.samplecount !== undefined) {
            if (!Number.isInteger(msg.samplecount) || msg.samplecount <= 0) return onError('SigrokDevice - bad samplecount');
            args.push('--samples', String(msg.samplecount));
        } else if (!this.continuous) {
            // runs until stopped all the same: a sample count it will not reach
            args.push('--samples', String(UNTIL_STOPPED_SAMPLES));
        } else {
            args.push('--continuous');
        }
        args.push('-O', 'binary');

        // what sigrok-cli sends, and how to turn it into the browser's format (only the enabled channels, see channels.js)
        const packed = PACKED_DRIVERS.includes(driver);
        const unitSize = Math.ceil((packed ? indexes.length : logic.length) / 8);   // bytes per sample from sigrok-cli
        const repack = makeChannelPacker(unitSize, indexes, packed ? (ch) => indexes.indexOf(ch) : undefined);

        // stdin must stay OPEN ('pipe'): sigrok-cli quits immediately when stdin is closed/EOF,
        // which is what stdio 'ignore' (/dev/null) gives it.
        const proc = spawn(sigrokCli, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc = proc;

        let stopped = false;
        let failed = false;
        let totalBytes = 0;
        let leftover = Buffer.alloc(0);
        let stderr = '';
        this.stopRequested = () => { stopped = true; };
        // the extended message for the frontend's message log: what was run and everything sigrok-cli said
        const details = (code) => [
            `"${sigrokCli}" ${args.join(' ')}`,
            `exit code: ${code}`,
            stderr.trim() || '(nothing on stderr)',
        ].join('\n\n');

        proc.stdout.on('data', (data) => {
            // chunk boundaries are arbitrary: only forward whole samples
            let buf = leftover.length ? Buffer.concat([leftover, data]) : data;
            const usable = buf.length - (buf.length % unitSize);
            leftover = Buffer.from(buf.subarray(usable));
            if (usable === 0) return;
            /*const chunk = buf.subarray(0, usable);
            onData(chunk, totalBytes / unitSize);   // offset in samples
            totalBytes += usable;*/
            const remainingBytes = msg.samplecount !== undefined
                ? msg.samplecount * unitSize - totalBytes
                : usable;

            const bytes = Math.min(usable, remainingBytes);

            if (bytes <= 0) return;

            const chunk = buf.subarray(0, bytes);

            onData(repack.run(chunk), totalBytes / unitSize);
            totalBytes += bytes;
        });

        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });

        proc.on('error', (err) => {   // e.g. ENOENT when sigrok-cli is not installed / not on PATH
            failed = true;
            this.proc = null;
            onError(`SigrokDevice - could not run ${sigrokCli}: ${err.message}`, `"${sigrokCli}" ${args.join(' ')}\n\n${err.stack ?? err.message}`);
            onDone({ deviceId: this.driverSpec, samples: 0, stopped: false, ok: false });
        });

        proc.on('close', (code) => {
            if (failed) return;
            this.proc = null;
            if (code !== 0 && !stopped) onError('SigrokDevice - ' + (errorText(stderr) || `sigrok-cli exited with code ${code}`), details(code));
            const samples = totalBytes / unitSize;
            // some devices end early without an error (their memory is full, or they cannot send the data fast enough)
            const short = !stopped && code === 0 && msg.samplecount !== undefined && samples < msg.samplecount;
            onDone({
                deviceId: this.driverSpec,
                samples,
                stopped,
                ok: stopped || code === 0,
                ...(short && {
                    warning: `The device sent only ${samples} of ${msg.samplecount} samples: use a lower samplerate or a shorter capture`,
                    details: details(code),
                }),
            });
        });
    }

    stop() {
        if (!this.proc) return;
        this.stopRequested?.();
        this.proc.kill();   // SIGTERM on Linux, terminates the process on Windows
    }
}

/** sigrok-cli's error message without its debug lines ("sr: ..."; some drivers print "Drain reads" on every run). */
function errorText(stderr) {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const plain = lines.filter((l) => !l.startsWith('sr: '));
    return (plain.length ? plain : lines.filter((l) => !/Drain reads/.test(l))).join('\n');
}

async function run(args) {
    const cli = await resolveSigrokCli();
    return new Promise((resolve, reject) => {
        execFile(cli, args, { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${cli} ${args.join(' ')}: ${err.message}`));
            else resolve(stdout);
        });
    });
}

// Output looks like:
//   The following devices were found:
//   demo - Demo device with 13 channels: D0 D1 D2 ...
//   fx2lafw:conn=1.5 - Saleae Logic with 8 channels: D0 D1 ...
function parseScanLines(out) {
    const found = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(\S+) - (.+)$/);
        if (!m) continue;
        const [, spec, rest] = m;
        const d = rest.match(/^(.*?) with (\d+) channels?: (.*)$/);
        found.push({ spec, name: d ? d[1] : rest, channels: d ? d[3].trim().split(/\s+/) : [] });
    }
    return found;
}

/** Device info for the browser, from `--show` of one device. */
async function describe({ spec, name, channels }) {
    const deviceInfoOut = await run(['-d', spec, '--show']);
    const deviceInfoLines = deviceInfoOut.split(/\r?\n/);
    const samplerates = [];
    let defaultSamplerate;   // the rate the device is set to now, marked "(current)" in the list
    let li = 0;
    for (; li < deviceInfoLines.length; li++) {
        if (deviceInfoLines[li].trim() === 'samplerate - supported samplerates:')
        {
            li++;
            //console.log('found sampleRates');
            break;
        }
    }
    for (; li < deviceInfoLines.length; li++) {
        let line = deviceInfoLines[li];
        //console.log("scanning:" + line);
        let currentEntryMaybeIndex = line.indexOf('(current)');
        const isCurrent = currentEntryMaybeIndex != -1;
        if (isCurrent) {
            line = line.substring(0, currentEntryMaybeIndex);
        }
        line = line.trim();
        currentEntryMaybeIndex = line.indexOf('Hz');
        if (currentEntryMaybeIndex != -1) {
            currentEntryMaybeIndex--;
            let prefix = line[currentEntryMaybeIndex];
            let mult = 1;
            if (prefix >= '0' && prefix <= '9') {
                currentEntryMaybeIndex++;
            } else if (prefix == 'k' || prefix == 'K') {
                mult = 1_000;
            } else if (prefix == 'M') {
                mult = 1_000_000;
            } else if (prefix == 'G') {
                mult = 1_000_000_000;
            } // not sure there is any hobby logic analyzer that support terahertz hehe
            samplerates.push(Math.round(Number(line.substring(0, currentEntryMaybeIndex).trim())*mult));
            if (isCurrent) defaultSamplerate = samplerates.at(-1);
            //sampleRates.push(line.substring(0, line.length-3));
        } else {
            break;
        }
    }
    // some drivers give a range instead of a list (the demo driver: "1 Hz - 1 GHz in steps of 1 Hz"),
    // without a "(current)" mark: ask for the current rate, which --get prints in Hz, e.g. "200000"
    if (defaultSamplerate === undefined) {
        try {
            const rate = Number((await run(['-d', spec, '--get', 'samplerate'])).trim());
            if (Number.isInteger(rate) && rate > 0) defaultSamplerate = rate;
        } catch (err) {
            console.warn(`Sigrok: could not get the samplerate of ${spec}:`, err.message);
        }
    }
    let triggerOptions = [];
    let triggerOptionsSearchText = 'Supported triggers:';
    for (li = 0; li < deviceInfoLines.length; li++) {
        let line = deviceInfoLines[li].trim();
        if (line.startsWith(triggerOptionsSearchText)) {
            line = line.substring(triggerOptionsSearchText.length).trim();
            triggerOptions = line.split(' ');
            break;
        }
    }

    // "continuous: on, off" is listed only by drivers that can run until stopped; the others need a
    // sample count, and sigrok-cli refuses --continuous for them: see UNTIL_STOPPED_SAMPLES
    const continuous = deviceInfoLines.some((l) => /^\s*continuous:/.test(l));

    const info = {
        id: 'sigrok:' + spec,
        name,
        samplerates,
        defaultSamplerate,
        triggerOptions,
        driver: spec.split(':')[0],
        channels: channels.filter(isLogicChannel).map((n, i) => ({ index: i, name: n, type: 'logic' })),
    };
    //console.log(info);
    // non-enumerable so JSON.stringify(info) sends it to the browser without the kind object
    Object.defineProperty(info, 'deviceKind', {
        value: new SigrokKind(spec, channels, continuous),
        enumerable: false,
    });
    return info;
}

export async function scanSigrok(driver /* optional, e.g. "fx2lafw" */) {
    try {
        const found = parseScanLines(await run(driver ? ['-d', driver, '--scan'] : ['--scan']));
        const devices = [];
        for (const dev of found) devices.push(await describe(dev));
        return devices;
    } catch (err) {
        console.warn('Sigrok scan failed:', err);
        return [];
    }
}