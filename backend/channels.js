// channels.js — the channels a capture uses.
//
// The start message may carry `channels: [0, 1, 2, 5]`, the device channel indexes to capture (the
// `index` of the device info's channels), ascending. Without it every channel is captured.
// The data sent to the browser holds only those channels: bit k of a sample = the k-th listed
// channel, ceil(n / 8) bytes per sample.

/** All channel indexes of a device: info.channels is a list of { index, ... } or a count. */
function allChannels(info) {
    const c = info.channels;
    if (Array.isArray(c)) return c.map((ch, i) => (Number.isInteger(ch?.index) ? ch.index : i));
    return Array.from({ length: Number.isInteger(c) && c > 0 ? c : 0 }, (_, i) => i);
}

/** The validated channel list of a start message (all channels when it has none). Throws Error(message). */
export function resolveChannels(msg, info) {
    const all = allChannels(info);
    if (msg.channels === undefined) return all;
    const list = msg.channels;
    if (!Array.isArray(list) || list.length === 0) throw new Error('channels must be a non-empty list of channel indexes');
    const known = new Set(all);
    list.forEach((ch, k) => {
        if (!Number.isInteger(ch) || !known.has(ch)) throw new Error(`the device has no channel ${ch}`);
        if (k > 0 && ch <= list[k - 1]) throw new Error('channels must be ascending, without duplicates');
    });
    return list;
}

/**
 * Repacks whole samples: bit k of an output sample = bit bits[k] of the input sample.
 * @param {number} srcUnit  bytes per input sample
 * @param {number[]} bits   input bit of every output channel
 * @returns {{ dstUnit:number, run(src:Uint8Array):Uint8Array }}
 */
export function makeRepacker(srcUnit, bits) {
    const dstUnit = Math.max(1, Math.ceil(bits.length / 8));
    if (dstUnit === srcUnit && bits.length === srcUnit * 8 && bits.every((b, k) => b === k)) {
        return { dstUnit, run: (src) => src };          // already in the right layout
    }
    // per input byte: its 256 values -> the output bits they set
    const luts = Array.from({ length: srcUnit }, () => new Int32Array(256));
    bits.forEach((b, k) => {
        const lut = luts[b >> 3], m = 1 << (b & 7);
        for (let v = 0; v < 256; v++) if (v & m) lut[v] |= 1 << k;
    });
    return {
        dstUnit,
        run(src) {
            const n = (src.length / srcUnit) | 0;
            const out = new Uint8Array(n * dstUnit);
            for (let i = 0, s = 0, d = 0; i < n; i++, s += srcUnit, d += dstUnit) {
                let w = 0;
                for (let j = 0; j < srcUnit; j++) w |= luts[j][src[s + j]];
                for (let j = 0; j < dstUnit; j++) out[d + j] = w >>> (8 * j);
            }
            return out;
        },
    };
}
