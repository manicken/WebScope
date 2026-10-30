/**
 * pyWorker.js — the Web Worker of the Python extension: one Pyodide (CPython in WebAssembly) shared by
 * all PythonDecoder instances, running upstream sigrok decoders (sigrokdecode.py, ws_srd_runner.py).
 * A module worker (Pyodide does not run in a classic one); it has no imports of its own, so Node can
 * also run it as a plain script (python_decoders/build-index.mjs).
 *
 * Messages from pyHost.js, { id, op, ... }, are handled one at a time in arrival order; the answer is
 * { id, ok: true, result } or { id, ok: false, error }:
 *   init      { runtimeUrl, roots }        load Pyodide and the runner; roots: the decoder folders
 *   buffer    { buffer, samples, length, samplerate }   a capture (the worker keeps the last few)
 *   run       { job }                      decode one instance, see ws_srd_runner.run()
 *   metadata  { name }                     a decoder's metadata (decoders that are not in an index)
 *   forget    { inst }                     a removed instance
 * A run whose instance got a newer job while it waited is not run: { stale: true }.
 *
 * SrdMatcher and SrdCore do not depend on the worker, so tools can run them in Node (globalThis.WSPy).
 */
'use strict';

/**
 * The sample matching of wait() in libsigrokdecode (instance.c), over one capture:
 *  - a wait() starts at the sample the last one matched (or 0), with the "old" pins of that sample:
 *    an edge cannot match there again, a level can; { skip: n } matches n samples further on
 *  - before the first sample the old pins are those of sample 0 (no edge at sample 0)
 *  - conditions are ORed, the terms of one condition ANDed (in order, a skip term only counts
 *    the samples where the terms before it matched)
 *  - wait() without conditions: the next sample (sample 0 when it is the first wait())
 * wait(text) returns the matching sample, or -1 at the end of the data; then
 *   mask   bit j set when condition j matched     count  the number of conditions (0: none given)
 *   value  the sample's value (bit b = capture channel b)
 *   state  all three in one number, so Python reads one attribute instead of three:
 *          ((mask << 6 | count) * 2^32 + value), or -1 when that does not fit in 53 bits
 */
class SrdMatcher {
    static HIGH = 0; static LOW = 1; static RISE = 2; static FALL = 3; static EDGE = 4; static STABLE = 5;
    static SKIP = 6; static NEVER = 7;
    static KINDS = { h: 0, l: 1, r: 2, f: 3, e: 4, n: 5 };

    /** @param bits  capture bit of each decoder channel (required ones, then optional ones), -1 = none */
    constructor(samples, length, bits) {
        this.samples = samples;
        this.length = length;
        this.bits = Int32Array.from(bits);
        this.cur = 0;
        this.prev = length > 0 ? samples[0] : 0;
        this.mask = 0;
        this.count = 0;
        this.value = 0;
        this.state = 0;
        this.waited = false;
        this.cache = new Map();
    }

