// USB (LS/FS) signalling decoder
// Ported from libsigrokdecode (usb_signalling)
//
// Copyright (C) 2011 Gareth McMullin <gareth@blacksphere.co.nz>
// Copyright (C) 2012-2020 Uwe Hermann <uwe@hermann-uwe.de>
//
// License: GPLv3+
//
// Decoding strategy:
//   Instead of sampling on a fixed bit grid (which drifts during long
//   J/K runs with no edges), the signal is split into "runs" of constant
//   D+/D- state. For each run the number of bits is n = round(d / bitwidth)
//   and they are spread evenly over the *real* run length (w = d / n).
//   The timing error is therefore reset at every edge, like a real DPLL.

class USBSignallingDecoder extends Decoder {

    static Info = {
        name: 'USB Signalling',
        longname: 'Universal Serial Bus (LS/FS) signalling',
        desc: 'USB (low-speed/full-speed) signalling protocol.',
        class: USBSignallingDecoder
    };

    static GuiConfigData = {
        dp: { label: 'D+', type: 'channel', default: 0 },
        dm: { label: 'D-', type: 'channel', default: 1 },
        signalling: {
            label: 'Signalling',
            type: 'select',
            options: [
                ['automatic', 'Automatic'],
                ['full-speed', 'Full-speed'],
                ['low-speed', 'Low-speed']
            ],
            default: 'automatic'
        },
        //subDecoders: { label: 'Sub-Analyzers', type: 'subDecoders', default: [] },
    };

    static Symbols = {
        'low-speed': {
            '0,0': 'SE0',
            '1,0': 'K',
            '0,1': 'J',
            '1,1': 'SE1'
        },
        'full-speed': {
            '0,0': 'SE0',
            '1,0': 'J',
            '0,1': 'K',
            '1,1': 'SE1'
        },
        'automatic': {
            '0,0': 'SE0',
            '1,0': 'FS_J',
            '0,1': 'LS_J',
            '1,1': 'SE1'
        },
        'low-speed-rp': {
            '0,0': 'SE0',
            '1,0': 'J',
            '0,1': 'K',
            '1,1': 'SE1'
        }
    };

    static Bitrates = {
        'low-speed': 1500000,
        'low-speed-rp': 1500000,
        'full-speed': 12000000,
        'automatic': null
    };

    static SymAnnotation = {
        J: ['J'],
        K: ['K'],
        SE0: ['SE0', '0'],
        SE1: ['SE1', '1']
    };

    // Sync (00000001) + PRE PID (0011 1100), NRZI-decoded.
    static PreambleBits = '0000000100111100';

    constructor(p) {
        super(p);
        this.signals = ['dp', 'dm'];
        this.frames = [];
    }

    getCfgGui() {
        return USBSignallingDecoder.GuiConfigData;
    }

    static GetSourceTypes() {
        return ['logic', CustomDecoder.TYPE];
    }

    getOutput() {
        return this.frames;
    }

    summary(channels) {
        const c = this.cfg;
        const name = i => channels[i]?.name ?? `D${i}`;

        return `D+ ${name(c.dp)} · D- ${name(c.dm)} · ${c.signalling}`;
    }

    rows() {
        return {
            symbols: {
                label: 'Symbols',
                anchor: { signal: 'dm' },
                placement: 'after'
            },
            bits: {
                label: 'Bits',
                anchor: { signal: 'dm' },
                placement: 'after'
            },
            events: {
                label: 'Events',
                anchor: { signal: 'dm' },
                placement: 'after'
            }
        };
    }

