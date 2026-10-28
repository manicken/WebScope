    const CHUNK = 512;

/**
 * The samples of one capture.
 *
 * A complete buffer (a loaded file, a finished capture) is plain linear data that never changes:
 * samples[0 .. length-1], which is what the decoders read. New data is a new CaptureBuffer.
 *
 * While a capture streams in, a new buffer with complete:false is made for every screen update.
 * It is a view on the capture's storage (capture/CaptureStorage.js), so its data can still change:
 *   - `previous`  the last live buffer, whose finished chunk summaries are reused
 *   - `chunks`    chunk summaries kept by the storage instead of computed here
 *   - `start`     ring storage: index in `samples` of sample 0, the data wraps at samples.length
 *                 (a multiple of CHUNK, and `start` is too). Use get(i), not samples[i].
 *
 * Sample i was sample number firstSample + i of the capture (looping drops the oldest samples),
 * and the time axis starts at the capture's first sample: see timeOrigin.
 *
 * `captured`: bit mask of the channels the capture holds (bit n = channel n); the others were not
 * captured and have no data, see has(). Default: all channelCount channels (a loaded file).
 */
class CaptureBuffer {
    constructor(samples, samplerate, channelCount, trigger = null,
                { complete = true, previous = null, length = samples.length, start = 0, chunks = null, firstSample = 0,
                  captured = channelCount >= 32 ? 0xffffffff : 2 ** channelCount - 1 } = {}) {
        this.samples = samples; // 1 element/sample, 1 bit/channel: see CaptureBuffer.sampleType()
        this.samplerate = samplerate;
        this.channelCount = channelCount;
        this.trigger = trigger; // sample index of the trigger, or null
        this.complete = complete; // false while the capture is still streaming in
        this.length = length;
        this.start = start;
        this.firstSample = firstSample;
        this.captured = captured >>> 0;
        this.chunkCount = Math.ceil(length / CHUNK);
        this.chunks = chunks ?? this._buildChunks(previous);
    }

    /** The smallest array type that holds one sample of `channelCount` channels (1 bit each). */
    static sampleType(channelCount) {
        return channelCount <= 8 ? Uint8Array : channelCount <= 16 ? Uint16Array : Uint32Array;
    }

    /** The capture holds data of channel ch. */
    has(ch) {
        return ch >= 0 && ch < 32 && ((this.captured >>> ch) & 1) === 1;
    }

    /** Sample index where the time axis is 0: the trigger, else the capture's first sample. */
    get timeOrigin() {
        return (this.trigger ?? 0) - this.firstSample;
    }

    _buildChunks(previous) {
        const n = this.length;
        // the previous buffer's full chunks hold the same samples; its last one may have grown since
        const reuse = previous ? Math.min(Math.floor(previous.length / CHUNK), Math.floor(n / CHUNK)) : 0;
        const chunks = reuse ? previous.chunks.slice(0, reuse) : [];
        for (let start = reuse * CHUNK; start < n; start += CHUNK) {
            chunks.push(CaptureBuffer.summarize(this.samples, start, Math.min(n, start + CHUNK)));
        }
        return chunks;
    }

    /** { first, last, toggle } of samples[from .. to-1]: toggle has a bit set for every channel that changed. */
    static summarize(samples, from, to) {
        let toggle = 0;
        for (let i = from + 1; i < to; i++) {
            toggle |= (samples[i] ^ samples[i - 1]);
        }
        return { first: samples[from], last: samples[to - 1], toggle };
    }

    /** Sample i (0 <= i < length). */
    get(i) {
        if (this.start === 0) return this.samples[i];
        const j = this.start + i;
        return this.samples[j < this.samples.length ? j : j - this.samples.length];
    }

    /** Summary of chunk k, which holds samples k*CHUNK .. (k+1)*CHUNK-1. */
    chunk(k) {
        if (this.start === 0) return this.chunks[k];
        return this.chunks[(this.start / CHUNK + k) % this.chunks.length];
    }

    at(i) { return this.get(Math.max(0, Math.min(this.length - 1, i))); }

