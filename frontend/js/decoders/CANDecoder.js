//
// This file is part of the libsigrokdecode project.
//
// Copyright (C) 2012-2013 Uwe Hermann <uwe@hermann-uwe.de>
// Copyright (C) 2019 Stephan Thiele <stephan.thiele@mailbox.org>
//
// This program is free software; you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation; either version 2 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, see <http://www.gnu.org/licenses/>.
//
// Ported to JavaScript for WebScope from libsigrokdecode decoders/can (pd.py and __init__.py).
//
// From __init__.py:
//
//   Copyright (C) 2012 Uwe Hermann <uwe@hermann-uwe.de>
//   (GNU General Public License, version 2 or (at your option) any later version, as above.)
//
//   CAN (Controller Area Network) is a field bus protocol for distributed
//   real-time control.
//
//   This decoder assumes that a single CAN_RX line is sampled (e.g. on
//   the digital output side of a CAN transceiver IC such as the Microchip
//   MCP-2515DM-BM).
//
//   It also has support for CAN-FD.
//
// Port notes:
//  - CanDecodeRun is the original Decoder class, method by method; sigrok's wait() is decoder/srdWait.js.
//  - Output for stacked decoders and scripts (getOutput()): [{ type: 'FRAME', data: { frameType, id,
//    rtr, dlc, bytes }, start, end }], the original's OUTPUT_PYTHON tuple
//    (frame_type, fullid, rtr_type, dlc, frame_bytes) with names.
//  - The original has a stray comma after the identifier text (s = '...' % (...),), which makes it a
//    tuple and shows the ID as "('123 (0x7b)',)"; fixed here.

/** bitpack_msb() from common/srdhelper: the bits as a number, MSB first. */
function bitpack_msb(bits) {
    let v = 0;
    for (const b of bits) v = v * 2 + b;
    return v;
}

function dlc2len(dlc) {
    return [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64][dlc];
}

/** One run of the original decoder over a buffer: put() / putpy() collect annotations and frames. */
class CanDecodeRun {
    constructor(buf, channel, options, put, putpy) {
        this.w = new SrdWait(buf, [channel]);
        this.options = options;
        this._put = put;
        this._putpy = putpy;
        this.reset();
        // metadata(): the samplerate
        this.samplerate = buf.samplerate;
        this.bit_width = this.samplerate / this.options['nominal_bitrate'];
        this.sample_point = (this.bit_width / 100.0) * this.options['sample_point'];
    }

    get samplenum() { return this.w.samplenum; }

    reset() {
        this.samplerate = null;
        this.reset_variables();
    }

    set_bit_rate(bitrate) {
        this.bit_width = this.samplerate / bitrate;
        this.sample_point = (this.bit_width / 100.0) * this.options['sample_point'];
    }

    set_nominal_bitrate() {
        this.set_bit_rate(this.options['nominal_bitrate']);
    }

    set_fast_bitrate() {
        this.set_bit_rate(this.options['fast_bitrate']);
    }

    // Generic helper for CAN bit annotations.
    putg(ss, es, data) {
        const left = Math.trunc(this.sample_point), right = Math.trunc(this.bit_width - this.sample_point);
        this._put(ss - left, es + right, data);
    }

    // Single-CAN-bit annotation using the current samplenum.
    putx(data) {
        this.putg(this.samplenum, this.samplenum, data);
    }

    // Single-CAN-bit annotation using the samplenum of CAN bit 12.
    put12(data) {
        this.putg(this.ss_bit12, this.ss_bit12, data);
    }

    // Single-CAN-bit annotation using the samplenum of CAN bit 32.
    put32(data) {
        this.putg(this.ss_bit32, this.ss_bit32, data);
    }

    // Multi-CAN-bit annotation from self.ss_block to current samplenum.
    putb(data) {
        this.putg(this.ss_block, this.samplenum, data);
    }

    putpy(data) {
        this._putpy(this.ss_packet, this.es_packet, data);
    }

    reset_variables() {
        this.state = 'IDLE';
        this.sof = this.frame_type = this.dlc = null;
        this.rawbits = []; // All bits, including stuff bits
        this.bits = []; // Only actual CAN frame bits (no stuff bits)
        this.curbit = 0; // Current bit of CAN frame (bit 0 == SOF)
        this.last_databit = 999; // Positive value that bitnum+x will never match
        this.ss_block = null;
        this.ss_bit12 = null;
        this.ss_bit32 = null;
        this.ss_databytebits = [];
        this.frame_bytes = [];
        this.rtr_type = null;
        this.fd = false;
        this.rtr = null;
    }

