/**
 * captureEngine.js — the capture's sample buffer and queries over it. Runs locally in the
 * browser against a plain sample buffer (one array element per sample, one bit per channel).
 * Decoding lives in decoders/decoderEngine.js, annotation queries in annotations/annotationEngine.js;
 * 
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

    const { appState, makeChannels, toast } = WS;
    const { acquisition } = appState;

    /** The data on screen. Set when a file is loaded, and once per frame while a capture streams in
     *  (buffer.complete is false until the capture is done). Subscribers read samplerate, length and
     *  trigger from the buffer itself. */
    const buffer = new ReactiveValue(null);

    /* ---- capture orchestration ---- */
    let activeSource = null;
    let storage = null;  // LinearStorage | RingStorage the running capture writes to, see CaptureStorage.js
    let meta = null;     // { samplerate, channelCount } of the running capture
    let live = false;    // a capture is streaming in
    let showPending = false;

    const liveBuffer = () => (buffer.value?.complete === false ? buffer.value : null);

    /** Shows what has been received so far, at most once per frame (chunks can arrive much faster). */
    function requestShowLive() {
        if (showPending) return;
        showPending = true;
        requestAnimationFrame(() => {
            showPending = false;
            if (live && storage.length > 0) setBuffer(storage.liveBuffer(meta, liveBuffer()));
        });
    }

    /** The capture ended (done, stopped, or the memory is full): show what was received as a complete buffer. */
    function finish() {
        live = false;
        if (storage.length > 0) setBuffer(storage.finalBuffer(meta, liveBuffer()));
        storage = null;
    }

    /** Shows the new data. The channels are recreated only when the channel count changed. */
    function setBuffer(buf) {
        if (buf && appState.channels.value.length !== buf.channelCount) {
            appState.channels.set(makeChannels({ count: buf.channelCount }));
        }
        buffer.set(buf);
    }

    /** The storage for a capture: Looping keeps the newest samples, the other modes stop when it is full.
     *  A sample takes 1, 2 or 4 bytes depending on the channel count, so 8 channels fit 4x more samples. */
    function makeStorage({ mode, total, memoryBytes, channelCount }) {
        const type = CaptureBuffer.sampleType(channelCount);
        const memorySamples = Math.floor(memoryBytes / type.BYTES_PER_ELEMENT);
        if (mode === 'looping') return new RingStorage(type, memorySamples);
        if (total !== undefined) return new LinearStorage(type, total);                            // timer, trigger
        return new LinearStorage(type, Math.min(memorySamples, 1 << 20), memorySamples);          // one shot
    }

    /** One value per sample. A source sends either that (DemoSource) or raw bytes (WebSocketSource),
     *  where a sample is 1, 2 or 4 bytes depending on the channel count. */
    function toSamples(chunk, channelCount) {
        const type = CaptureBuffer.sampleType(channelCount);
        if (chunk.BYTES_PER_ELEMENT !== 1 || type === Uint8Array) return chunk;
        const n = Math.floor(chunk.byteLength / type.BYTES_PER_ELEMENT);
        if (chunk.byteOffset % type.BYTES_PER_ELEMENT === 0) return new type(chunk.buffer, chunk.byteOffset, n);
        return new type(chunk.slice(0, n * type.BYTES_PER_ELEMENT).buffer);
    }

    /**
     * cfg = { mode, samplerate, channels, duration?, memoryBytes, ...source specific }
     * duration (s) is set for Timer and Trigger; memoryBytes limits Looping and One shot.
     */
    function startCapture(source, cfg) {
        const { mode, samplerate, duration, channels, memoryBytes } = cfg;
        const total = duration ? Math.max(64, Math.round(samplerate * duration)) : undefined;
        const channelCount = Array.isArray(channels) ? channels.length : channels;
        if (channelCount > 32) console.warn("channel count capped at 32");
        try {
            storage = makeStorage({ mode, total, memoryBytes, channelCount });
        } catch (e) {
            // e.g. RangeError: more memory than the browser can give one array
            toast(`Cannot allocate the capture memory: ${e.message}`);
            return;
        }
        meta = { samplerate, channelCount };
        live = true;
        appState.view.follow.set(true);
        appState.markers.selected.set(null);
        appState.markers.list.set([]);
        appState.selections.selected.set(null);
        appState.selections.list.set([]);
        appState.pointer.measurement.set(null);
        acquisition.state.set('running');
        activeSource = source;
        activeSource.start(
            { ...cfg, samplecount:total, channels:channelCount },
            /* onData: chunks arrive in order, the source's offset is not needed */
            (chunk) => {
                if (!live) return;
                const samples = toSamples(chunk, channelCount);
                const written = storage.write(samples);
                requestShowLive();
                if (written < samples.length) {
                    if (total === undefined) stopCapture();       // one shot: the memory is full
                    else console.warn(`capture overflow: ${samples.length - written} samples more than the ${total} expected`);
                }
            },
            /* onDone */
            () => {
                if (!live) return; // already stopped by the user
                finish();
                acquisition.state.set('done');
            },
            /* onError */
            (msg) => { live = false; acquisition.message.set(msg); acquisition.state.set('error'); toast(msg); }
        );
    }

    function stopCapture() {
        activeSource?.stop();
        if (!live) return;
        const received = storage.length;
        finish();
        acquisition.state.set(received > 0 ? 'done' : 'idle');
    }

    const buf = () => buffer.value;

    WS.capture = WS.capture ?? {};
    Object.assign(WS.capture, {
        buffer,
        startCapture, 
        stopCapture,
        setBuffer,
        hasData: () => !!buf(),
        /** samples in the buffer, 0 without data */
        length: () => buf()?.length ?? 0,
        render(start, spp, width) { return buf() ? buf().render(start, spp, width) : new Uint32Array(width * 2); },
        samples(start, count) { return buf() ? buf().rawSlice(start, count) : { first: 0, data: new Uint32Array(0) }; },
        measure(channel, sample) { return buf() ? buf().measure(channel, sample) : null; },
        findEdge(channel, from, forward) { return buf() ? buf().findEdge(channel, from, forward) : null; },
        edges(channel, from, to) { return buf() ? buf().edges(channel, from, to) : { pos: [], rising: [] }; },
        burstAt(channel, sample, maxGap, tol) { return buf() ? buf().burstAt(channel, sample, maxGap, tol) : null; },
        getBuffer: buf,
    });
})(window.WS = window.WS || {});
