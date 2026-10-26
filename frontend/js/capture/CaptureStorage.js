/**
 * CaptureStorage.js — where a running capture's samples are written while they stream in.
 *
 *   LinearStorage  fixed size (Timer, Trigger) or growing up to a maximum (One shot)
 *   RingStorage    a fixed amount of memory that keeps the newest samples (Looping)
 *
 * Both:
 *   write(samples)            appends samples (any typed array, one value per sample); returns how
 *                             many fitted. When fewer than given fitted, the storage is full.
 *   length                    samples stored
 *   liveBuffer(meta, prev)    CaptureBuffer (complete:false) showing the data so far; `prev` is the
 *                             previous live buffer
 *   finalBuffer(meta, prev)   plain linear CaptureBuffer (complete:true), when the capture ended
 * meta = { samplerate, channelCount }
 * `type` is the array type of one sample (Uint8Array for up to 8 channels, see CaptureBuffer.sampleType),
 * capacities are in samples.
 */

class LinearStorage {
    /** `capacity` samples to start with; grows (doubles) up to `maxCapacity`. */
    constructor(type, capacity, maxCapacity = capacity) {
        this.type = type;
        this.samples = new type(Math.max(1, Math.min(capacity, maxCapacity)));
        this.maxCapacity = maxCapacity;
        this.length = 0;
    }

    write(src) {
        const need = this.length + src.length;
        if (need > this.samples.length && this.samples.length < this.maxCapacity) {
            const grown = new this.type(Math.min(this.maxCapacity, Math.max(need, this.samples.length * 2)));
            grown.set(this.samples.subarray(0, this.length));
            this.samples = grown;
        }
        const n = Math.min(src.length, this.samples.length - this.length);
        this.samples.set(n === src.length ? src : src.subarray(0, n), this.length);
        this.length += n;
        return n;
    }

    liveBuffer({ samplerate, channelCount }, previous) {
        // a view, not a copy: a frame only costs the chunks that arrived since the last one
        return new CaptureBuffer(this.samples.subarray(0, this.length), samplerate, channelCount, null, { complete: false, previous });
    }

    finalBuffer({ samplerate, channelCount }, previous) {
        return new CaptureBuffer(this.samples.slice(0, this.length), samplerate, channelCount, null, { previous });
    }
}

/**
 * A true ring: the write position wraps around and nothing is moved while capturing. The memory
 * is divided in chunks of CHUNK samples; when the writing reaches the oldest chunk, that whole chunk
 * is dropped (so between capacity-CHUNK and capacity samples are kept). Each chunk's summary is
 * updated as it is written, so a live buffer needs no work besides wrapping its indexes.
 * finalBuffer() rotates the memory in place so the data starts at index 0.
 */
class RingStorage {
    constructor(type, capacity) {
        const chunkCount = Math.max(2, Math.ceil(capacity / CHUNK));
        this.samples = new type(chunkCount * CHUNK);
        this.chunks = new Array(chunkCount);   // summary per chunk of memory, in memory order
        this.start = 0;                        // memory index of the oldest sample (chunk aligned)
        this.end = 0;                          // memory index where the next sample is written
        this.length = 0;
        this.dropped = 0;                      // samples dropped from the start, = firstSample
    }

    write(src) {
        const cap = this.samples.length;
        let i = 0;
        while (i < src.length) {
            if (this.length > 0 && this.end === this.start) {
                // the ring is full and the writing reaches the oldest chunk: drop it
                this.start = (this.start + CHUNK) % cap;
                this.length -= CHUNK;
                this.dropped += CHUNK;
            }
            const chunkStart = this.end - (this.end % CHUNK);
            const n = Math.min(chunkStart + CHUNK - this.end, src.length - i);
            this.samples.set(src.subarray(i, i + n), this.end);
            this.end += n;
            this.chunks[chunkStart / CHUNK] = CaptureBuffer.summarize(this.samples, chunkStart, this.end);
            if (this.end === cap) this.end = 0;
            this.length += n;
            i += n;
        }
        return src.length;
    }

    liveBuffer({ samplerate, channelCount }) {
        return new CaptureBuffer(this.samples, samplerate, channelCount, null, {
            complete: false, length: this.length, start: this.start, chunks: this.chunks, firstSample: this.dropped,
        });
    }

    finalBuffer({ samplerate, channelCount }) {
        const s = this.samples, k0 = this.start / CHUNK;
        if (this.start > 0) {
            // rotate left by `start`, in place: reverse both parts, then the whole
            s.subarray(0, this.start).reverse();
            s.subarray(this.start).reverse();
            s.reverse();
        }
        const count = Math.ceil(this.length / CHUNK);
        const chunks = Array.from({ length: count }, (_, k) => this.chunks[(k0 + k) % this.chunks.length]);
        this.start = 0;
        return new CaptureBuffer(s.subarray(0, this.length), samplerate, channelCount, null, { chunks, firstSample: this.dropped });
    }
}
