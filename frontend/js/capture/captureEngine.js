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
    let meta = null;     // { samplerate, channelCount, trigger, rows } of the running capture, trigger = sample index or null
    let live = false;    // a capture is streaming in
    let remoteTrigger = false;  // the source triggers itself and sends the capture once the trigger fired
    let stopRequested = false;
    let showPending = false;

    const liveBuffer = () => (buffer.value?.complete === false ? buffer.value : null);

    /** Shows what has been received so far, at most once per frame (chunks can arrive much faster). */
    function requestShowLive() {
        if (showPending) return;
        showPending = true;
        requestAnimationFrame(() => {
            showPending = false;
            if (live && storage.length > 0) setBuffer(storage.liveBuffer(meta, liveBuffer()), meta.rows);
        });
    }

    /** The capture ended (done, stopped, or the memory is full): show what was received as a complete buffer. */
    function finish() {
        live = false;
        if (storage.length > 0) setBuffer(storage.finalBuffer(meta, liveBuffer()), meta.rows);
        storage = null;
    }

    /** Shows the new data. `rows`: the channels it holds (see captureRows), else the channels are
     *  recreated only when the channel count changed. */
    function setBuffer(buf, rows = null) {
        if (rows) {
            if (appState.channels.value !== rows) appState.channels.set(rows);
        } else if (buf && appState.channels.value.length !== buf.channelCount) {
            appState.channels.set(makeChannels({ count: buf.channelCount }));
        }
        buffer.set(buf);
    }

    /** The rows of a capture of `channels` (device Channel objects in bit order): row k = bit k, with
     *  the device channel's name, color and visible (the same ReactiveValues, so a rename is kept).
     *  The current rows when they already are these channels. */
    function captureRows(channels) {
        if (!Array.isArray(channels) || !(channels[0]?.name instanceof ReactiveValue)) return null;
        const rows = channels.map((ch, k) => (ch.index === k ? ch : { ...ch, index: k }));
        const cur = appState.channels.value;
        const same = rows.length === cur.length && rows.every((r, k) => r.name === cur[k].name && r.index === cur[k].index);
        return same ? cur : rows;
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
     * cfg = { mode, samplerate, channels, activeChannels?, duration?, memoryBytes, triggerOn?, preTrigger?, postTrigger?, ...source specific }
     * channels: a count, or the captured channels (device Channel objects, bit k of a sample = channels[k]);
     * activeChannels: their device indexes when not all channels are captured (the source sends only those).
     * duration (s) is set for Timer; memoryBytes limits Looping and One shot.
     * Trigger: triggerOn = { channel, type, pulseLength?, conditions? } with device channel indexes, preTrigger / postTrigger in samples,
     * see TriggerCapture.js. A source with `handlesTrigger` triggers itself (the backend does it for
     * WebSocketSource), any other source runs until stopped and is triggered here.
     * acquisition.state is 'waiting' until the trigger fires, then 'running'.
     */
    function startCapture(source, cfg) {
        const { mode, samplerate, duration, channels, activeChannels, memoryBytes, triggerOn, preTrigger = 0, postTrigger = 0 } = cfg;
        const total = triggerOn ? preTrigger + 1 + postTrigger
            : duration ? Math.max(64, Math.round(samplerate * duration)) : undefined;
        const channelCount = Array.isArray(channels) ? channels.length : channels;
        if (channelCount > 32) console.warn("channel count capped at 32");
        let trigger = null;
        try {
            storage = makeStorage({ mode, total, memoryBytes, channelCount });
            if (triggerOn && !source.handlesTrigger) {
                trigger = new TriggerCapture({ ...triggerAsBits(triggerOn, activeChannels), preTrigger, sampleType: CaptureBuffer.sampleType(channelCount) });
            }
        } catch (e) {
            // e.g. RangeError: more memory than the browser can give one array; or a trigger on a channel that is not captured
            storage = null;
            toast(e instanceof RangeError ? `Cannot allocate the capture memory: ${e.message}` : e.message);
            return;
        }
        remoteTrigger = !!triggerOn && !trigger;
        stopRequested = false;
        meta = { samplerate, channelCount, trigger: null, rows: captureRows(channels) };
        live = true;
        appState.view.follow.set(true);
        appState.markers.selected.set(null);
        appState.markers.list.set([]);
        appState.selections.selected.set(null);
        appState.selections.list.set([]);
        appState.pointer.measurement.set(null);
        acquisition.state.set(triggerOn ? 'waiting' : 'running');
        activeSource = source;
        activeSource.start(
            // the software trigger needs the source to run until it is stopped
            { ...cfg, samplecount: trigger ? undefined : total, channels:channelCount },
            /* onData: chunks arrive in order, the source's offset is not needed */
            (chunk) => {
                if (!live) return;
                let samples = toSamples(chunk, channelCount);
                if (trigger) {
                    const wasArmed = !trigger.triggered;
                    samples = trigger.push(samples);
                    if (!trigger.triggered) return;
                    if (wasArmed) triggered(preTrigger);
                }
                const written = storage.write(samples);
                requestShowLive();
                if (trigger && storage.length === total) {       // pre + trigger + post are complete
                    activeSource.stop();
                    finish();
                    acquisition.state.set('done');
                    return;
                }
                if (written < samples.length) {
                    if (total === undefined) stopCapture();       // one shot: the memory is full
                    else console.warn(`capture overflow: ${samples.length - written} samples more than the ${total} expected`);
                }
            },
            /* onDone: info = { samples, samplerate, channels, trigger?, warning?, details? } */
            (info) => {
                if (!live) return; // already stopped by the user
                if (info?.warning) toast(info.warning, info.details);
                if (remoteTrigger && Number.isInteger(info?.trigger)) meta.trigger = info.trigger;
                const received = storage.length;
                finish();
                acquisition.state.set(received > 0 ? 'done' : 'idle');
            },
            /* onError: details = the source's extended message, shown in the message log */
            (msg, details) => { live = false; acquisition.message.set(msg); acquisition.state.set('error'); toast(msg, details); },
            /* onStatus, from a source that triggers itself: { state: 'armed' | 'triggered' } */
            (status) => {
                if (live && remoteTrigger && status.state === 'triggered') triggered(preTrigger);
            }
        );
    }

    /** The local trigger works on the samples: its channels as bits instead of device indexes. */
    function triggerAsBits(triggerOn, activeChannels) {
        const bitOf = (ch) => {
            const bit = activeChannels ? activeChannels.indexOf(ch) : ch;
            if (bit < 0) throw new Error(`The trigger uses channel ${ch}, which is not captured`);
            return bit;
        };
        const conditions = Object.fromEntries(Object.entries(triggerOn.conditions ?? {}).map(([ch, level]) => [bitOf(Number(ch)), level]));
        return { ...triggerOn, channel: bitOf(triggerOn.channel), conditions };
    }

    /** The trigger fired: it will be at `index` in the capture. */
    function triggered(index) {
        meta.trigger = index;
        acquisition.state.set('running');
    }

    function stopCapture() {
        // A source that triggers itself sends the capture after the trigger fired: stopping then
        // makes it send what it has (pre-trigger + trigger + part of the post-trigger), which ends
        // the capture in onDone. Stopping again does not wait for it any more.
        if (live && remoteTrigger && meta.trigger !== null && !stopRequested) {
            stopRequested = true;
            activeSource.stop();
            return;
        }
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