    /**
     * The Python repr() of wait()'s argument -> null (no condition) or [[term, ...], ...],
     * term: [kind, bit or skip count]. "[{0: 'f'}, {'skip': 552}]", "{1: 'r', 0: 'h'}", "None", ...
     * As libsigrokdecode: an int key is a channel, a string key a skip; a channel the decoder does
     * not have, or a negative skip, never matches.
     */
    compile(text) {
        let conds = this.cache.get(text);
        if (conds !== undefined) return conds;
        const dicts = text.match(/\{[^{}]*\}/g) ?? [];
        if (text !== 'None' && dicts.length === 0 && !/^[[(]\s*,?\s*[\])]$/.test(text)) {
            throw new Error(`wait(): unsupported conditions ${text}`);
        }
        conds = dicts.map((d) => {
            const inner = d.slice(1, -1).trim();
            return (inner ? inner.split(/,\s*/) : []).map((item) => {
                // channel: 1 or an IntEnum member, <Pin.CLK: 1>; skip: 'skip' (any string key)
                const m = /^\s*(?:(\d+)|<[\w.]+:\s*(\d+)>|'[^']*'|"[^"]*")\s*:\s*(?:'(\w)\w*'|"(\w)\w*"|(-?[\d.]+))\s*$/.exec(item);
                if (!m) throw new Error(`wait(): unsupported condition ${item} in ${text}`);
                const [, ch1, ch2, q1, q2, num] = m;
                const ch = ch1 ?? ch2;
                if (ch === undefined) {
                    const n = Math.floor(Number(num));
                    return n >= 0 ? [SrdMatcher.SKIP, n] : [SrdMatcher.NEVER, 0];
                }
                const kind = SrdMatcher.KINDS[q1 ?? q2];
                if (kind === undefined) throw new Error(`wait(): unknown condition ${item}`);
                const bit = Number(ch) < this.bits.length ? this.bits[Number(ch)] : -1;
                return bit < 0 ? [SrdMatcher.NEVER, 0] : [kind, bit];
            });
        });
        // None, [] and {} are no condition; [{}] is one empty condition (it matches at once)
        if (conds.length === 0 || (text === '{}')) conds = null;
        if (this.cache.size > 4096) this.cache.clear();   // skip counts vary, keep the cache small
        this.cache.set(text, conds);
        return conds;
    }

    wait(text) {
        let conds = this.compile(text);
        if (conds === null) {
            // only the very first wait() may stay at sample 0 (libsigrokdecode keeps the last condition list)
            conds = [[[SrdMatcher.SKIP, this.cur > 0 || this.waited ? 1 : 0]]];
            this.count = 0;
        } else {
            this.count = conds.length;
        }
        this.waited = true;
        const skipped = conds.map((terms) => new Float64Array(terms.length));   // per wait(), as create_term_list()
        const { samples, length } = this;
        let prev = this.prev;
        for (let i = this.cur; i < length; i++) {
            const v = samples[i];
            let mask = 0;
            for (let j = 0; j < conds.length; j++) {
                const terms = conds[j];
                let ok = true;
                for (let t = 0; t < terms.length && ok; t++) {
                    const [kind, arg] = terms[t];
                    if (kind === SrdMatcher.SKIP) {
                        if (skipped[j][t] === arg) continue;
                        skipped[j][t]++;
                        ok = false;
                        continue;
                    }
                    const s = (v >>> arg) & 1, o = (prev >>> arg) & 1;
                    switch (kind) {
                        case SrdMatcher.HIGH: ok = s === 1; break;
                        case SrdMatcher.LOW: ok = s === 0; break;
                        case SrdMatcher.RISE: ok = o === 0 && s === 1; break;
                        case SrdMatcher.FALL: ok = o === 1 && s === 0; break;
                        case SrdMatcher.EDGE: ok = o !== s; break;
                        case SrdMatcher.STABLE: ok = o === s; break;
                        default: ok = false;
                    }
                }
                if (ok) mask |= 1 << j;
            }
            prev = v;
            if (mask !== 0) {
                this.cur = i;
                this.prev = v;
                this.mask = mask;
                this.value = v >>> 0;
                const key = mask * 64 + this.count;
                this.state = key < 2 ** 21 ? key * 2 ** 32 + this.value : -1;
                return i;
            }
        }
        this.cur = length;
        this.prev = prev;
        this.mask = 0;
        return -1;
    }
}

/** Pyodide + the runner. `fetchText(url)` must be synchronous (Python imports with it): text or null. */
class SrdCore {
    constructor({ loadPyodide, runtimeUrl, fetchText, sources }) {
        this.loadPyodide = loadPyodide;
        this.runtimeUrl = runtimeUrl;
        this.fetchText = fetchText;
        this.sources = sources;          // { 'sigrokdecode.py': text, 'ws_srd_runner.py': text }
        this.py = null;
        this.runner = null;
    }