    // Poor man's clock synchronization. Use signal edges which change to
    // dominant state in rather simple ways. This naive approach is neither
    // aware of the SYNC phase's width nor the specific location of the edge,
    // but improves the decoder's reliability when the input signal's bitrate
    // does not exactly match the nominal rate.
    dom_edge_seen(force = false) {
        this.dom_edge_snum = this.samplenum;
        this.dom_edge_bcount = this.curbit;
    }

    // Determine the position of the next desired bit's sample point.
    get_sample_point(bitnum) {
        let samplenum = this.dom_edge_snum;
        samplenum += this.bit_width * (bitnum - this.dom_edge_bcount);
        samplenum += this.sample_point;
        return Math.trunc(samplenum);
    }

    is_stuff_bit() {
        // CAN uses NRZ encoding and bit stuffing.
        // After 5 identical bits, a stuff bit of opposite value is added.
        // But not in the CRC delimiter, ACK, and end of frame fields.
        if (this.bits.length > this.last_databit + 17) {
            return false;
        }
        const last_6_bits = this.rawbits.slice(-6).join('');
        if (last_6_bits !== '000001' && last_6_bits !== '111110') {
            return false;
        }

        // Stuff bit. Keep it in self.rawbits, but drop it from self.bits.
        this.bits.pop(); // Drop last bit.
        return true;
    }

    is_valid_crc(crc_bits) {
        return true; // TODO
    }

    decode_error_frame(bits) {
        // TODO
    }

    decode_overload_frame(bits) {
        // TODO
    }

    // Both standard and extended frames end with CRC, CRC delimiter, ACK,
    // ACK delimiter, and EOF fields. Handle them in a common function.
    // Returns True if the frame ended (EOF), False otherwise.
    decode_frame_end(can_rx, bitnum) {

        // Remember start of CRC sequence (see below).
        if (bitnum === (this.last_databit + 1)) {
            this.ss_block = this.samplenum;
            if (this.fd) {
                if (dlc2len(this.dlc) < 16) {
                    this.crc_len = 27; // 17 + SBC + stuff bits
                } else {
                    this.crc_len = 32; // 21 + SBC + stuff bits
                }
            } else {
                this.crc_len = 15;
            }
        }

        // CRC sequence (15 bits, 17 bits or 21 bits)
        else if (bitnum === (this.last_databit + this.crc_len)) {
            let crc_type;
            if (this.fd) {
                if (dlc2len(this.dlc) < 16) {
                    crc_type = 'CRC-17';
                } else {
                    crc_type = 'CRC-21';
                }
            } else {
                crc_type = 'CRC-15';
            }

            const x = this.last_databit + 1;
            const crc_bits = this.bits.slice(x, x + this.crc_len + 1);
            this.crc = bitpack_msb(crc_bits);
            const crc = '0x' + this.crc.toString(16).padStart(4, '0');
            this.putb([11, [`${crc_type} sequence: ${crc}`,
                            `${crc_type}: ${crc}`, `${crc_type}`]]);
            if (!this.is_valid_crc(crc_bits)) {
                this.putb([16, ['CRC is invalid']]);
            }
        }

        // CRC delimiter bit (recessive)
        else if (bitnum === (this.last_databit + this.crc_len + 1)) {
            this.putx([12, [`CRC delimiter: ${can_rx}`,
                            `CRC d: ${can_rx}`, 'CRC d']]);
            if (can_rx !== 1) {
                this.putx([16, ['CRC delimiter must be a recessive bit']]);
            }

            if (this.fd) {
                this.set_nominal_bitrate();
            }
        }

        // ACK slot bit (dominant: ACK, recessive: NACK)
        else if (bitnum === (this.last_databit + this.crc_len + 2)) {
            const ack = can_rx === 0 ? 'ACK' : 'NACK';
            this.putx([13, [`ACK slot: ${ack}`, `ACK s: ${ack}`, 'ACK s']]);
        }

        // ACK delimiter bit (recessive)
        else if (bitnum === (this.last_databit + this.crc_len + 3)) {
            this.putx([14, [`ACK delimiter: ${can_rx}`,
                            `ACK d: ${can_rx}`, 'ACK d']]);
            if (can_rx !== 1) {
                this.putx([16, ['ACK delimiter must be a recessive bit']]);
            }
        }

        // Remember start of EOF (see below).
        else if (bitnum === (this.last_databit + this.crc_len + 4)) {
            this.ss_block = this.samplenum;
        }

        // End of frame (EOF), 7 recessive bits
        else if (bitnum === (this.last_databit + this.crc_len + 10)) {
            this.putb([2, ['End of frame', 'EOF', 'E']]);
            if (this.rawbits.slice(-7).join('') !== '1111111') {
                this.putb([16, ['End of frame (EOF) must be 7 recessive bits']]);
            }
            this.es_packet = this.samplenum;
            const py_data = [this.frame_type, this.fullid, this.rtr_type,
                this.dlc, this.frame_bytes];
            this.putpy(py_data);
            this.reset_variables();
            return true;
        }

        return false;
    }

