// trigger.js — hardware-independent trigger + pre/post-trigger capture for the WebScope backend.
//
// Works on the sample bytes every device produces for the browser (channels.js: unitSize = 1, 2 or 4
// bytes per sample, channel n = bit (n & 7) of byte (n >> 3)).
// No dependency on any driver: startTriggered() only needs an object with start()/stop().
//
//   TriggerEngine    finds the trigger sample in a stream of chunks (state survives chunk boundaries):
//                    an edge / pulse on one channel, optionally with "other channel conditions"
//                    (levels other channels must have at the trigger sample)
//   TriggerCapture   ring buffer for the pre-trigger samples + collection of the post-trigger samples
//   startTriggered   glue: runs a device continuously, feeds TriggerCapture, delivers the finished capture
//
// Finished capture = preTrigger samples, the trigger sample, postTrigger samples
//                  = preTrigger + 1 + postTrigger samples, the trigger sample is at index preTrigger.

import { sampleBytes } from './channels.js';

export const TRIGGER_TYPES = ['L2H', 'H2L', 'PulseH', 'PulseL'];

const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;   // refuse absurd pre/post settings instead of running out of memory
const STREAM_SAMPLES = 1 << 16;                // the finished capture is sent to the client in pieces of this size
const EMPTY = new Uint8Array(0);

/* ============================== trigger detection ============================== */

export class TriggerEngine {
    /**
     * @param {object} o
     * @param {number} o.unitSize     bytes per sample
     * @param {number} o.channel      bit index of the monitored channel within a sample
     * @param {string} o.type         'L2H' | 'H2L' | 'PulseH' | 'PulseL'
     * @param {number} [o.pulseLength] samples, PulseH / PulseL only
     * @param {object} [o.conditions]  { channelIndex: 'lo' | 'hi' }, checked at the trigger sample
     */
    constructor({ unitSize, channel, type, pulseLength = 0, conditions = {} }) {
        this.unit = unitSize;
        this.byteIdx = channel >> 3;
        this.mask = 1 << (channel & 7);
        this.pulseLength = pulseLength;
        this.kind = (type === 'L2H' || type === 'H2L') ? 'edge' : 'pulse';
        this.from = type === 'L2H' ? 0 : 1;          // edge: level before / after the transition
        this.to = type === 'L2H' ? 1 : 0;
        this.level = type === 'PulseH' ? 1 : 0;      // pulse: level that has to be held
        this.prev = -1;      // level of the previous sample, -1 = no sample seen yet
        this.run = 0;        // length of the current level, counted from an observed edge (0 = start unknown)
        this.pos = 0;        // global index of the next sample
        this.fireIndex = -1; // global index of the trigger sample once found

        // conditions as [byte, mask, value] per byte of a sample that has any
        const cm = new Uint8Array(unitSize), cv = new Uint8Array(unitSize);
        for (const [ch, level] of Object.entries(conditions)) {
            const b = Number(ch) >> 3, m = 1 << (Number(ch) & 7);
            cm[b] |= m;
            if (level === 'hi') cv[b] |= m;
        }
        this.cond = [];
        for (let b = 0; b < unitSize; b++) if (cm[b]) this.cond.push([b, cm[b], cv[b]]);
    }

    /** Do the other channels match the conditions in the sample that starts at byte `s`? */
    condOk(chunk, s) {
        for (const [b, m, v] of this.cond) if ((chunk[s + b] & m) !== v) return false;
        return true;
    }

    /**
     * Scan a chunk of whole samples. The trigger may not fire before global sample `armedFrom`
     * (= preTrigger, so the pre-trigger window is guaranteed to be full).
     * @returns {number} index of the trigger sample inside the chunk, or -1
     */
    scan(chunk, armedFrom) {
        const { unit, mask } = this;
        const n = (chunk.length / unit) | 0;
        const base = this.pos;
        const bi = this.byteIdx;
        let prev = this.prev, run = this.run, o = bi, hit = -1;

        if (this.kind === 'edge') {
            const from = this.from, to = this.to;
            for (let i = 0; i < n; i++, o += unit) {
                const cur = (chunk[o] & mask) !== 0 ? 1 : 0;
                if (prev === from && cur === to && base + i >= armedFrom && this.condOk(chunk, o - bi)) { hit = i; break; }
                prev = cur;
            }
        } else {
            // A pulse is measured from the edge that starts it, so a level that was already there when
            // the capture started never counts (its real length is unknown). Fires once, when the run
            // reaches exactly pulseLength samples.
            const level = this.level, len = this.pulseLength;
            for (let i = 0; i < n; i++, o += unit) {
                const cur = (chunk[o] & mask) !== 0 ? 1 : 0;
                if (prev === -1) run = 0;
                else if (cur !== prev) run = 1;
                else if (run > 0) run++;
                if (cur === level && run === len && base + i >= armedFrom && this.condOk(chunk, o - bi)) { hit = i; break; }
                prev = cur;
            }
        }

        this.pos = base + n;
        if (hit >= 0) { this.fireIndex = base + hit; return hit; }
        this.prev = prev; this.run = run;
        return -1;
    }
}