    run() {
        const buf = this.getSource();
        const cfg = this.cfg;

        const ANN = window.WS.theme;

        const dpBit = 1 << cfg.dp;
        const dmBit = 1 << cfg.dm;
        const pinMask = dpBit | dmBit;

        const length = buf.length;
        const samplerate = buf.samplerate;
        const samples = buf.samples;

        const signallingOption = cfg.signalling ?? 'automatic';

        if (!samplerate)
            throw new Error('USB: Cannot decode without samplerate.');

        if (!samples || length < 2) {
            this.frames = [];
            return {
                symbols: [],
                bits: [],
                events: []
            };
        }

        // -------------------------------------------------
        // Output
        // -------------------------------------------------

        const symbolAnns = [];
        const bitAnns = [];
        const eventAnns = [];

        const frames = [];

        const addFrame = (type, start, end, data = null) => {
            frames.push({
                type,
                start: Math.floor(start),
                end: Math.floor(end),
                data
            });
        };

        const addAnn = (target, start, end, cls, text) => {
            start = Math.max(0, Math.floor(start));
            end = Math.min(length - 1, Math.max(start, Math.floor(end)));

            target.push({
                start,
                end,
                class: cls,
                text
            });
        };

        const addSymbol = (start, end, sym) => {
            const text = USBSignallingDecoder.SymAnnotation[sym];

            if (!text)
                return;

            addAnn(symbolAnns, start, end, ANN.DATA, text);
            addFrame('SYM', start, end, sym);
        };

        const addBit = (start, end, bit) => {
            addAnn(bitAnns, start, end, ANN.DATA, [bit]);
            addFrame('BIT', start, end, bit);
        };

        const addStuffBit = (start, end) => {
            addAnn(
                bitAnns,
                start,
                end,
                ANN.DATA,
                ['Stuff bit: 0', 'SB: 0', '0']
            );

            addFrame('STUFF BIT', start, end);
        };

        const addEvent = (start, end, type, text, error = false) => {
            addAnn(
                eventAnns,
                start,
                end,
                error ? (ANN.ERROR ?? ANN.DATA) : ANN.DATA,
                text
            );

            addFrame(type, start, end);
        };

        // -------------------------------------------------
        // Signal helpers
        // -------------------------------------------------

        const getPins = sample => {
            const word = samples[sample];

            return [
                (word & dpBit) ? 1 : 0,
                (word & dmBit) ? 1 : 0
            ];
        };

        const getSymbol = (pins, mode) => {
            return USBSignallingDecoder.Symbols[mode][
                `${pins[0]},${pins[1]}`
            ];
        };

        const isSE0 = pins => !pins[0] && !pins[1];

        // Index of the first sample after `from` where D+/D- differ.
        const findRunEnd = from => {
            const w0 = samples[from] & pinMask;
            let j = from + 1;

            while (j < length && (samples[j] & pinMask) === w0)
                j++;

            return j;
        };

        // -------------------------------------------------
        // Decoder state
        // -------------------------------------------------

        let signalling = signallingOption;

        const samplerateHz = samplerate;
        let bitrate = null;
        let bitwidth = 0;

        let oldsym = 'J';

        let state = 'IDLE';

        let lastEdge = 0;
        let se0Start = -1;

        // Set by decodePacket when it ends on a long SE0 (bus reset)
        // that must be classified by the idle logic.
        let handoffSe0Start = -1;

        let consecutiveOnes = 0;
        let packetBits = '';

        const updateBitrate = () => {
            bitrate = USBSignallingDecoder.Bitrates[signalling];
            bitwidth = bitrate ? samplerateHz / bitrate : 0;
        };

        // -------------------------------------------------
        // Bit decoding / bit stuffing
        // Returns false on bit-stuff error.
        // -------------------------------------------------

        const handleBit = (bit, start, end) => {
            if (consecutiveOnes === 6) {
                if (bit === '0') {
                    addStuffBit(start, end);
                    consecutiveOnes = 0;
                    return true;
                }

                addEvent(
                    start,
                    end,
                    'ERR',
                    ['Bit stuff error', 'BS ERR', 'B'],
                    true
                );

                return false;
            }

            addBit(start, end, bit);
            consecutiveOnes = bit === '1' ? consecutiveOnes + 1 : 0;

            return true;
        };

        const switchToPreambleSpeed = () => {
            signalling = 'low-speed-rp';
            updateBitrate();
        };

        // -------------------------------------------------
        // Packet decoding (run based)
        //
        // Decodes one packet starting at the first K edge p0.
        // Returns the sample index where the main loop should
        // continue.
        // -------------------------------------------------

        const decodePacket = p0 => {
            updateBitrate();

            if (!bitwidth)
                return p0 + 1;

            const nominal = bitwidth;

            consecutiveOnes = 0;
            packetBits = '';
            oldsym = 'J';

            addEvent(p0, p0, 'SOP', ['SOP', 'S']);

            let p = p0;

            while (p < length) {
                const e = findRunEnd(p);
                const d = e - p;
                const truncated = e >= length;
                const sym = getSymbol(getPins(p), signalling);

                // Number of bits in this run, and their real width.
                const n = Math.max(
                    1,
                    truncated
                        ? Math.floor(d / bitwidth)
                        : Math.round(d / bitwidth)
                );
                const w = truncated ? bitwidth : d / n;

                // ---------- SE0: EOP (SE0 SE0 J) or reset ----------
                if (sym === 'SE0') {
                    if (truncated) {
                        for (let k = 0; k < n; k++)
                            addSymbol(p + k * w, p + (k + 1) * w, 'SE0');

                        return length;
                    }

                    // Far too long for an EOP: bus reset. Let the idle
                    // logic annotate it and re-detect the speed.
                    if (d / samplerateHz > 2.5e-6) {
                        addSymbol(p, e, 'SE0');
                        handoffSe0Start = p;

                        return e;
                    }

                    for (let k = 0; k < n; k++)
                        addSymbol(p + k * w, p + (k + 1) * w, 'SE0');

                    const e2 = findRunEnd(e);
                    const jEnd = Math.min(e + bitwidth, e2);
                    const nextSym = getSymbol(getPins(e), signalling);

                    addSymbol(e, jEnd, nextSym);

                    if (nextSym === 'J') {
                        addEvent(p, jEnd, 'EOP', ['EOP', 'E']);
                    } else {
                        addEvent(
                            p,
                            jEnd,
                            'ERR',
                            ['EOP Error', 'EErr', 'E'],
                            true
                        );
                    }

                    return e;
                }

                // ---------- SE1: illegal ----------
                if (sym === 'SE1') {
                    addSymbol(p, e, 'SE1');
                    addEvent(
                        p,
                        e,
                        'ERR',
                        ['Invalid SE1', 'SE1 ERR', 'E'],
                        true
                    );

                    return e;
                }

                // ---------- too long to be data: idle / missing EOP ----------
                // Bit stuffing limits a run to 7 bits (6 ones + transition).
                if (n > 7) {
                    // The PRE PID ends in a transition bit that is followed
                    // by hub idle, so its last bit lives in a long run.
                    if (
                        packetBits.length === 15 &&
                        sym !== oldsym &&
                        packetBits + '0' === USBSignallingDecoder.PreambleBits
                    ) {
                        const t = p + bitwidth;

                        addSymbol(p, t, sym);
                        handleBit('0', p, t);
                        addEvent(t, t, 'PREAMBLE', ['PREAMBLE', 'PRE']);

                        switchToPreambleSpeed();

                        return e;
                    }

                    addAnn(
                        symbolAnns,
                        p,
                        e,
                        ANN.DATA,
                        [`${sym} (idle)`, sym]
                    );
                    addFrame('SYM', p, e, sym);

                    if (!truncated) {
                        addEvent(
                            p,
                            e,
                            'ERR',
                            ['Missing EOP', 'No EOP'],
                            true
                        );
                    }

                    return e;
                }

                // ---------- data run: n bits spread over the real length ----------
                for (let k = 0; k < n; k++) {
                    const s = p + k * w;
                    const t = p + (k + 1) * w;

                    // NRZI: the first bit of a run is a transition (0),
                    // the rest of the run are 1s.
                    const bit = (k === 0 && sym !== oldsym) ? '0' : '1';

                    addSymbol(s, t, sym);

                    if (packetBits.length < 16)
                        packetBits += bit;

                    if (!handleBit(bit, s, t))
                        return e;

                    // Low-speed PRE-amble PID.
                    if (packetBits === USBSignallingDecoder.PreambleBits) {
                        addEvent(t, t, 'PREAMBLE', ['PREAMBLE', 'PRE']);

                        switchToPreambleSpeed();

                        return e;
                    }
                }

                oldsym = sym;

                // Soft bit-clock tracking (only trust sane measurements).
                if (!truncated && Math.abs(w - bitwidth) < 0.25 * bitwidth) {
                    bitwidth += 0.2 * (w - bitwidth);
                    bitwidth = Math.min(
                        nominal * 1.1,
                        Math.max(nominal * 0.9, bitwidth)
                    );
                }

                p = e;
            }

            return length;
        };

        // Starts packet decoding if `sym` at sample `i` is a valid SOP.
        // Returns the index to continue from, or -1 if no packet started.
        const tryPacket = (sym, i) => {
            if (sym !== 'K' || oldsym !== 'J')
                return -1;

            handoffSe0Start = -1;

            const next = Math.max(decodePacket(i), i + 1);

            oldsym = 'J';

            if (handoffSe0Start >= 0) {
                state = 'WAIT_IDLE';
                se0Start = handoffSe0Start;
                lastEdge = handoffSe0Start;
            } else {
                state = 'IDLE';
            }

            return next;
        };

        // -------------------------------------------------
        // IDLE handling (reset / keep-alive / speed detection)
        // -------------------------------------------------

        const handleIdle = (sym, sampleNum, se0StartSample) => {
            const se0Length = (sampleNum - se0StartSample) / samplerateHz;

            if (se0Length > 2.5e-6) {
                addEvent(
                    se0StartSample,
                    sampleNum,
                    'RESET',
                    ['Reset', 'Res', 'R']
                );

                signalling = signallingOption;

                updateBitrate();

            } else if (
                se0Length > 1.2e-6 &&
                signalling === 'low-speed'
            ) {
                addEvent(
                    se0StartSample,
                    sampleNum,
                    'KEEP ALIVE',
                    ['Keep-alive', 'KA', 'A']
                );
            }

            if (sym === 'FS_J') {
                signalling = 'full-speed';
                updateBitrate();

            } else if (sym === 'LS_J') {
                signalling = 'low-speed';
                updateBitrate();
            }

            oldsym = 'J';
            state = 'IDLE';
        };

        // -------------------------------------------------
        // Initialize from first sample.
        // -------------------------------------------------

        const initialPins = getPins(0);
        const initialSym = getSymbol(initialPins, signalling);

        if (initialSym === 'SE0') {
            oldsym = 'J';
        } else {
            handleIdle(initialSym, 0, 0);
        }

        let previousPins = initialPins;

        // -------------------------------------------------
        // Main decoder loop
        // -------------------------------------------------

        let i = 1;

        while (i < length) {

            // =============================================
            // IDLE
            // =============================================

            if (state === 'IDLE') {

                const pins = getPins(i);

                const changed =
                    pins[0] !== previousPins[0] ||
                    pins[1] !== previousPins[1];

                if (changed) {
                    const sym = getSymbol(pins, signalling);

                    if (sym === 'SE0') {
                        lastEdge = i;
                        se0Start = i;
                        state = 'WAIT_IDLE';
                    } else {
                        const nx = tryPacket(sym, i);

                        if (nx >= 0) {
                            i = nx;
                            previousPins = getPins(i - 1);
                            continue;
                        }
                    }
                }

                previousPins = pins;
                i++;

                continue;
            }

            // =============================================
            // WAIT_IDLE
            // =============================================

            if (state === 'WAIT_IDLE') {

                const pins = getPins(i);

                if (isSE0(pins)) {
                    previousPins = pins;
                    i++;
                    continue;
                }

                if (i - lastEdge > 1) {
                    handleIdle(
                        getSymbol(pins, signallingOption),
                        i,
                        se0Start
                    );
                } else {
                    const nx = tryPacket(
                        getSymbol(pins, signalling),
                        i
                    );

                    if (nx >= 0) {
                        i = nx;
                        previousPins = getPins(i - 1);
                        continue;
                    }
                }

                previousPins = pins;
                i++;

                continue;
            }

            i++;
        }

        // -------------------------------------------------
        // Sort output
        // -------------------------------------------------

        for (const row of [symbolAnns, bitAnns, eventAnns])
            row.sort((a, b) => a.start - b.start);

        frames.sort((a, b) => a.start - b.start);

        this.frames = frames;

        return {
            symbols: symbolAnns,
            bits: bitAnns,
            events: eventAnns
        };
    }
}

window.WS.decoders.registry.push(USBSignallingDecoder.Info);