    // Returns True if the frame ended (EOF), False otherwise.
    decode_standard_frame(can_rx, bitnum) {

        // Bit 14: FDF (Flexible data format)
        // Has to be sent dominant when FD frame, has to be sent recessive
        // when classic CAN frame.
        if (bitnum === 14) {
            this.fd = can_rx ? true : false;
            if (this.fd) {
                this.putx([7, [`Flexible data format: ${can_rx}`,
                               `FDF: ${can_rx}`, 'FDF']]);
            } else {
                this.putx([7, [`Reserved bit 0: ${can_rx}`,
                               `RB0: ${can_rx}`, 'RB0']]);
            }

            if (this.fd) {
                // Bit 12: Substitute remote request (SRR) bit
                this.put12([8, ['Substitute remote request', 'SRR']]);
                this.dlc_start = 18;
            } else {
                // Bit 12: Remote transmission request (RTR) bit
                // Data frame: dominant, remote frame: recessive
                // Remote frames do not contain a data field.
                const rtr = this.bits[12] === 1 ? 'remote' : 'data';
                this.put12([8, [`Remote transmission request: ${rtr} frame`,
                                `RTR: ${rtr} frame`, 'RTR']]);
                this.rtr_type = rtr;
                this.dlc_start = 15;
            }
        }

        if (bitnum === 15 && this.fd) {
            this.putx([7, [`Reserved: ${can_rx}`, `R0: ${can_rx}`, 'R0']]);
        }

        if (bitnum === 16 && this.fd) {
            this.putx([7, [`Bit rate switch: ${can_rx}`, `BRS: ${can_rx}`, 'BRS']]);
        }

        if (bitnum === 17 && this.fd) {
            this.putx([7, [`Error state indicator: ${can_rx}`, `ESI: ${can_rx}`, 'ESI']]);
        }

        // Remember start of DLC (see below).
        else if (bitnum === this.dlc_start) {
            this.ss_block = this.samplenum;
        }

        // Bits 15-18: Data length code (DLC), in number of bytes (0-8).
        else if (bitnum === this.dlc_start + 3) {
            this.dlc = bitpack_msb(this.bits.slice(this.dlc_start, this.dlc_start + 4));
            this.putb([10, [`Data length code: ${this.dlc}`,
                            `DLC: ${this.dlc}`, 'DLC']]);
            this.last_databit = this.dlc_start + 3 + (dlc2len(this.dlc) * 8);
            if (this.dlc > 8 && !this.fd) {
                this.putb([16, ['Data length code (DLC) > 8 is not allowed']]);
            }
        }

        // Remember all databyte bits, except the very last one.
        else if (bitnum >= this.dlc_start + 4 && bitnum < this.last_databit) {
            this.ss_databytebits.push(this.samplenum);
        }

        // Bits 19-X: Data field (0-8 bytes, depending on DLC)
        // The bits within a data byte are transferred MSB-first.
        else if (bitnum === this.last_databit) {
            this.ss_databytebits.push(this.samplenum); // Last databyte bit.
            this.put_data_bytes();
        }

        else if (bitnum > this.last_databit) {
            return this.decode_frame_end(can_rx, bitnum);
        }

        return false;
    }

