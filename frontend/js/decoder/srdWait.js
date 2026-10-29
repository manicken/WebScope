/**
 * srdWait.js — the wait() of libsigrokdecode (decoder API version 3) over a WebScope capture buffer, so
 * decoders ported from sigrok can keep their state machines as they are.
 *
 *   const w = new SrdWait(buf, [cfg.sck, cfg.ws, cfg.sd]);   // the decoder's channels, in sigrok's order
 *   let pins = w.wait({ 0: 'r' });                           // [sck, ws, sd] at the matching sample
 *   pins = w.wait([{ skip: 100 }, { 0: 'f' }]);              // whichever comes first
 *   if (w.matched[1]) ...                                    // which of the conditions matched
 *   w.samplenum                                              // the sample that matched
 *
 * Conditions per channel (key = the channel's position in the list): 'l' low, 'h' high, 'r' rising edge,
 * 'f' falling edge, 'e' either edge, 's' stable (no edge); { skip: n }: n samples further on. All keys of
 * one condition must match; of several conditions, one is enough. wait() with no condition is the next
 * sample. The first wait() starts at sample 0, every later one at the sample after the last match.
 * At the end of the data wait() returns null: the decoder stops there (sigrok ends the decoder with an
 * EOFError).
 */
class SrdWait {
    /**
     * @param buf       a CaptureBuffer (complete data)
     * @param channels  capture bit (channel index) of each of the decoder's channels; null = not used
     */
    constructor(buf, channels) {
        this.buf = buf;
        this.channels = channels;
        this.samplenum = 0;
        this.matched = [];
        this.started = false;
        this.samplerate = buf.samplerate;
    }

    /** The decoder's pins at sample i: [0 | 1, ...] (null for a channel that is not used). */
    pins(i) {
        const v = this.buf.get(i);
        return this.channels.map((ch) => (ch == null ? null : (v >>> ch) & 1));
    }

    wait(conds = []) {
        const list = (Array.isArray(conds) ? conds : [conds]).map((c) => Object.entries(c));
        const n = this.buf.length;
        const from = this.started ? this.samplenum + 1 : 0;
        const base = this.samplenum;   // skip counts from the sample the decoder is at
        this.started = true;
        if (list.length === 0) list.push([]);   // no condition: the next sample

        const chOf = this.channels;
        let prev = from > 0 ? this.buf.get(from - 1) : null;
        for (let i = from; i < n; i++) {
            const v = this.buf.get(i);
            const matched = list.map((terms) => terms.every(([key, want]) => {
                if (key === 'skip') return i >= base + want;
                const ch = chOf[key];
                const bit = (v >>> ch) & 1;
                if (want === 'l') return bit === 0;
                if (want === 'h') return bit === 1;
                if (prev === null) return want === 's';   // no edge at the first sample
                const was = (prev >>> ch) & 1;
                if (want === 'r') return was === 0 && bit === 1;
                if (want === 'f') return was === 1 && bit === 0;
                if (want === 'e') return was !== bit;
                if (want === 's') return was === bit;
                throw new Error(`srdWait: unknown condition '${want}'`);
            }));
            if (matched.some(Boolean)) {
                this.samplenum = i;
                this.matched = matched;
                return this.pins(i);
            }
            prev = v;
        }
        this.samplenum = n;
        this.matched = list.map(() => false);
        return null;
    }
}
