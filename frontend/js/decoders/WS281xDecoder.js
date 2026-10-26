// WS281x RGB LED decoder

// Ported from libsigrokdecode (rgb_led_ws281x)

// Copyright (C) 2016 Vladimir Ermakov

// License: GPLv3+

/*
# Implementor's notes on the wire format:
# - World Semi vendor, (Adafruit copy of the) datasheet
#   https://cdn-shop.adafruit.com/datasheets/WS2812.pdf
# - reset pulse is 50us (or more) of low pin level
# - 24bits per WS281x item, 3x 8bits, MSB first, GRB sequence,
#   cascaded WS281x items, all "excess bits" are passed through
# - bit time starts with high period, continues with low period,
#   high to low periods' ratio determines bit value, datasheet
#   mentions 0.35us/0.8us for value 0, 0.7us/0.6us for value 1
#   (huge 150ns tolerances, un-even 0/1 value length, hmm)
# - experience suggests the timing "is variable", rough estimation
#   often is good enough, microcontroller firmware got away with
#   four quanta per bit time, or even with three quanta (30%/60%),
#   Adafruit learn article suggests 1.2us total and 0.4/0.8 or
#   0.8/0.4 high/low parts, four quanta are easier to handle when
#   the bit stream is sent via SPI to avoid MCU bit banging and its
#   inaccurate timing (when interrupts are used in the firmware)
# - RGBW datasheet (Adafruit copy) for SK6812
#   https://cdn-shop.adafruit.com/product-files/2757/p2757_SK6812RGBW_REV01.pdf
#   also 1.2us total, shared across 0.3/0.9 for 0, 0.6/0.6 for 1,
#   80us reset pulse, R8/G8/B8/W8 format per 32bits
# - WS2815, RGB LED, uses GRB wire format, 280us RESET pulse width
# - more vendors and models available and in popular use,
#   suggests "one third" or "two thirds" ratio would be most robust,
#   sample "a little before" the bit half? reset pulse width may need
#   to become an option? matrices and/or fast refresh environments
#   may want to experiment with back to back pixel streams
*/

class WS281xDecoder extends Decoder {

    static Info = {
        name: "RGB LED (WS281x)",
        longname: 'RGB LED string decoder (WS281x)',
        desc: "RGB LED string protocol (WS281x).",
        class: WS281xDecoder
    };

    // Color table: name -> color. Used as 'color' override on annotations
    // (falls back to the annotation's 'class' when color is omitted).
    static ColorTable = {
        red:    '#e03030',
        green:  '#30c050',
        blue:   '#3070e0',
        white:  '#c0c040',
        reset:  '#808080',
    };

    static GuiConfigData = {
        channel:{ label: 'DIN', type: 'channel', default: 0 },
        wireorder:{ label: 'Wire order', type: 'select',
            options: ['BGR', 'BRG', 'GBR', 'GRB', 'RBG', 'RGB', 'RWBG', 'RGBW'].map((s) => [s, s]), default: 'GRB' },
        textorder:{ label: 'Text order', type: 'select',
            options: ['wire', 'RGB[W]', 'RGB', 'RGBW', 'RGWB'].map((s) => [s, s]), default: 'RGB[W]' },
        //subDecoders:{ label: 'Sub-Analyzers', type: 'subDecoders', default: []},
    };

    getCfgGui() {
        return WS281xDecoder.GuiConfigData;
    }

    constructor(p) {
        super(p);
        this.signals = ['channel'];
        this.frames = [];
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—';
        return `${name(c.channel)} · ${c.wireorder}`;
    }

    rows() {
        return {
            bits:{label:'BITS', anchor: { signal: 'channel' }, placement: 'after'},
            comps:{label:'COMP', anchor: { signal: 'channel' }, placement: 'after'},
            rgb:{label:'RGB', anchor: { signal: 'channel' }, placement: 'after'},
        };
    }

    getOutput() {
        return this.frames;
    }