    // The data bytes, at the last databyte bit (the same code in both frame types of the original).
    put_data_bytes() {
        for (let i = 0; i < dlc2len(this.dlc); i++) {
            const x = this.dlc_start + 4 + (8 * i);
            const b = bitpack_msb(this.bits.slice(x, x + 8));
            this.frame_bytes.push(b);
            const ss = this.ss_databytebits[i * 8];
            const es = this.ss_databytebits[((i + 1) * 8) - 1];
            const h = '0x' + b.toString(16).padStart(2, '0');
            this.putg(ss, es, [0, [`Data byte ${i}: ${h}`,
                                   `DB ${i}: ${h}`, 'DB']]);
        }
        this.ss_databytebits = [];
    }

    // Returns True if the frame ended (EOF), False otherwise.
    decode_extended_frame(can_rx, bitnum) {

        // Remember start of EID (see below).
        if (bitnum === 14) {
            this.ss_block = this.samplenum;
            this.fd = false;
            this.dlc_start = 35;
        }

        // Bits 14-31: Extended identifier (EID[17..0])
        else if (bitnum === 31) {
            this.eid = bitpack_msb(this.bits.slice(14));
            let s = `${this.eid} (0x${this.eid.toString(16)})`;
            this.putb([4, [`Extended Identifier: ${s}`,
                           `Extended ID: ${s}`, 'Extended ID', 'EID']]);

            this.fullid = this.ident * 2 ** 18 + this.eid;   // self.ident << 18 | self.eid
            s = `${this.fullid} (0x${this.fullid.toString(16)})`;
            this.putb([5, [`Full Identifier: ${s}`, `Full ID: ${s}`,
                           'Full ID', 'FID']]);

            // Bit 12: Substitute remote request (SRR) bit
            this.put12([9, [`Substitute remote request: ${this.bits[12]}`,
                            `SRR: ${this.bits[12]}`, 'SRR']]);
        }

        // Bit 32: Remote transmission request (RTR) bit
        // Data frame: dominant, remote frame: recessive
        // Remote frames do not contain a data field.

        // Remember start of RTR (see below).
        if (bitnum === 32) {
            this.ss_bit32 = this.samplenum;
            this.rtr = can_rx;

            if (!this.fd) {
                const rtr = can_rx === 1 ? 'remote' : 'data';
                this.putx([8, [`Remote transmission request: ${rtr} frame`,
                              `RTR: ${rtr} frame`, 'RTR']]);
                this.rtr_type = rtr;
            }
        }

        // Bit 33: RB1 (reserved bit)
        else if (bitnum === 33) {
            this.fd = can_rx ? true : false;
            if (this.fd) {
                this.dlc_start = 37;
                this.putx([7, [`Flexible data format: ${can_rx}`,
                               `FDF: ${can_rx}`, 'FDF']]);
                this.put32([7, [`Reserved bit 1: ${this.rtr}`,
                                `RB1: ${this.rtr}`, 'RB1']]);
            } else {
                this.putx([7, [`Reserved bit 1: ${can_rx}`,
                               `RB1: ${can_rx}`, 'RB1']]);
            }
        }

        // Bit 34: RB0 (reserved bit)
        else if (bitnum === 34) {
            this.putx([7, [`Reserved bit 0: ${can_rx}`,
                           `RB0: ${can_rx}`, 'RB0']]);
        }

        else if (bitnum === 35 && this.fd) {
            this.putx([7, [`Bit rate switch: ${can_rx}`,
                           `BRS: ${can_rx}`, 'BRS']]);
        }

        else if (bitnum === 36 && this.fd) {
            this.putx([7, [`Error state indicator: ${can_rx}`,
                           `ESI: ${can_rx}`, 'ESI']]);
        }

        // Remember start of DLC (see below).
        else if (bitnum === this.dlc_start) {
            this.ss_block = this.samplenum;
        }

        // Bits 35-38: Data length code (DLC), in number of bytes (0-8).
        else if (bitnum === this.dlc_start + 3) {
            this.dlc = bitpack_msb(this.bits.slice(this.dlc_start, this.dlc_start + 4));
            this.putb([10, [`Data length code: ${this.dlc}`,
                            `DLC: ${this.dlc}`, 'DLC']]);
            this.last_databit = this.dlc_start + 3 + (dlc2len(this.dlc) * 8);
        }

        // Remember all databyte bits, except the very last one.
        else if (bitnum >= this.dlc_start + 4 && bitnum < this.last_databit) {
            this.ss_databytebits.push(this.samplenum);
        }

        // Bits 39-X: Data field (0-8 bytes, depending on DLC)
        // The bits within a data byte are transferred MSB-first.
        else if (bitnum === this.last_databit) {
            this.ss_databytebits.push(this.samplenum); // Last databyte bit.
            this.put_data_bytes();
        }

        else if (bitnum > this.last_databit) {
            return this.decode_frame_end(can_rx, bitnum);
        }

        return false;
    }