/* ============================== pre/post capture ============================== */

export class TriggerCapture {
    /**
     * @param {object} o   TriggerEngine options plus
     * @param {number} o.preTrigger   samples kept before the trigger
     * @param {number} o.postTrigger  samples collected after the trigger
     */
    constructor(o) {
        this.unit = o.unitSize;
        this.pre = o.preTrigger;
        this.post = o.postTrigger;
        this.engine = new TriggerEngine(o);

        this.ringCap = this.pre * this.unit;            // bytes
        this.ring = new Uint8Array(this.ringCap);
        this.head = 0;                                  // next write position
        this.filled = 0;                                // valid bytes in the ring

        this.state = 'armed';                           // 'armed' -> 'capturing' -> 'done'
        this.out = null;                                // final capture, allocated when the trigger fires
        this.outFilled = 0;                             // bytes written to out
        this.carry = EMPTY;                             // incomplete sample left over from the last chunk
    }

    /** Samples seen so far (for progress / diagnostics). */
    get samplesSeen() { return this.engine.pos; }

    /** Feed raw bytes (any length). Returns true once the capture is complete. */
    push(chunk) {
        if (this.state === 'done') return true;
        chunk = this._wholeSamples(chunk);
        let start = 0;

        if (this.state === 'armed') {
            const j = this.engine.scan(chunk, this.pre);
            if (j < 0) { this._ringPush(chunk, 0, chunk.length); return false; }

            const jb = j * this.unit;
            this._ringPush(chunk, 0, jb);                                   // everything before the trigger sample
            this.out = new Uint8Array((this.pre + 1 + this.post) * this.unit);
            this._ringExtract(this.out);                                    // oldest -> newest, exactly `pre` samples
            this.outFilled = this.ringCap;
            this.state = 'capturing';
            start = jb;                                                     // the trigger sample is the first post sample
        }

        const take = Math.min(this.out.length - this.outFilled, chunk.length - start);
        this.out.set(chunk.subarray(start, start + take), this.outFilled);
        this.outFilled += take;
        if (this.outFilled === this.out.length) { this.state = 'done'; return true; }
        return false;
    }

    /** The complete capture (state 'done'). */
    result() {
        return { data: this.out, samples: this.out.length / this.unit, trigger: this.pre };
    }

    /** What has been collected so far after the trigger fired (used when the capture is stopped early). */
    partial() {
        if (!this.out) return null;
        const bytes = this.outFilled - (this.outFilled % this.unit);
        return { data: this.out.subarray(0, bytes), samples: bytes / this.unit, trigger: this.pre };
    }

    _wholeSamples(chunk) {
        if (this.carry.length) {
            const merged = new Uint8Array(this.carry.length + chunk.length);
            merged.set(this.carry); merged.set(chunk, this.carry.length);
            chunk = merged; this.carry = EMPTY;
        }
        const rem = chunk.length % this.unit;
        if (rem) {
            this.carry = Uint8Array.from(chunk.subarray(chunk.length - rem));   // copy: the source buffer may be reused
            chunk = chunk.subarray(0, chunk.length - rem);
        }
        return chunk;
    }

    _ringPush(src, from, to) {
        const cap = this.ringCap, len = to - from;
        if (cap === 0 || len <= 0) return;
        if (len >= cap) {                                    // chunk alone fills the ring
            this.ring.set(src.subarray(to - cap, to), 0);
            this.head = 0; this.filled = cap;
            return;
        }
        const first = Math.min(len, cap - this.head);
        this.ring.set(src.subarray(from, from + first), this.head);
        if (len > first) this.ring.set(src.subarray(from + first, to), 0);
        this.head = (this.head + len) % cap;
        this.filled = Math.min(cap, this.filled + len);
    }

    _ringExtract(dst) {
        if (this.filled !== this.ringCap) throw new Error('pre-trigger window not full');   // cannot happen: trigger is armed at `pre`
        dst.set(this.ring.subarray(this.head), 0);
        dst.set(this.ring.subarray(0, this.head), this.ringCap - this.head);
    }
}

/* ============================== validation ============================== */

/** Device indexes of the captured channels, ascending (bit n of a sample = channel n), see channels.js.
 *  msg.channels: a list of channel indexes; without it (or with a count / list of names) channels 0 .. n-1. */
function capturedChannels(msg, info) {
    const c = msg.channels ?? info.channels;
    if (Array.isArray(c)) return c.every(Number.isInteger) ? c : c.map((_, i) => i);
    if (Number.isInteger(c) && c > 0) return Array.from({ length: c }, (_, i) => i);
    return [];
}