    async init(roots) {
        const py = await this.loadPyodide({ indexURL: this.runtimeUrl });
        py.FS.mkdirTree('/wsext');
        for (const [name, text] of Object.entries(this.sources)) py.FS.writeFile(`/wsext/${name}`, text);
        // undefined is None in Python (null is JsNull)
        py.registerJsModule('_wshost', { fetch_text: (url) => this.fetchText(url) ?? undefined });
        py.runPython("import sys\nsys.path.insert(0, '/wsext')");
        this.runner = py.pyimport('ws_srd_runner');
        this.runner.install(JSON.stringify(roots));
        this.py = py;
        return { version: py.version };
    }

    metadata(name) { return JSON.parse(this.runner.metadata(name)); }

    scan(names) { return JSON.parse(this.runner.scan(JSON.stringify(names))); }

    /** buf: { samples, length } or null (stacked job). Returns the runner's result + timing. */
    run(job, buf) {
        const matcher = buf ? new SrdMatcher(buf.samples, buf.length, job.bits) : null;
        const t0 = performance.now();
        let waits = 0;
        if (matcher) {
            const wait = matcher.wait.bind(matcher);
            matcher.wait = (text) => { waits++; return wait(text); };
        }
        const result = JSON.parse(this.runner.run(JSON.stringify(job), matcher));
        result.stats = { ms: performance.now() - t0, waits };
        return result;
    }

    forget(inst) { this.runner?.forget(inst); }
}

globalThis.WSPy = { SrdMatcher, SrdCore };

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    const MAX_BUFFERS = 2;           // the capture on screen, and one that is being replaced
    const buffers = new Map();       // buffer id -> { samples, length, samplerate }, oldest first
    const newestGen = new Map();     // instance id -> newest job generation received
    let core = null;
    let initError = null;
    let queue = Promise.resolve();

    function fetchText(url) {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.overrideMimeType('text/plain; charset=utf-8');
        try { xhr.send(); } catch { return null; }
        return xhr.status === 200 ? xhr.responseText : null;
    }

    function source(name) {
        const text = fetchText(new URL(name, self.location).href);
        if (text == null) throw new Error(`Cannot load ${name}`);
        return text;
    }

    async function handle(msg) {
        if (msg.op === 'init') {
            try {
                const { loadPyodide } = await import(new URL('pyodide.mjs', msg.runtimeUrl).href);
                core = new SrdCore({
                    loadPyodide,
                    runtimeUrl: msg.runtimeUrl,
                    fetchText,
                    sources: { 'sigrokdecode.py': source('sigrokdecode.py'), 'ws_srd_runner.py': source('ws_srd_runner.py') },
                });
                return await core.init(msg.roots);
            } catch (e) {
                initError = e;
                core = null;
                throw e;
            }
        }
        if (!core) throw initError ?? new Error('The Python runtime is not loaded');

        switch (msg.op) {
            case 'buffer': {
                buffers.delete(msg.buffer);
                buffers.set(msg.buffer, { samples: msg.samples, length: msg.length, samplerate: msg.samplerate });
                while (buffers.size > MAX_BUFFERS) buffers.delete(buffers.keys().next().value);
                return true;
            }
            case 'run': {
                const { job } = msg;
                if (job.gen < newestGen.get(job.inst)) return { stale: true };
                let buf = null;
                if (job.parent == null) {
                    buf = buffers.get(job.buffer);
                    if (!buf) throw new Error('The capture is not in the Python worker');
                }
                try {
                    return core.run(job, buf);
                } catch (e) {
                    if (String(e.message).includes('has no current output')) return { stale: true };
                    throw e;
                }
            }
            case 'metadata': return core.metadata(msg.name);
            case 'forget': core.forget(msg.inst); newestGen.delete(msg.inst); return true;
            default: throw new Error(`Unknown operation ${msg.op}`);
        }
    }

    self.onmessage = (e) => {
        const msg = e.data;
        if (msg.op === 'run') newestGen.set(msg.job.inst, Math.max(newestGen.get(msg.job.inst) ?? 0, msg.job.gen));
        queue = queue
            .then(() => handle(msg))
            .then((result) => self.postMessage({ id: msg.id, ok: true, result }),
                  (e) => self.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) }));
    };
}