    handle_bit(can_rx) {
        this.rawbits.push(can_rx);
        this.bits.push(can_rx);

        // Get the index of the current CAN frame bit (without stuff bits).
        const bitnum = this.bits.length - 1;

        if (this.fd && can_rx) {
            if (bitnum === 16 && this.frame_type === 'standard'
                    || bitnum === 35 && this.frame_type === 'extended') {
                this.dom_edge_seen(true);
                this.set_fast_bitrate();
            }
        }

        // If this is a stuff bit, remove it from self.bits and ignore it.
        if (this.is_stuff_bit()) {
            this.putx([15, [String(can_rx)]]);
            this.curbit += 1; // Increase self.curbit (bitnum is not affected).
            return;
        } else {
            this.putx([17, [String(can_rx)]]);
        }

        // Bit 0: Start of frame (SOF) bit
        if (bitnum === 0) {
            this.ss_packet = this.samplenum;
            this.putx([1, ['Start of frame', 'SOF', 'S']]);
            if (can_rx !== 0) {
                this.putx([16, ['Start of frame (SOF) must be a dominant bit']]);
            }
        }

        // Remember start of ID (see below).
        else if (bitnum === 1) {
            this.ss_block = this.samplenum;
        }

        // Bits 1-11: Identifier (ID[10..0])
        // The bits ID[10..4] must NOT be all recessive.
        else if (bitnum === 11) {
            // BEWARE! Don't clobber the decoder's .id field which is
            // part of its boiler plate!
            this.ident = bitpack_msb(this.bits.slice(1));
            this.fullid = this.ident;
            const s = `${this.ident} (0x${this.ident.toString(16)})`;
            this.putb([3, [`Identifier: ${s}`, `ID: ${s}`, 'ID']]);
            if ((this.ident & 0x7f0) === 0x7f0) {
                this.putb([16, ['Identifier bits 10..4 must not be all recessive']]);
            }
        }

        // RTR or SRR bit, depending on frame type (gets handled later).
        else if (bitnum === 12) {
            // self.putx([0, ['RTR/SRR: %d' % can_rx]]) # Debug only.
            this.ss_bit12 = this.samplenum;
        }

        // Bit 13: Identifier extension (IDE) bit
        // Standard frame: dominant, extended frame: recessive
        else if (bitnum === 13) {
            const ide = this.frame_type = can_rx === 0 ? 'standard' : 'extended';
            this.putx([6, [`Identifier extension bit: ${ide} frame`,
                           `IDE: ${ide} frame`, 'IDE']]);
        }

        // Bits 14-X: Frame-type dependent, passed to the resp. handlers.
        else if (bitnum >= 14) {
            let done;
            if (this.frame_type === 'standard') {
                done = this.decode_standard_frame(can_rx, bitnum);
            } else {
                done = this.decode_extended_frame(can_rx, bitnum);
            }

            // The handlers return True if a frame ended (EOF).
            if (done) {
                return;
            }
        }

        // After a frame there are 3 intermission bits (recessive).
        // After these bits, the bus is considered free.

        this.curbit += 1;
    }

    decode() {
        if (!this.samplerate) {
            throw new Error('CAN: Cannot decode without samplerate.');   // SamplerateError
        }

        for (;;) {
            // State machine.
            if (this.state === 'IDLE') {
                // Wait for a dominant state (logic 0) on the bus.
                if (!this.w.wait({ 0: 'l' })) return;
                this.sof = this.samplenum;
                this.dom_edge_seen(true);
                this.state = 'GET BITS';
            } else if (this.state === 'GET BITS') {
                // Wait until we're in the correct bit/sampling position.
                const pos = this.get_sample_point(this.curbit);
                const pins = this.w.wait([{ skip: pos - this.samplenum }, { 0: 'f' }]);
                if (!pins) return;
                const [can_rx] = pins;
                if (this.w.matched[1]) {
                    this.dom_edge_seen();
                }
                if (this.w.matched[0]) {
                    this.handle_bit(can_rx);
                }
            }
        }
    }
}

class CANDecoder extends Decoder {

