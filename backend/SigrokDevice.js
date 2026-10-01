// SigrokDevice.js - use sigrok-cli from the Node.js backend (no native addon needed).
//
//   scanSigrok()  -> Promise<info[]>   one info object per device found by `sigrok-cli --scan`
//   info.deviceKind.start(msg, onData, onDone, onError) / .stop()   (same shape as DemoDevice)
//
// Only logic channels are handled (raw packed bytes via `-O binary`).
// sigrok-cli is located automatically (env SIGROK_CLI, PATH, next to this file, usual install folders).

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

class SigrokKind {
    constructor(driverSpec, channels) {
        this.driverSpec = driverSpec;   // what goes after -d, e.g. "demo" or "fx2lafw:conn=1.5"
        this.channels = channels;       // all channel names reported by the scan
        this.proc = null;
    }

    start(msg, onData, onDone, onError) {
        console.log("sigrock device start");
        if (!sigrokCli) return onError('sigrok-cli has not been located (scanSigrok() must run first)');
        if (this.proc) return onError('device is already capturing');

        // msg comes from the browser: validate everything before it reaches the command line
        const args = ['-d', this.driverSpec];

        if (msg.samplerate !== undefined) {
            if (!Number.isInteger(msg.samplerate) || msg.samplerate <= 0) return onError('bad samplerate');
            args.push('--config', `samplerate=${msg.samplerate}`);
        }
        if (!msg.channels) {
            console.log("warning msg.channels is undefined");
        } 
        const wanted = msg.channels ?? this.channels.filter(isLogicChannel);
        if (!Array.isArray(wanted) || wanted.length === 0 ||
            !wanted.every((c) => this.channels.includes(c) && isLogicChannel(c))) {
            return onError('bad channel list');
        }
        args.push('-C', wanted.join(','));

        if (msg.samples !== undefined) {
            if (!Number.isInteger(msg.samples) || msg.samples <= 0) return onError('bad samples');
            args.push('--samples', String(msg.samples));
        } else {
            args.push('--continuous');
        }
        args.push('-O', 'binary');

        // sigrok packs logic channels into ceil(n/8) bytes per sample
        const unitSize = Math.ceil(wanted.length / 8);

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

        proc.stdout.on('data', (data) => {
            // chunk boundaries are arbitrary: only forward whole samples
            let buf = leftover.length ? Buffer.concat([leftover, data]) : data;
            const usable = buf.length - (buf.length % unitSize);
            leftover = Buffer.from(buf.subarray(usable));
            if (usable === 0) return;
            const chunk = buf.subarray(0, usable);
            onData(chunk, totalBytes / unitSize);   // offset in samples
            totalBytes += usable;
        });

        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

        proc.on('error', (err) => {   // e.g. ENOENT when sigrok-cli is not installed / not on PATH
            failed = true;
            this.proc = null;
            onError(`could not run ${sigrokCli}: ${err.message}`);
            onDone({ deviceId: this.driverSpec, samples: 0, stopped: false, ok: false });
        });

        proc.on('close', (code) => {
            if (failed) return;
            this.proc = null;
            if (code !== 0 && !stopped) onError(stderr.trim() || `sigrok-cli exited with code ${code}`);
            onDone({
                deviceId: this.driverSpec,
                samples: totalBytes / unitSize,
                stopped,
                ok: stopped || code === 0,
            });
        });
    }

    stop() {
        if (!this.proc) return;
        this.stopRequested?.();
        this.proc.kill();   // SIGTERM on Linux, terminates the process on Windows
    }
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
export async function scanSigrok(driver /* optional, e.g. "fx2lafw" */) {
    const out = await run(driver ? ['-d', driver, '--scan'] : ['--scan']);
    const devices = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(\S+) - (.+)$/);
        if (!m) continue;
        const [, spec, rest] = m;
        const d = rest.match(/^(.*?) with (\d+) channels?: (.*)$/);
        const name = d ? d[1] : rest;
        const channels = d ? d[3].trim().split(/\s+/) : [];

        const info = {
            id: 'sigrok:' + spec,
            name,
            driver: spec.split(':')[0],
            channels: channels.filter(isLogicChannel).map((n, i) => ({ index: i, name: n, type: 'logic' })),
        };
        // non-enumerable so JSON.stringify(info) sends it to the browser without the kind object
        Object.defineProperty(info, 'deviceKind', {
            value: new SigrokKind(spec, channels),
            enumerable: false,
        });
        devices.push(info);
    }
    return devices;
}