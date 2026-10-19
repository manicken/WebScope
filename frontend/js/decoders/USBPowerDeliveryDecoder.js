// USB Power Delivery protocol decoder (BMC on CC1 / optional CC2)

// Ported from libsigrokdecode (usb_power_delivery)

// Copyright (C) 2015 Google, Inc
// Copyright (C) 2018 davidanger <davidanger@163.com>
// Copyright (C) 2018 Peter Hazenberg <sigrok@haas-en-berg.nl>

// License: GPLv2+

const USBPD = (() => {
    // BMC encoding with a 600kHz datarate
    const UI_US = 1000000 / 600000.0;

    // Threshold to discriminate half-1 from 0 in Binary Mark Coding
    const THRESHOLD_US = (UI_US + 2 * UI_US) / 2;

    const SYM_ERR = 0x10, SYNC1 = 0x11, SYNC2 = 0x12, SYNC3 = 0x13;
    const RST1 = 0x14, RST2 = 0x15, EOP = 0x16;

    const SOP_SEQUENCES = [
        [SYNC1, SYNC1, SYNC1, SYNC2],
        [SYNC1, SYNC1, SYNC3, SYNC3],
        [SYNC1, SYNC3, SYNC1, SYNC3],
        [SYNC1, RST2, RST2, SYNC3],
        [SYNC1, RST2, SYNC3, SYNC2],
        [RST1, SYNC1, RST1, SYNC3],
        [RST1, RST1, RST1, RST2]
    ];

    const SOP_NAMES = [
        'SOP', "SOP'", 'SOP"', "SOP' Debug", 'SOP" Debug', 'Cable Reset', 'Hard Reset'
    ];

    const START_OF_PACKETS = {};
    SOP_SEQUENCES.forEach((seq, i) => { START_OF_PACKETS[seq.join(',')] = SOP_NAMES[i]; });

    return {
        UI_US, THRESHOLD_US, SYM_ERR, EOP, SOP_SEQUENCES, START_OF_PACKETS,

        CTRL_TYPES: {
            0: 'reserved', 1: 'GOOD CRC', 2: 'GOTO MIN', 3: 'ACCEPT', 4: 'REJECT',
            5: 'PING', 6: 'PS RDY', 7: 'GET SOURCE CAP', 8: 'GET SINK CAP',
            9: 'DR SWAP', 10: 'PR SWAP', 11: 'VCONN SWAP', 12: 'WAIT',
            13: 'SOFT RESET', 14: 'reserved', 15: 'reserved', 16: 'Not Supported',
            17: 'Get_Source_Cap_Extended', 18: 'Get_Status', 19: 'FR_Swap',
            20: 'Get_PPS_Status', 21: 'Get_Country_Codes'
        },

        DATA_TYPES: {
            1: 'SOURCE CAP', 2: 'REQUEST', 3: 'BIST', 4: 'SINK CAP',
            5: 'Battery_Status', 6: 'Alert', 7: 'Get_Country_Info', 15: 'VDM'
        },

        // 4b5b decoding of the 5-bit symbols (index = 5 bits, LSB first)
        DEC4B5B: [
            0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x13, 0x14,
            0x10, 0x01, 0x04, 0x05, 0x10, 0x16, 0x06, 0x07,
            0x10, 0x12, 0x08, 0x09, 0x02, 0x03, 0x0A, 0x0B,
            0x11, 0x15, 0x0C, 0x0D, 0x0E, 0x0F, 0x00, 0x10
        ],

        SYM_NAME: [
            '0x0', '0x1', '0x2', '0x3', '0x4', '0x5', '0x6', '0x7',
            '0x8', '0x9', '0xA', '0xB', '0xC', '0xD', '0xE', '0xF',
            'ERROR', 'SYNC-1', 'SYNC-2', 'SYNC-3', 'RST-1', 'RST-2', 'EOP'
        ],

        // [mask, name] pairs, already sorted by mask descending
        RDO_FLAGS: [
            [1 << 27, 'give_back'],
            [1 << 26, 'cap_mismatch'],
            [1 << 25, 'comm_cap'],
            [1 << 24, 'no_suspend'],
            [1 << 23, 'unchunked']
        ],

        BIST_MODES: {
            0: 'Receiver', 1: 'Transmit', 2: 'Counters', 3: 'Carrier 0',
            4: 'Carrier 1', 5: 'Carrier 2', 6: 'Carrier 3', 7: 'Eye'
        },

        VDM_CMDS: {
            1: 'Disc Ident', 2: 'Disc SVID', 3: 'Disc Mode', 4: 'Enter Mode',
            5: 'Exit Mode', 6: 'Attention',
            // 16..31: SVID specific commands, DisplayPort commands:
            16: 'DP Status', 17: 'DP Configure'
        },

        VDM_ACK: ['REQ', 'ACK', 'NAK', 'BSY'],

        // Python's %g (6 significant digits, no trailing zeros)
        g: x => String(Number(x.toPrecision(6))),

        // Python's %0Nx on an unsigned value
        hex: (v, n) => (v >>> 0).toString(16).padStart(n, '0')
    };
})();

