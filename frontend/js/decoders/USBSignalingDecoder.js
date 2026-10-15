// WS281x RGB LED decoder

// Ported from libsigrokdecode (usb_signaling)

// Copyright (C) 2011 Gareth McMullin <gareth@blacksphere.co.nz>
// Copyright (C) 2012-2020 Uwe Hermann <uwe@hermann-uwe.de>

// License: GPLv3+

class USBSignallingDecoder extends Decoder {
    'use strict';

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
        subDecoders:{ label: 'Sub-Analyzers', type: 'subDecoders', default: []},
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

    constructor(p) {
        super(p);
        this.signals = ['dp', 'dm'];
        this.frames = [];
    }

    getCfgGui() {
        return USBSignallingDecoder.GuiConfigData;
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
            frames.push({ type, start, end, data });
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

        // -------------------------------------------------
        // Decoder state
        // -------------------------------------------------

        let signalling = signallingOption;

        let samplerateHz = samplerate;
        let bitrate = null;
        let bitwidth = 0;

        let oldsym = 'J';

        let state = 'IDLE';

        let samplepos = 0;
        let target = 0;

        let edge = 0;
        let lastEdge = 0;

        let edgePins = null;
        let ssBlock = 0;

        let consecutiveOnes = 0;
        let packetBits = '';

        const updateBitrate = () => {
            bitrate = USBSignallingDecoder.Bitrates[signalling];

            if (bitrate)
                bitwidth = samplerateHz / bitrate;
        };

        // -------------------------------------------------
        // Bit timing
        // -------------------------------------------------

        const setNewTarget = () => {
            samplepos += bitwidth;

            target = Math.trunc(samplepos);

            lastEdge = edge;
            edge = Math.trunc(samplepos - bitwidth / 2);
        };

        // -------------------------------------------------
        // SOP
        // -------------------------------------------------

        const waitForSop = (sym, sampleNum) => {
            if (sym !== 'K' || oldsym !== 'J')
                return false;

            consecutiveOnes = 0;
            packetBits = '';

            updateBitrate();

            if (!bitwidth)
                return false;

            samplepos = sampleNum - (bitwidth / 2) + 0.5;

            setNewTarget();

            addEvent(edge, edge, 'SOP', ['SOP', 'S']);

            state = 'GET_BIT';

            return true;
        };

        // -------------------------------------------------
        // Bit decoding / NRZI / bit stuffing
        // -------------------------------------------------

        const handleBit = (bit, start, end) => {
            if (consecutiveOnes === 6) {
                if (bit === '0') {
                    addStuffBit(start, end);
                    consecutiveOnes = 0;
                } else {
                    addEvent(
                        start,
                        end,
                        'ERR',
                        ['Bit stuff error', 'BS ERR', 'B'],
                        true
                    );

                    state = 'IDLE';
                }

                return;
            }

            addBit(start, end, bit);

            if (bit === '1')
                consecutiveOnes++;
            else
                consecutiveOnes = 0;
        };

        // -------------------------------------------------
        // GET_BIT
        // -------------------------------------------------

        const getBit = sym => {
            setNewTarget();

            // NRZI:
            // No transition = 1
            // Transition = 0

            const bit = oldsym !== sym ? '0' : '1';

            oldsym = sym;

            if (sym === 'SE0') {
                state = 'GET_EOP';
                ssBlock = lastEdge;
            } else {
                handleBit(bit, lastEdge, edge);
            }

            addSymbol(lastEdge, edge, sym);

            if (packetBits.length <= 16)
                packetBits += bit;

            // Low-speed PRE-amble PID.
            if (
                packetBits.length === 16 &&
                packetBits === '0000000100111100'
            ) {
                addEvent(
                    edge,
                    edge,
                    'PREAMBLE',
                    ['PREAMBLE', 'PRE']
                );

                state = 'IDLE';

                signalling = 'low-speed-rp';
                updateBitrate();

                oldsym = 'J';
            }

            // Clock recovery.
            if (bit === '0' && edgePins) {
                const edgeSym = getSymbol(edgePins, signalling);

                if (edgeSym !== 'SE0' && edgeSym !== 'SE1') {
                    if (edgeSym === sym) {
                        bitwidth -= 0.001 * bitwidth;
                        samplepos -= 0.01 * bitwidth;
                    } else {
                        bitwidth += 0.001 * bitwidth;
                        samplepos += 0.01 * bitwidth;
                    }
                }
            }
        };

        // -------------------------------------------------
        // GET_EOP
        // -------------------------------------------------

        const getEop = sym => {
            setNewTarget();

            addSymbol(lastEdge, edge, sym);

            oldsym = sym;

            if (sym === 'SE0')
                return;

            if (sym === 'J') {
                addEvent(ssBlock, edge, 'EOP', ['EOP', 'E']);

                state = 'WAIT_IDLE';
            } else {
                addEvent(
                    ssBlock,
                    edge,
                    'ERR',
                    ['EOP Error', 'EErr', 'E'],
                    true
                );

                state = 'IDLE';
            }
        };

        // -------------------------------------------------
        // IDLE handling
        // -------------------------------------------------

        const handleIdle = (sym, sampleNum, se0Start) => {
            const se0Length = (sampleNum - se0Start) / samplerateHz;

            if (se0Length > 2.5e-6) {
                addEvent(
                    se0Start,
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
                    se0Start,
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
        let se0Start = -1;

        // -------------------------------------------------
        // Main decoder loop
        // -------------------------------------------------

        let i = 1;

        while (i < length) {

            // =============================================
            // GET_BIT / GET_EOP
            // =============================================

            if (state === 'GET_BIT' || state === 'GET_EOP') {

                if (i < target) {
                    i++;
                    continue;
                }

                if (target >= length)
                    break;

                const sampleNum = target;
                const pins = getPins(sampleNum);
                const sym = getSymbol(pins, signalling);

                if (state === 'GET_BIT')
                    getBit(sym);
                else
                    getEop(sym);

                // The current sample is also the next bit's
                // timing reference edge.
                edgePins = pins;

                previousPins = pins;
                i = sampleNum + 1;

                // EOP may already have returned the bus to J.
                // This corresponds to sigrok's immediate wait()
                // in WAIT_IDLE.
                if (state === 'WAIT_IDLE' && !isSE0(pins)) {
                    const idleSym = getSymbol(
                        pins,
                        signallingOption
                    );

                    if (sampleNum - lastEdge > 1) {
                        handleIdle(idleSym, sampleNum, ssBlock);
                    } else {
                        waitForSop(
                            getSymbol(pins, signalling),
                            sampleNum
                        );
                    }
                }

                continue;
            }

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
                        waitForSop(sym, i);
                    }

                    edgePins = pins;
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

                const idleSym = getSymbol(
                    pins,
                    signallingOption
                );

                if (i - lastEdge > 1) {
                    handleIdle(idleSym, i, se0Start);
                } else {
                    waitForSop(
                        getSymbol(pins, signalling),
                        i
                    );
                }

                edgePins = pins;
                previousPins = pins;

                i++;

                continue;
            }

            i++;
        }

        // -------------------------------------------------
        // Sort annotations
        // -------------------------------------------------

        for (const row of [symbolAnns, bitAnns, eventAnns]) {
            row.sort((a, b) => a.start - b.start);
        }

        this.frames = frames;
        console.log(frames);

        return {
            symbols: symbolAnns,
            bits: bitAnns,
            events: eventAnns
        };
    }
}

window.WS.decoders.registry.push(USBSignallingDecoder.Info);
