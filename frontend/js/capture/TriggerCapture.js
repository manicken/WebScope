/**
 * TriggerCapture.js — software trigger for a source that cannot trigger itself (DemoSource).
 * The same trigger as backend/trigger.js, on the frontend's samples (one array element per sample,
 * channel n = bit n) instead of packed bytes. A source that triggers itself (WebSocketSource: the
 * backend does it) only sends the finished capture instead.
 *
 * The capture = preTrigger samples, the trigger sample, postTrigger samples; the trigger sample is
 * at index preTrigger. The trigger may not fire before preTrigger samples were seen, so the
 * pre-trigger part is always complete.
 *
 *   push(samples)   returns the samples that belong to the capture: nothing while armed; once the
 *                   trigger fired, the pre-trigger samples + the trigger sample + what followed it,
 *                   then every later chunk as it is. The caller stops after pre + 1 + post samples.
 *   triggered       true once the trigger fired
 *
 * Trigger types (= the backend's): 'L2H' rising edge, 'H2L' falling edge, 'PulseH' / 'PulseL' the
 * level has been held for pulseLength samples, measured from the edge that started it.
 * conditions = { channelIndex: 'lo' | 'hi' }: levels other channels must have at the trigger sample.
 */
class TriggerCapture {
    constructor({ channel, type, pulseLength = 0, conditions = {}, preTrigger, sampleType }) {
        this.mask = (1 << channel) >>> 0;
        this.edge = type === 'L2H' || type === 'H2L';
        this.from = type === 'L2H' ? 0 : 1;          // edge: level before / after the transition
        this.to = type === 'L2H' ? 1 : 0;
        this.level = type === 'PulseH' ? 1 : 0;      // pulse: level that has to be held
        this.pulseLength = pulseLength;

        this.condMask = 0; this.condValue = 0;
        for (const [ch, level] of Object.entries(conditions)) {
            const m = (1 << Number(ch)) >>> 0;
            this.condMask = (this.condMask | m) >>> 0;
            if (level === 'hi') this.condValue = (this.condValue | m) >>> 0;
        }

        this.pre = preTrigger;
        this.type = sampleType;
        this.ring = new sampleType(preTrigger);      // the newest `pre` samples while armed
        this.head = 0;                               // next write position
        this.filled = 0;

        this.prev = -1;      // level of the previous sample, -1 = no sample seen yet
        this.run = 0;        // length of the current level, counted from an observed edge (0 = start unknown)
        this.pos = 0;        // samples seen so far
        this.triggered = false;
    }

    push(samples) {
        if (this.triggered) return samples;
        const j = this._scan(samples);
        if (j < 0) { this._ringPush(samples); return samples.subarray(0, 0); }

        this._ringPush(samples.subarray(0, j));      // everything before the trigger sample
        this.triggered = true;
        const out = new this.type(this.pre + samples.length - j);
        out.set(this.ring.subarray(this.head), 0);   // oldest -> newest
        out.set(this.ring.subarray(0, this.head), this.pre - this.head);
        out.set(samples.subarray(j), this.pre);
        return out;
    }

    /** Index of the trigger sample in `samples`, or -1. */
    _scan(samples) {
        const { mask, condMask, condValue, pre } = this;
        const n = samples.length, base = this.pos;
        let prev = this.prev, run = this.run, hit = -1;
        for (let i = 0; i < n; i++) {
            const s = samples[i];
            const cur = (s & mask) !== 0 ? 1 : 0;
            let fire;
            if (this.edge) {
                fire = prev === this.from && cur === this.to;
            } else {
                // a level that was already there when the capture started never counts (its length is unknown)
                if (prev === -1) run = 0;
                else if (cur !== prev) run = 1;
                else if (run > 0) run++;
                fire = cur === this.level && run === this.pulseLength;
            }
            if (fire && base + i >= pre && ((s & condMask) >>> 0) === condValue) { hit = i; break; }
            prev = cur;
        }
        this.pos = base + n;
        this.prev = prev; this.run = run;
        return hit;
    }

    _ringPush(src) {
        const cap = this.pre, len = src.length;
        if (cap === 0 || len === 0) return;
        if (len >= cap) {                            // the chunk alone fills the ring
            this.ring.set(src.subarray(len - cap), 0);
            this.head = 0; this.filled = cap;
            return;
        }
        const first = Math.min(len, cap - this.head);
        this.ring.set(src.subarray(0, first), this.head);
        if (len > first) this.ring.set(src.subarray(first), 0);
        this.head = (this.head + len) % cap;
        this.filled = Math.min(cap, this.filled + len);
    }
}