class USBPowerDeliveryDecoder extends Decoder {

    static Info = {
        name: 'USB PD',
        longname: 'USB Power Delivery',
        desc: 'USB Power Delivery protocol.',
        class: USBPowerDeliveryDecoder
    };

    static GuiConfigData = {
        cc1: { label: 'CC1', type: 'channel', default: 0 },
        cc2: { label: 'CC2', type: 'channel', default: 1 },   // optional in the original

        // Original option not exposed in the GUI yet:
        //   fulltext: 'yes' | 'no'  -> this.fulltext
    };

    static Crc32Table = (() => {
        const t = new Uint32Array(256);

        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }

        return t;
    })();

    static crc32(bytes) {
        let c = 0xFFFFFFFF;

        for (const b of bytes)
            c = USBPowerDeliveryDecoder.Crc32Table[(c ^ b) & 0xff] ^ (c >>> 8);

        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Helper: merge level-per-sample arrays (0/1, one array per CC channel)
     * into an ascending list of sample numbers where any channel changes level.
     * Pass cc2 as null/undefined if it is not connected.
     */
    static EdgesFromChannels(...channels) {
        const set = new Set();

        for (const ch of channels) {
            if (!ch)
                continue;

            for (let i = 1; i < ch.length; i++) {
                if (ch[i] !== ch[i - 1])
                    set.add(i);
            }
        }

        return [...set].sort((a, b) => a - b);
    }

    getCfgGui() {
        return USBPowerDeliveryDecoder.GuiConfigData;
    }

    constructor(p) {
        super(p);

        // 'Full text decoding of packets' option from the original.
        this.fulltext = false;

        // Required: the BMC timing is derived from the sample rate.
        this.samplerate = null;

        this.frames = [];

        this.reset();
    }

    reset() {
        this.idx = 0;
        this.packetSeq = 0;
        this.previous = 0;
        this.startsample = null;
        this.bits = [];
        this.edges = [];
        this.bad = [];
        this.halfOne = false;
        this.startOne = 0;
        this.storedPdos = new Map();
        this.capMark = [0, 0, 0, 0, 0, 0, 0, 0];

        this.data = [];
        this.head = 0;
        this.crc = 0;
        this.text = '';
        this.sopName = null;

        this.out = {
            symbols: [],
            parts: [],
            payloads: [],
            types: [],
            warnings: [],
            texts: []
        };
    }

    getOutput() {
        return this.frames;
    }

    summary() {
        return 'USB PD decoder';
    }

    rows() {
        // TODO: add anchor/placement the same way as in your other root decoders.
        return {
            symbols: { label: '4b5b symbols', anchor: { signal: 'cc1' }, placement: 'after' },
            parts: { label: 'Parts', anchor: { signal: 'cc1' }, placement: 'after'  },
            payloads: { label: 'Payloads', anchor: { signal: 'cc1' }, placement: 'after'  },
            types: { label: 'Types', anchor: { signal: 'cc1' }, placement: 'after'  },
            warnings: { label: 'Warnings', anchor: { signal: 'cc1' }, placement: 'after'  },
            texts: { label: 'Full text', anchor: { signal: 'cc1' }, placement: 'after'  }
        };
    }

    /**
     * Ascending sample numbers at which CC1 (or CC2, if connected) changes level.
     * The capture buffer holds one 32-bit value per sample, bit n = channel n.
     */
    getEdges() {
        const cfg = this.cfg;   // <-- adjust if your decoders get their config another way
        const buf = this.getSource();

        let mask = 1 << cfg.cc1;

        if (cfg.cc2 != null && cfg.cc2 >= 0)
            mask |= 1 << cfg.cc2;

        const edges = [];

        for (let i = 1; i < buf.length; i++) {
            if ((buf[i] ^ buf[i - 1]) & mask)
                edges.push(i);
        }

        return edges;
    }

    // ---------------------------------------------------------------- output

    /** Edge lookup with Python-style negative indices (-1 = last edge). */
    edge(i) {
        const n = this.edges.length;
        let k = i < 0 ? n + i : i;
        k = Math.min(Math.max(k, 0), n - 1);
        return this.edges[k];
    }

    putx(s0, s1, row, text) {
        const theme = window.WS.theme;

        this.out[row].push({
            start: this.edge(s0),
            end: this.edge(s1),
            class: row === 'warnings' ? (theme.ERROR ?? theme.DATA) : theme.DATA,
            text
        });
    }

    putwarn(longm) {
        this.putx(0, -1, 'warnings', longm);
    }

    recSym(i, sym) {
        this.putx(i, i + 5, 'symbols', USBPD.SYM_NAME[sym]);
    }

    // ----------------------------------------------------------- header bits

    headId() { return (this.head >> 9) & 7; }
    headPowerRole() { return (this.head >> 8) & 1; }
    headDataRole() { return (this.head >> 5) & 1; }
    headRev() { return ((this.head >> 6) & 3) + 1; }
    headCount() { return (this.head >> 12) & 7; }

    headType() {
        return this.headRev() === 3 ? (this.head & 0x1f) : (this.head & 0xf);
    }

    // --------------------------------------------------------- payload texts

    getRequest(rdo) {
        const pos = (rdo >> 28) & 7;
        const mark = this.capMark[pos];
        let settings;

        if (mark === 3) {
            const opV = ((rdo >> 9) & 0x7ff) * 0.02;
            const opA = (rdo & 0x3f) * 0.05;
            settings = `${USBPD.g(opV)}V ${USBPD.g(opA)}A`;
        } else if (mark === 2) {
            const opW = ((rdo >> 10) & 0x3ff) * 0.25;
            settings = `${USBPD.g(opW)}W (operating)`;
        } else {
            const opA = ((rdo >> 10) & 0x3ff) * 0.01;
            const maxA = (rdo & 0x3ff) * 0.01;
            settings = `${USBPD.g(opA)}A (operating) / ${USBPD.g(maxA)}A (max)`;
        }

        let flags = '';
        for (const [mask, name] of USBPD.RDO_FLAGS) {
            if (rdo & mask)
                flags += ` [${name}]`;
        }

        const pdo = this.storedPdos.has(pos)
            ? `#${pos}: ${this.storedPdos.get(pos)}`
            : `#${pos}`;

        return `(PDO ${pdo}) ${settings}${flags}`;
    }

    getSourceSinkCap(pdo, idx, source) {
        const g = USBPD.g;
        const t1 = (pdo >> 30) & 3;
        this.capMark[idx] = t1;

        let flags = [];   // [mask, name], sorted by mask descending
        let name, p;

        if (t1 === 0) {
            name = 'Fixed';

            if (source) {
                flags = [
                    [1 << 29, 'dual_role_power'],
                    [1 << 28, 'suspend'],
                    [1 << 27, 'unconstrained'],
                    [1 << 26, 'comm_cap'],
                    [1 << 25, 'dual_role_data'],
                    [1 << 24, 'unchunked']
                ];
            } else {
                flags = [
                    [1 << 29, 'dual_role_power'],
                    [1 << 28, 'high_capability'],
                    [1 << 27, 'unconstrained'],
                    [1 << 26, 'comm_cap'],
                    [1 << 25, 'dual_role_data'],
                    [0b11 << 23, 'fr_swap 3.0 A'],
                    [0b10 << 23, 'fr_swap 1.5 A'],
                    [0b01 << 23, 'fr_swap default power']
                ];
            }

            const mv = ((pdo >> 10) & 0x3ff) * 0.05;
            const ma = (pdo & 0x3ff) * 0.01;
            p = `${g(mv)}V ${g(ma)}A (${g(mv * ma)}W)`;
            this.storedPdos.set(idx, `${name} ${g(mv)}V`);
        } else if (t1 === 1) {
            name = 'Battery';
            const minv = ((pdo >> 10) & 0x3ff) * 0.05;
            const maxv = ((pdo >> 20) & 0x3ff) * 0.05;
            const mw = (pdo & 0x3ff) * 0.25;
            p = `${g(minv)}/${g(maxv)}V ${g(mw)}W`;
            this.storedPdos.set(idx, `${name} ${g(minv)}/${g(maxv)}V`);
        } else if (t1 === 2) {
            name = 'Variable';
            const minv = ((pdo >> 10) & 0x3ff) * 0.05;
            const maxv = ((pdo >> 20) & 0x3ff) * 0.05;
            const ma = (pdo & 0x3ff) * 0.01;
            p = `${g(minv)}/${g(maxv)}V ${g(ma)}A`;
            this.storedPdos.set(idx, `${name} ${g(minv)}/${g(maxv)}V`);
        } else {
            const t2 = (pdo >> 28) & 3;

            if (t2 === 0) {
                name = 'Programmable|PPS';
                flags = [[1 << 29, 'power_limited']];
                const minv = ((pdo >> 8) & 0xff) * 0.1;
                const maxv = ((pdo >> 17) & 0xff) * 0.1;
                const ma = (pdo & 0xff) * 0.05;
                p = `${g(minv)}/${g(maxv)}V ${g(ma)}A`;

                if ((pdo >> 27) & 1)
                    p += ' [limited]';

                this.storedPdos.set(idx, `${name} ${g(minv)}/${g(maxv)}V`);
            } else {
                name = `Reserved APDO: 0b${t2.toString(2)}`;
                p = `[raw: 0b${(pdo >>> 0).toString(2)}]`;
                this.storedPdos.set(idx, `${name} ${p}`);
            }
        }

        let tFlags = '';
        for (const [mask, fname] of flags) {
            if (pdo & mask)
                tFlags += ` [${fname}]`;
        }

        return `[${name}] ${p}${tFlags}`;
    }

    getVdm(idx, data) {
        let txt;

        if (idx === 0) {   // VDM header
            const vid = data >>> 16;
            const structured = data & (1 << 15);

            if (structured) {
                const cmd = data & 0x1f;
                const ack = (data >> 6) & 3;
                const pos = (data >> 8) & 7;

                txt = USBPD.VDM_ACK[ack] + ' ';
                txt += USBPD.VDM_CMDS[cmd] ?? 'cmd?';
                txt += pos ? ` pos ${pos}` : ' ';
            } else {
                txt = `unstruct [${USBPD.hex(data & 0x7fff, 4)}]`;
            }

            txt += ` SVID:${USBPD.hex(vid, 4)}`;
        } else {           // VDM payload
            txt = `VDO:${USBPD.hex(data, 8)}`;
        }

        return txt;
    }

    getBist(idx, data) {
        const mode = data >>> 28;
        const counter = data & 0xffff;
        let modeName = USBPD.BIST_MODES[mode] ?? 'INVALID';

        if (mode === 2)
            modeName = `Counter[= ${counter}]`;

        // TODO (as in the original): check all 0 bits are 0 / emit warnings.
        return idx === 0 ? `mode ${modeName}` : 'invalid BRO';
    }

    putpayload(s0, s1, idx) {
        const t = this.headType();
        let txt = `[${idx + 1}] `;

        if (t === 2)
            txt += this.getRequest(this.data[idx]);
        else if (t === 1 || t === 4)
            txt += this.getSourceSinkCap(this.data[idx], idx + 1, t === 1);
        else if (t === 15)
            txt += this.getVdm(idx, this.data[idx]);
        else if (t === 3)
            txt += this.getBist(idx, this.data[idx]);

        this.putx(s0, s1, 'payloads', txt);
        this.text += ' - ' + txt;
    }

    puthead() {
        const powerRole = this.headPowerRole();
        let role = powerRole ? 'SRC' : 'SNK';

        if (this.headDataRole() !== powerRole)
            role += this.headDataRole() ? '/DFP' : '/UFP';

        const t = this.headType();
        let shortm;

        if (this.headCount() === 0)
            shortm = USBPD.CTRL_TYPES[t] ?? 'CTRL???';
        else
            shortm = USBPD.DATA_TYPES[t] ?? 'DAT???';

        const longm = `(r${this.headRev()}) ${role}[${this.headId()}]: ${shortm}`;

        this.putx(0, -1, 'types', longm);
        this.text += longm;
    }

    computeCrc32() {
        const bytes = new Uint8Array(2 + 4 * this.data.length);
        const view = new DataView(bytes.buffer);

        view.setUint16(0, this.head & 0xffff, true);
        this.data.forEach((d, i) => view.setUint32(2 + 4 * i, d >>> 0, true));

        return USBPowerDeliveryDecoder.crc32(bytes);
    }

    // ------------------------------------------------------------- symbols

    getSym(i, rec = true) {
        const b = this.bits;
        const v = b[i] | (b[i + 1] << 1) | (b[i + 2] << 2) | (b[i + 3] << 3) | (b[i + 4] << 4);
        const sym = USBPD.DEC4B5B[v];

        if (rec)
            this.recSym(i, sym);

        return sym;
    }

    getShort() {
        const i = this.idx;

        // Check it's not a truncated packet.
        if (this.bits.length - i <= 20) {
            this.putwarn('Truncated');
            return 0x0BAD;
        }

        const k = [this.getSym(i), this.getSym(i + 5), this.getSym(i + 10), this.getSym(i + 15)];

        // TODO (as in the original): check bad symbols.
        const val = k[0] | (k[1] << 4) | (k[2] << 8) | (k[3] << 12);
        this.idx += 20;

        return val;
    }

    getWord() {
        const lo = this.getShort();
        const hi = this.getShort();

        return (lo | (hi << 16)) >>> 0;
    }

    findCorruptedSop(k) {
        // A start of packet is valid even if only 3 of its 4 symbols are correct.
        for (const seq of USBPD.SOP_SEQUENCES) {
            let matches = 0;

            for (let i = 0; i < k.length; i++) {
                if (k[i] === seq[i])
                    matches++;
            }

            if (matches >= 3)
                return USBPD.START_OF_PACKETS[seq.join(',')];
        }

        return null;
    }

    scanEop() {
        for (let i = 0; i < this.bits.length - 19; i++) {
            const k = [
                this.getSym(i, false), this.getSym(i + 5, false),
                this.getSym(i + 10, false), this.getSym(i + 15, false)
            ];

            const sym = USBPD.START_OF_PACKETS[k.join(',')] ?? this.findCorruptedSop(k);

            // We have an interesting symbol sequence.
            if (sym) {
                this.sopName = sym;

                this.putx(0, i, 'parts', 'Preamble');

                this.recSym(i, k[0]);
                this.recSym(i + 5, k[1]);
                this.recSym(i + 10, k[2]);
                this.recSym(i + 15, k[3]);

                if (sym === 'Hard Reset') {
                    this.text += 'HRST';
                    return -1;
                } else if (sym === 'Cable Reset') {
                    this.text += 'CRST';
                    return -1;
                }

                this.putx(i, i + 20, 'parts', sym);
                return i + 20;
            }
        }

        this.putx(0, this.bits.length, 'parts', 'Junk???');
        this.text += 'Junk???';
        this.putwarn('No start of packet found');

        return -1;   // No Start Of Packet
    }

    // -------------------------------------------------------------- packets

    decodePacket() {
        this.data = [];
        this.idx = 0;
        this.text = '';
        this.sopName = null;

        if (this.edges.length < 50)
            return;   // Not a real PD packet

        this.packetSeq++;

        const tstamp = this.startsample / this.samplerate;
        this.text += `#${String(this.packetSeq).padEnd(4)} (${(tstamp * 1000).toFixed(6).padStart(8)}ms): `;

        this.idx = this.scanEop();

        if (this.idx < 0) {
            // Full text trace of the issue.
            this.putx(0, this.idx, 'texts', this.text);

            if (this.sopName === 'Hard Reset' || this.sopName === 'Cable Reset') {
                this.frames.push({
                    type: 'RESET',
                    data: this.sopName,
                    start: this.edge(0),
                    end: this.edge(-1)
                });
            }

            return;   // No real packet: ABORT.
        }

        // Packet header
        this.head = this.getShort();
        this.putx(this.idx - 20, this.idx, 'parts', `H:${USBPD.hex(this.head, 4)}`);
        this.puthead();

        // Data payload
        for (let i = 0; i < this.headCount(); i++) {
            this.data.push(this.getWord());
            this.putx(this.idx - 40, this.idx, 'parts', `[${i}]${USBPD.hex(this.data[i], 8)}`);
            this.putpayload(this.idx - 40, this.idx, i);
        }

        // CRC check
        this.crc = this.getWord();
        const ccrc = this.computeCrc32();

        if (this.crc !== ccrc)
            this.putwarn(`Bad CRC ${USBPD.hex(this.crc, 8)} != ${USBPD.hex(ccrc, 8)}`);

        this.putx(this.idx - 40, this.idx, 'parts', `CRC:${USBPD.hex(this.crc, 8)}`);

        // End of packet
        if (this.bits.length >= this.idx + 5 && this.getSym(this.idx) === USBPD.EOP) {
            this.putx(this.idx, this.idx + 5, 'parts', 'EOP');
            this.idx += 5;
        } else {
            this.putwarn('No EOP');
        }

        // Full text trace
        if (this.fulltext)
            this.putx(0, this.idx, 'texts', this.text);

        // Bitrate during the packet
        const ss = this.edge(0);
        const es = this.edge(-1);
        const bitrate = this.samplerate * this.bits.length / (es - ss);

        // Machine-readable event for decoders stacked on top of this one.
        this.frames.push({
            type: 'PD PACKET',
            data: {
                sop: this.sopName,
                head: this.head,
                data: this.data,
                crc: this.crc,
                crcOk: this.crc === ccrc,
                bitrate: Math.trunc(bitrate),
                text: this.text
            },
            start: ss,
            end: es
        });
    }

    us2samples(us) {
        return Math.trunc(us * this.samplerate / 1000000);
    }

    /**
     * Feed one edge (sample number) of CC1/CC2 into the BMC decoder.
     */
    processEdge(samplenum) {
        // First sample of the packet, just record the start date.
        if (this.startsample === null) {
            this.startsample = samplenum;
            this.previous = samplenum;
            return;
        }

        const diff = samplenum - this.previous;

        if (diff > this.maxbit) {
            // Large idle: use it as the end of packet.
            this.edges.push(this.previous);   // the last edge of the packet
            this.decodePacket();

            // Reset for next packet.
            this.startsample = samplenum;
            this.bits = [];
            this.edges = [];
            this.bad = [];
            this.halfOne = false;
            this.startOne = 0;
        } else {
            // Add the bit to the packet.
            const isZero = diff > this.threshold;

            if (isZero && !this.halfOne) {
                this.bits.push(0);
                this.edges.push(this.previous);
            } else if (!isZero && this.halfOne) {
                this.bits.push(1);
                this.edges.push(this.startOne);
                this.halfOne = false;
            } else if (!isZero && !this.halfOne) {
                this.halfOne = true;
                this.startOne = this.previous;
            } else {
                // Invalid BMC sequence
                this.bad.push([this.startOne, this.previous]);
                // TODO (as in the original): try to recover.
                this.bits.push(0);
                this.edges.push(this.previous);
                this.halfOne = false;
            }
        }

        this.previous = samplenum;
    }

    run() {
        this.frames = [];
        this.reset();

        if (!this.samplerate)
            throw new Error('USB PD: cannot decode without samplerate.');

        // 0 is 2 UI, a space larger than 1.5x 0 is definitely wrong.
        this.maxbit = this.us2samples(3 * USBPD.UI_US);
        // Duration threshold between half 1 and 0.
        this.threshold = this.us2samples(USBPD.THRESHOLD_US);

        for (const s of this.getEdges())
            this.processEdge(s);

        // The original gets its end-of-packet from a 1 ms skip timer;
        // here the last packet is flushed when the edges run out.
        if (this.startsample !== null && this.edges.length) {
            this.edges.push(this.previous);
            this.decodePacket();
        }

        return this.out;
    }
}

window.WS.decoders.registry.push(USBPowerDeliveryDecoder.Info);