    run() {
        const buf = this.getSource();
        const ANN = window.WS.theme.ANN;
        const COL = WS281xDecoder.ColorTable;
        const cfg = this.cfg;
        const ch = cfg.channel;
        const get = (n) => (buf.samples[n] >> ch) & 1;
        const hex = (v) => v.toString(16).padStart(2, '0');

        // Color per color component, from the color table
        const compColor = { r: COL.red, g: COL.green, b: COL.blue, w: COL.white };

        // Preprocess options
        const wireformat = [...cfg.wireorder.toLowerCase()].filter((c) => 'rgbw'.includes(c));
        const needBits = wireformat.length * 8;
        const textorder = cfg.textorder.toLowerCase();
        const fmt = {
            'rgb[w]': (o) => '#' + hex(o.r) + hex(o.g) + hex(o.b) + (o.w === null ? '' : hex(o.w)),
            'rgb':  (o) => '#' + hex(o.r) + hex(o.g) + hex(o.b),
            'rgbw': (o) => '#' + hex(o.r) + hex(o.g) + hex(o.b) + hex(o.w ?? 0),
            'rgwb': (o) => '#' + hex(o.r) + hex(o.g) + hex(o.w ?? 0) + hex(o.b),
        }[textorder];

        const bitsAnn = [], compsAnn = [], rgbAnn = [];
        let bits = []; // {value, ss, es}

        const handleBits = () => {
            if (bits.length < needBits) { return; }
            const ssPacket = bits[0].ss, esPacket = bits[bits.length - 1].es;
            const o = { r: 0, g: 0, b: 0, w: null };
            const comps = [];
            wireformat.forEach((c, i) => {
                const cb = bits.slice(8 * i, 8 * i + 8);
                let v = 0;
                for (const b of cb) { v = (v << 1) | b.value; } // MSB first
                o[c] = v;
                comps.push({ start: cb[0].ss, end: cb[cb.length - 1].es, class: ANN.DATA, color: compColor[c], text: c.toUpperCase() + ':' + hex(v) });
            });
            const rgbText = textorder === 'wire'
                ? '#' + comps.map((c) => c.text.slice(2)).join('')
                : fmt(o);
            compsAnn.push(...comps);
            rgbAnn.push({ start: ssPacket, end: esPacket, class: ANN.DATA, text: rgbText });
            bits = [];
        };

        const handleBit = (ss, es, value) => {
            bitsAnn.push({ start: ss, end: es, class: ANN.DATA, text: String(value) });
            bits.push({ value, ss, es });
            handleBits();
        };

        const samples625ns = Math.floor(buf.samplerate * 625e-9);
        const resetSkip = Math.round(buf.samplerate * 50e-6) + 1;

        // Synchronize: wait for low level
        let i = 0;
        while (i < buf.length && get(i) !== 0) { i++; }
        if (i >= buf.length) { return { bits: [], comps: [], rgb: [] }; }

        let ssBit = null, invBit = i, esBit = null;
        let checkReset = false;
        let lastMatch = i;
        let prev = get(i);

        for (i = i + 1; i < buf.length; i++) {
            const pin = get(i);
            const rising = prev === 0 && pin === 1;
            const falling = prev === 1 && pin === 0;
            const skip = !rising && !falling && (i - lastMatch) >= resetSkip;
            prev = pin;
            if (!rising && !falling && !skip) { continue; }
            lastMatch = i;

            // RESET: long low period after a falling edge
            if (checkReset && skip) {
                esBit = invBit;
                const ssRst = invBit, esRst = i;
                if (ssBit !== null && invBit !== null) {
                    const duty = invBit - ssBit;
                    let thres = samples625ns;
                    if (bits.length) {
                        const last = bits[bits.length - 1];
                        thres = (last.es - last.ss) * 0.5;
                    }
                    handleBit(ssBit, invBit, duty >= thres ? 1 : 0);
                }
                bitsAnn.push({ start: ssRst, end: esRst, class: ANN.DATA, color: COL.reset, text: 'RESET' });
                checkReset = false;
                bits = [];
                ssBit = invBit = esBit = null;
            }

            // Rising edge: starts a bit, finishes the previous one
            if (rising) {
                checkReset = false;
                if (ssBit !== null && invBit !== null) {
                    esBit = i;
                    const period = esBit - ssBit;
                    const duty = invBit - ssBit;
                    handleBit(ssBit, esBit, (duty / period) > 0.5 ? 1 : 0);
                }
                ssBit = i; invBit = null; esBit = null;
            }

            // Falling edge: end of high period
            if (falling) {
                checkReset = true;
                invBit = i;
            }
        }

        return { bits: bitsAnn, comps: compsAnn, rgb: rgbAnn };
    }

}

window.WS.decoders.registry.push(WS281xDecoder.Info);