    static Info = {
        name: 'CAN',
        longname: 'Controller Area Network',
        desc: 'Field bus protocol for distributed realtime control.',
        class: CANDecoder
    };

    static GuiConfigData = {
        can_rx: { label: 'CAN RX (bus line)', type: 'channel', default: 0 },
        nominal_bitrate: { label: 'Nominal bitrate (bits/s)', type: 'number', default: 1000000 },
        fast_bitrate: { label: 'Fast bitrate (bits/s)', type: 'number', default: 2000000 },
        sample_point: { label: 'Sample point (%)', type: 'number', default: 70.0 },
    };

    // annotations: the row (annotation_rows: bits = 15, 17; fields = 0..14; warnings = 16) and color of each
    static Annotations = [
        ['fields', 'DATA'],      //  0 data           Payload data
        ['fields', 'CONTROL'],   //  1 sof            Start of frame
        ['fields', 'CONTROL'],   //  2 eof            End of frame
        ['fields', 'ADDRESS'],   //  3 id             Identifier
        ['fields', 'ADDRESS'],   //  4 ext-id         Extended identifier
        ['fields', 'ADDRESS'],   //  5 full-id        Full identifier
        ['fields', 'CONTROL'],   //  6 ide            Identifier extension bit
        ['fields', 'CONTROL'],   //  7 reserved-bit   Reserved bit 0 and 1
        ['fields', 'CONTROL'],   //  8 rtr            Remote transmission request
        ['fields', 'CONTROL'],   //  9 srr            Substitute remote request
        ['fields', 'CONTROL'],   // 10 dlc            Data length count
        ['fields', 'CONTROL'],   // 11 crc-sequence   CRC sequence
        ['fields', 'CONTROL'],   // 12 crc-delimiter  CRC delimiter
        ['fields', 'ACK'],       // 13 ack-slot       ACK slot
        ['fields', 'CONTROL'],   // 14 ack-delimiter  ACK delimiter
        ['bits', 'CONTROL'],     // 15 stuff-bit      Stuff bit
        ['warnings', 'WARN'],    // 16 warning        Warning
        ['bits', 'DATA'],        // 17 bit            Bit
    ];

    static GetSourceTypes() {
        return ['logic', CustomDecoder.TYPE];
    }

    constructor(p) {
        super(p);
        this.signals = ['can_rx'];
        this.frames = [];
    }

    getCfgGui() {
        return CANDecoder.GuiConfigData;
    }

    getOutput() {
        return this.frames;
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => (typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—');
        return `${name(c.can_rx)} · ${c.nominal_bitrate} bit/s`;
    }

    rows() {
        return {
            bits: { label: 'Bits', anchor: { signal: 'can_rx' }, placement: 'after' },
            fields: { label: 'Fields', anchor: { signal: 'can_rx' }, placement: 'after' },
            warnings: { label: 'Warnings', anchor: { signal: 'can_rx' }, placement: 'after' },
        };
    }

    run() {
        const buf = this.getSource();
        const cfg = this.cfg;
        const { ANN } = window.WS.theme;
        const out = { bits: [], fields: [], warnings: [] };
        this.frames = [];

        if (!buf?.samplerate)
            throw new Error('CAN: Cannot decode without samplerate.');   // SamplerateError
        if (typeof cfg.can_rx !== 'number' || buf.length < 2)
            return out;

        const last = buf.length - 1;
        const put = (ss, es, [cls, texts]) => {
            const [row, color] = CANDecoder.Annotations[cls];
            // a NACK (recessive ACK slot) is drawn as one
            const c = cls === 13 && texts[0].endsWith('NACK') ? ANN.NACK : ANN[color];
            const start = Math.max(0, ss), end = Math.min(last, Math.max(start, es));
            out[row].push({ start, end, class: c, text: texts });
        };
        const putpy = (ss, es, [frameType, id, rtr, dlc, bytes]) =>
            this.frames.push({ type: 'FRAME', data: { frameType, id, rtr, dlc, bytes }, start: ss, end: es });

        new CanDecodeRun(buf, cfg.can_rx, {
            nominal_bitrate: cfg.nominal_bitrate,
            fast_bitrate: cfg.fast_bitrate,
            sample_point: cfg.sample_point,
        }, put, putpy).decode();
        return out;
    }
}

window.WS.decoders.registry.push(CANDecoder.Info);