    /** Per-pixel-column [first, toggleMask] pairs for the level-of-detail waveform. */
    render(start, sppPerCol, cols) {
        const out = new Uint32Array(cols * 2);
        for (let c = 0; c < cols; c++) {
            const s0 = start + c * sppPerCol, s1 = s0 + sppPerCol;
            const i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(this.length, Math.ceil(s1));
            if (i0 >= this.length || i1 <= 0 || i1 <= i0) {
                out[2 * c] = this.at(i0);
                continue;
            }
            const first = this.at(i0);
            let toggle = 0;
            if (i1 - i0 <= CHUNK * 2) {
                let prev = first;
                for (let i = i0 + 1; i < i1; i++) {
                    const v = this.get(i);
                    toggle |= (v ^ prev);
                    prev = v;
                }
            } else {
                const k0 = Math.floor(i0 / CHUNK), k1 = Math.min(this.chunkCount - 1, Math.floor((i1 - 1) / CHUNK));
                for (let k = k0; k <= k1; k++) {
                    toggle |= this.chunk(k).toggle;
                    if (k > k0) {
                        toggle |= (this.chunk(k - 1).last ^ this.chunk(k).first);
                    }
                }
            }
            out[2 * c] = first; out[2 * c + 1] = toggle;
        }
        return out;
    }

    /** Raw samples for the exact-step waveform (zoomed below 1 sample/px). */
    rawSlice(first, count) {
        const start = Math.max(0, first), end = Math.min(this.length, first + count);
        const data = new Uint32Array(Math.max(0, end - start));
        for (let i = 0; i < data.length; i++) data[i] = this.get(start + i);
        return { first: start, data };
    }

    findEdge(channel, from, forward) {
        const bit = 1 << channel;
        let i = Math.round(from);
        if (i < 0 || i >= this.length) return null;
        let prev = this.at(i) & bit;
        i += forward ? 1 : -1;
        while (i >= 0 && i < this.length) {
            const v = this.get(i) & bit;
            if (v !== prev) return i;
            i += forward ? 1 : -1;
        }
        return null;
    }

    /**
     * All edges of one channel in [from, to]: { pos: [i…], rising: [0|1…] }. An edge at i means
     * sample i differs from sample i-1 (same convention as findEdge). Whole chunks without any
     * activity on the channel are skipped using the per-chunk toggle masks.
     */
    edges(channel, from, to) {
        const bit = 1 << channel, n = this.length;
        const hi = Math.min(n - 1, Math.floor(to));
        const pos = [], rising = [];
        let i = Math.max(1, Math.ceil(from));
        while (i <= hi) {
            if (i % CHUNK === 0 && i + CHUNK - 1 <= hi) {
                const k = i / CHUNK, c = this.chunk(k);
                if (c && !(c.toggle & bit) && !((this.chunk(k - 1).last ^ c.first) & bit)) { i += CHUNK; continue; }
            }
            const v = this.get(i) & bit;
            if (v !== (this.get(i - 1) & bit)) { pos.push(i); rising.push(v ? 1 : 0); }
            i++;
        }
        return { pos, rising };
    }

    measure(channel, sample) {
        const bit = 1 << channel;
        const i = Math.max(0, Math.min(this.length - 1, Math.round(sample)));
        const high = !!(this.get(i) & bit);
        let start = this.findEdge(channel, i, false); start = start === null ? 0 : start;
        let end = this.findEdge(channel, i, true); end = end === null ? this.length - 1 : end;
        let period = null, highTime = null;
        const prevEdge = this.findEdge(channel, start, false);
        if (prevEdge !== null) {
            period = end - prevEdge;
            highTime = high ? end - start : start - prevEdge;
        }
        return { high, start, end, period, highTime };
    }

    burstAt(channel, sample, maxGap, tolerance) {
        const i = Math.max(0, Math.min(this.length - 1, Math.round(sample)));
        let lo = i, hi = i;
        let e = this.findEdge(channel, i, false);
        while (e !== null && (i - e) <= tolerance + maxGap) {
            lo = e;
            const next = this.findEdge(channel, e, false);
            if (next === null || (e - next) > maxGap) break;
            e = next;
        }
        e = this.findEdge(channel, i, true);
        while (e !== null && (e - i) <= tolerance + maxGap) {
            hi = e;
            const next = this.findEdge(channel, e, true);
            if (next === null || (next - e) > maxGap) break;
            e = next;
        }
        if (lo === i && hi === i) return null;
        return { start: lo, end: hi };
    }
}