/** Returns a validated config or throws Error(message). */
export function parseTriggerConfig(msg, info) {
    const t = msg.triggerOn;
    if (!t || typeof t !== 'object') throw new Error('triggerOn is missing');
    // the trigger channel and the conditions name device channels, which are their bit in the stream
    // (bit n = channel n, see channels.js): they only have to be captured
    const captured = capturedChannels(msg, info);
    if (!captured.length) throw new Error('cannot determine the number of captured channels');
    const channelCount = captured.at(-1) + 1;
    const bitOf = (ch) => (captured.includes(ch) ? ch : -1);
    if (!Number.isInteger(t.channel) || bitOf(t.channel) < 0) throw new Error('bad trigger channel: it is not captured');
    if (!TRIGGER_TYPES.includes(t.type)) throw new Error('bad trigger type');
    let pulseLength = 0;
    if (t.type === 'PulseH' || t.type === 'PulseL') {
        pulseLength = t.pulseLength;
        if (!Number.isInteger(pulseLength) || pulseLength < 1) throw new Error('bad pulseLength');
    }
    const conditions = {};
    if (t.conditions !== undefined) {
        if (!t.conditions || typeof t.conditions !== 'object' || Array.isArray(t.conditions)) throw new Error('bad trigger conditions');
        for (const [key, level] of Object.entries(t.conditions)) {
            const ch = Number(key);
            if (!Number.isInteger(ch) || bitOf(ch) < 0 || ch === t.channel) throw new Error('bad trigger condition channel: it is not captured or it is the trigger channel');
            if (level !== 'lo' && level !== 'hi') throw new Error('bad trigger condition level');
            conditions[bitOf(ch)] = level;
        }
    }
    const preTrigger = msg.preTrigger ?? 0, postTrigger = msg.postTrigger ?? 0;
    if (!Number.isInteger(preTrigger) || preTrigger < 0) throw new Error('bad preTrigger');
    if (!Number.isInteger(postTrigger) || postTrigger < 0) throw new Error('bad postTrigger');
    if (msg.samplerate !== undefined && !(msg.samplerate > 0)) throw new Error('bad samplerate');
    const unitSize = sampleBytes(captured);
    if ((preTrigger * 2 + 1 + postTrigger) * unitSize > MAX_CAPTURE_BYTES) throw new Error('pre/post trigger too large');
    return { unitSize, channel: bitOf(t.channel), type: t.type, pulseLength, conditions, preTrigger, postTrigger, channelCount, samplerate: msg.samplerate };
}

/* ============================== glue to a device ============================== */

/**
 * Run `info.deviceKind` (same start/stop interface as DemoDevice / SigrokKind) continuously, wait for
 * the trigger and deliver the finished capture through onData / onDone like an ordinary capture.
 *
 *   onData(chunk, offsetInSamples)           the finished capture, in pieces, after the post-trigger is complete
 *   onDone({samples, samplerate, channels, trigger, stopped, ok})   trigger = sample index of the trigger
 *   onError(message, details?)               details: the device's extended message, passed on
 *   onStatus({state:'armed'|'triggered'})    optional
 *
 * @returns {{stop():void}|null}  null when the config was rejected (onError has been called)
 */
export function startTriggered(info, msg, { onData, onDone, onError, onStatus }) {
    let cfg;
    try { cfg = parseTriggerConfig(msg, info); }
    catch (err) { onError(err.message); return null; }

    const kind = info.deviceKind;
    const cap = new TriggerCapture(cfg);
    let finished = false, userStopped = false;

    // the device runs until we stop it: it must not be given a sample count
    const deviceMsg = { ...msg };
    for (const k of ['samplecount', 'triggerOn', 'preTrigger', 'postTrigger']) delete deviceMsg[k];

    const deliver = (res, stopped) => {
        finished = true;
        try { kind.stop(); } catch (err) { console.warn('device stop failed:', err); }
        const step = STREAM_SAMPLES * cfg.unitSize;
        for (let off = 0; off < res.data.length; off += step) {
            onData(res.data.subarray(off, Math.min(off + step, res.data.length)), off / cfg.unitSize);
        }
        onDone({
            samples: res.samples,
            ...(cfg.samplerate !== undefined && { samplerate: cfg.samplerate }),
            channels: cfg.channelCount,
            trigger: res.trigger,
            stopped,
            ok: true,
        });
    };

    onStatus?.({ state: 'armed' });
    kind.start(
        deviceMsg,
        /* onData */
        (chunk) => {
            if (finished) return;                            // the device may still flush data after stop()
            const wasArmed = cap.state === 'armed';
            const complete = cap.push(chunk);
            if (wasArmed && cap.state !== 'armed') onStatus?.({ state: 'triggered', sample: cap.engine.fireIndex });
            if (complete) deliver(cap.result(), false);
        },
        /* onDone: the device ended by itself (or after our stop()) */
        () => {
            if (finished) return;
            if (cap.state === 'capturing') { deliver(cap.partial(), userStopped); return; }
            finished = true;
            if (!userStopped) onError('capture ended before the trigger fired');
        },
        /* onError */
        (message, details) => { if (finished) return; finished = true; onError(message, details); },
    );

    return {
        stop() {
            if (finished) return;
            userStopped = true;
            if (cap.state === 'capturing') deliver(cap.partial(), true);   // keep what we have: pre + trigger + partial post
            else { finished = true; try { kind.stop(); } catch { /* ignore */ } }   // never triggered: nothing to deliver
        },
    };
}
