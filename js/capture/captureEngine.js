/**
 * captureEngine.js — the capture's sample buffer and queries over it. Runs locally in the
 * browser against a plain sample buffer (one Uint32Array word per sample, one bit per channel).
 * Decoding lives in decoders/decoderEngine.js, annotation queries in annotations/annotationEngine.js;
 * both add their methods to the shared WS.engine object created here.
 *
 * LOD strategy: samples are grouped into fixed-size chunks; each chunk stores {first, last,
 * toggleMask}. render() scans raw samples for narrow columns and falls back to merging chunk
 * summaries for wide columns, using toggle = L.toggle | R.toggle | (L.last ^ R.first). This is
 * a single-level version of the summary tree edgewise's Rust core builds recursively — good
 * enough up to a few million samples; for much larger captures, make chunks-of-chunks the same
 * way to keep render() sublinear at any zoom.
 */
(function (WS) {
  'use strict';

  const CHUNK = 512;

  class CaptureBuffer {
    constructor(samples, samplerate, channelCount) {
      this.samples = samples; // Uint32Array, 1 word/sample, 1 bit/channel
      this.samplerate = samplerate;
      this.channelCount = channelCount;
      this.length = samples.length;
      this._buildChunks();
    }

    _buildChunks() {
      const n = this.length, chunks = [];
      for (let start = 0; start < n; start += CHUNK) {
        const end = Math.min(n, start + CHUNK);
        let toggle = 0;
        for (let i = start + 1; i < end; i++) toggle |= (this.samples[i] ^ this.samples[i - 1]);
        chunks.push({ first: this.samples[start], last: this.samples[end - 1], toggle });
      }
      this.chunks = chunks;
    }

    at(i) { return this.samples[Math.max(0, Math.min(this.length - 1, i))]; }

    /** Per-pixel-column [first, toggleMask] pairs for the level-of-detail waveform. */
    render(start, sppPerCol, cols) {
      const out = new Uint32Array(cols * 2);
      for (let c = 0; c < cols; c++) {
        const s0 = start + c * sppPerCol, s1 = s0 + sppPerCol;
        const i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(this.length, Math.ceil(s1));
        if (i0 >= this.length || i1 <= 0 || i1 <= i0) { out[2 * c] = this.at(i0); continue; }
        const first = this.at(i0);
        let toggle = 0;
        if (i1 - i0 <= CHUNK * 2) {
          for (let i = i0 + 1; i < i1; i++) toggle |= (this.samples[i] ^ this.samples[i - 1]);
        } else {
          const k0 = Math.floor(i0 / CHUNK), k1 = Math.min(this.chunks.length - 1, Math.floor((i1 - 1) / CHUNK));
          for (let k = k0; k <= k1; k++) {
            toggle |= this.chunks[k].toggle;
            if (k > k0) toggle |= (this.chunks[k - 1].last ^ this.chunks[k].first);
          }
        }
        out[2 * c] = first; out[2 * c + 1] = toggle;
      }
      return out;
    }

    /** Raw samples for the exact-step waveform (zoomed below 1 sample/px). */
    rawSlice(first, count) {
      const start = Math.max(0, first), end = Math.min(this.length, first + count);
      return { first: start, data: this.samples.slice(start, Math.max(start, end)) };
    }

    findEdge(channel, from, forward) {
      const bit = 1 << channel;
      let i = Math.round(from);
      if (i < 0 || i >= this.length) return null;
      let prev = this.at(i) & bit;
      i += forward ? 1 : -1;
      while (i >= 0 && i < this.length) {
        const v = this.samples[i] & bit;
        if (v !== prev) return i;
        i += forward ? 1 : -1;
      }
      return null;
    }

    measure(channel, sample) {
      const bit = 1 << channel;
      const i = Math.max(0, Math.min(this.length - 1, Math.round(sample)));
      const high = !!(this.samples[i] & bit);
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

  let buffer = null; // CaptureBuffer | null

  const engine = {
    hasData: () => !!buffer,
    setBuffer(b) { buffer = b; },
    render(start, spp, width) { return buffer ? buffer.render(start, spp, width) : new Uint32Array(width * 2); },
    samples(start, count) { return buffer ? buffer.rawSlice(start, count) : { first: 0, data: new Uint32Array(0) }; },
    measure(channel, sample) { return buffer ? buffer.measure(channel, sample) : null; },
    findEdge(channel, from, forward) { return buffer ? buffer.findEdge(channel, from, forward) : null; },
    burstAt(channel, sample, maxGap, tol) { return buffer ? buffer.burstAt(channel, sample, maxGap, tol) : null; },
    getBuffer: () => buffer
  };

  WS.CaptureBuffer = CaptureBuffer;
  WS.engine = engine;
})(window.WS = window.WS || {});
