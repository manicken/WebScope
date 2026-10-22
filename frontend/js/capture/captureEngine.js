/**
 * captureEngine.js — the capture's sample buffer and queries over it. Runs locally in the
 * browser against a plain sample buffer (one Uint32Array word per sample, one bit per channel).
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

    const { makeChannels, toast } = WS.store;
    const { store } = WS;

    let buffer = null;

    /* ---- capture orchestration ---- */
    let activeSource = null;
    let growing = null; // Uint32Array being filled while a capture streams in

    function startCapture(source, {samplerate, duration, channels} = {}) {
        const total = Math.max(64, Math.round(samplerate * duration));
        growing = new Uint32Array(total);
        store.set({
        follow: true, markers: { a: null, b: null }, markers: [], selectedMarker: null, selections: [], selectedSelection: null, measurement: null,
        status: { ...store.get().status, state: 'running', sampleCount: 0, samplerate, captureId: store.get().status.captureId + 1 }
        });
        activeSource = source;
        const channelCount = Array.isArray(channels)?channels.length:channels;
        const sampleType = channelCount <= 8 ? Uint8Array :
                    channelCount <= 16 ? Uint16Array :
                    Uint32Array; // cap at 32 channels
        if (channelCount > 32) {
            console.warn("channel count capped at 32");
        }
        activeSource.start(
            { samplerate, samplecount:total, channels:channelCount },
            /* onData */
            (chunk, offset) => {
                const available = growing.length - offset;
                if (chunk.length > available) {
                    console.warn(
                        `capture overflow: ` +
                        `offset=${offset}, ` +
                        `chunk=${chunk.length}, ` +
                        `available=${available}, ` +
                        `diff=${chunk.length - available}, ` +
                        `total=${total}`
                    );
                }
                const count = Math.min(chunk.length, available);

                if (count > 0) {
                    // this is a failsafe in cases where the received amount exceed the expected amount
                    //growing.set(chunk.subarray(0, count), offset); 

                    const samples = new sampleType(
                        chunk.buffer,
                        chunk.byteOffset,
                        chunk.byteLength / sampleType.BYTES_PER_ELEMENT
                    );
                    //console.log({input:chunk.buffer, output:samples});
                    growing.set(samples, offset);
                }

                const sampleCount = Math.min(total, offset + count); // sample count

                store.set((s) => ({
                    status: { ...s.status, sampleCount }
                }));

                if (store.get().follow) WS.waveform.fit();
            },
            /* onDone */
            (info) => {
                    WS.capture.setBuffer(new CaptureBuffer(growing.slice(0, info.samples), info.samplerate, info.channels));
                    if (store.get().channels.length !== info.channels) store.set({ channels: makeChannels({count:info.channels}) });
                    store.set((s) => ({ status: { ...s.status, state: 'done', sampleCount: info.samples, samplerate: info.samplerate/*, channelCount: info.channels*/, trigger: null } }));
                    for (const d of store.get().decoders) WS.decoders.decode(d.id);
                    if (store.get().follow) WS.waveform.fit();
            },
            /* onError */
            (msg) => { store.set((s) => ({ status: { ...s.status, state: 'error', message: msg } })); toast(msg); }
        );
    }

    function stopCapture() {
        activeSource?.stop();
        if (growing && store.get().status.sampleCount > 0) {
            const n = store.get().status.sampleCount;
            WS.capture.setBuffer(new WS.CaptureBuffer(growing.slice(0, n), store.get().status.samplerate, store.get().channels.length));
            for (const d of store.get().decoders) decoders.decode(d.id);
        }
        store.set((s) => ({ status: { ...s.status, state: s.status.sampleCount > 0 ? 'done' : 'idle' } }));
    }

    WS.capture = WS.capture ?? {};
    Object.assign(WS.capture, {
        startCapture, 
        stopCapture,
        hasData: () => !!buffer,
        setBuffer(b) { buffer = b; /*console.trace(b);*/},
        render(start, spp, width) { return buffer ? buffer.render(start, spp, width) : new Uint32Array(width * 2); },
        samples(start, count) { return buffer ? buffer.rawSlice(start, count) : { first: 0, data: new Uint32Array(0) }; },
        measure(channel, sample) { return buffer ? buffer.measure(channel, sample) : null; },
        findEdge(channel, from, forward) { return buffer ? buffer.findEdge(channel, from, forward) : null; },
        edges(channel, from, to) { return buffer ? buffer.edges(channel, from, to) : { pos: [], rising: [] }; },
        burstAt(channel, sample, maxGap, tol) { return buffer ? buffer.burstAt(channel, sample, maxGap, tol) : null; },
        getBuffer: () => buffer
    });
})(window.WS = window.WS || {});
