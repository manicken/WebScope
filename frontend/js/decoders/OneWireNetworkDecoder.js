//
// This file is part of the libsigrokdecode project.
//
// Copyright (C) 2012 Iztok Jeras <iztok.jeras@gmail.com>
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
// Ported to JavaScript for WebScope from libsigrokdecode decoders/onewire_network (pd.py and __init__.py).
//
// From __init__.py:
//
//   Copyright (C) 2012 Uwe Hermann <uwe@hermann-uwe.de>
//   Copyright (C) 2017 Kevin Redon <kingkevin@cuvoodoo.info>
//   (GNU General Public License, version 2 or (at your option) any later version, as above.)
//
//   This decoder stacks on top of the 'onewire_link' PD and decodes the
//   1-Wire protocol (network layer).
//
//   The 1-Wire protocol enables bidirectional communication over a single wire
//   (and ground) between a single master and one or multiple slaves. The protocol
//   is layered:
//
//    - Link layer (reset, presence detection, reading/writing bits)
//    - Network layer (skip/search/match device ROM addresses)
//    - Transport layer (transport data between 1-Wire master and device)
//
//   Network layer:
//
//   The following link layer annotations are shown:
//
//    - RESET/PRESENCE True/False
//      The event is marked from the signal negative edge to the end of the reset
//      high period. It is also reported if there are any devices attached to the
//      bus.
//
//   The following network layer annotations are shown:
//
//    - ROM command <val> <name>
//      The requested ROM command is displayed as an 8bit hex value and by name.
//    - ROM <val>
//      The 64bit value of the addressed device is displayed:
//      Family code (1 byte) + serial number (6 bytes) + CRC (1 byte)
//    - Data <val>
//      Data intended for the transport layer is displayed as an 8bit hex value.
//
//   TODO:
//    - Add CRC checks, to see if there were communication errors on the wire.
//    - Add reporting original/complement address values from the search algorithm.
//
// Port notes:
//  - Input: the output of OneWireLinkDecoder ([{ type, data, start, end }]); output (getOutput()):
//    [{ type: 'RESET/PRESENCE' | 'ROM' | 'DATA', data, start, end }], ROM as a BigInt (64 bits).
//  - The collected bits are BigInts, since a ROM address is 64 bits (JavaScript numbers hold 53).
//  - The original has one annotation class ('text'); here they are colored by what they are.

class OneWireNetworkDecoder extends Decoder {

    static Info = {
        name: '1-Wire network layer',
        longname: '1-Wire serial communication bus (network layer)',
        desc: 'Bidirectional, half-duplex, asynchronous serial bus.',
        class: OneWireNetworkDecoder
    };

    static GuiConfigData = {};

    // Dictionary of ROM commands and their names, next state.
    static command = {
        0x33: ['Read ROM'                  , 'GET ROM'   ],
        0x0f: ['Conditional read ROM'      , 'GET ROM'   ],
        0xcc: ['Skip ROM'                  , 'TRANSPORT' ],
        0x55: ['Match ROM'                 , 'GET ROM'   ],
        0xf0: ['Search ROM'                , 'SEARCH ROM'],
        0xec: ['Conditional search ROM'    , 'SEARCH ROM'],
        0x3c: ['Overdrive skip ROM'        , 'TRANSPORT' ],
        0x69: ['Overdrive match ROM'       , 'GET ROM'   ],
        0xa5: ['Resume'                    , 'TRANSPORT' ],
        0x96: ['DS2408: Disable Test Mode' , 'GET ROM'   ],
    };

    static GetSourceTypes() {
        return [CustomDecoder.TYPE, OneWireLinkDecoder.TYPE];
    }

    constructor(p) {
        super(p);
        this.frames = [];
    }

    getCfgGui() {
        return OneWireNetworkDecoder.GuiConfigData;
    }

    getOutput() {
        return this.frames;
    }

    summary() {
        return '';
    }

    rows() {
        return {
            text: { label: 'Text', anchor: { decoder: this.parent.id }, placement: 'after' },
        };
    }

    run() {
        const source = this.getSource();
        const { ANN } = window.WS.theme;
        const command = OneWireNetworkDecoder.command;
        const text = [];
        this.frames = [];

        const hex2 = (v) => '0x' + Number(v).toString(16).padStart(2, '0');
        const hex16 = (v) => '0x' + BigInt(v).toString(16).padStart(16, '0');

        // reset()
        let ss_block = 0;
        let es_block = 0;
        let state = 'COMMAND';
        let bit_cnt = 0;
        let search = 'P';
        let data_p = 0n;
        let data_n = 0n;
        let data = 0n;
        let rom = 0x0000000000000000n;

        const put = (ss, es, cls, texts) => text.push({ start: ss, end: es, class: cls, text: texts });
        // Helper function for most annotations.
        const putx = (cls, texts) => put(ss_block, es_block, cls, texts);
        // Helper function for most protocol packets.
        const puty = ([type, value]) => this.frames.push({ type, data: value, start: ss_block, end: es_block });

        const setBit = (word, n, val) => (word & ~(1n << BigInt(n))) | (BigInt(val) << BigInt(n));
        const mask = (length) => (1n << BigInt(length)) - 1n;

        // Data collector.
        const onewire_collect = (length, val, ss, es) => {
            // Storing the sample this sequence begins with.
            if (bit_cnt === 0) {
                ss_block = ss;
            }
            data = setBit(data, bit_cnt, val);
            bit_cnt += 1;
            // Storing the sample this sequence ends with.
            // In case the full length of the sequence is received, return 1.
            if (bit_cnt === length) {
                es_block = es;
                data = data & mask(length);
                bit_cnt = 0;
                return 1;
            } else {
                return 0;
            }
        };

        // Search collector.
        const onewire_search = (length, val, ss, es) => {
            // Storing the sample this sequence begins with.
            if ((bit_cnt === 0) && (search === 'P')) {
                ss_block = ss;
            }

            if (search === 'P') {
                // Master receives an original address bit.
                data_p = setBit(data_p, bit_cnt, val);
                search = 'N';
            } else if (search === 'N') {
                // Master receives a complemented address bit.
                data_n = setBit(data_n, bit_cnt, val);
                search = 'D';
            } else if (search === 'D') {
                // Master transmits an address bit.
                data = setBit(data, bit_cnt, val);
                search = 'P';
                bit_cnt += 1;
            }

            // Storing the sample this sequence ends with.
            // In case the full length of the sequence is received, return 1.
            if (bit_cnt === length) {
                es_block = es;
                data_p = data_p & mask(length);
                data_n = data_n & mask(length);
                data = data & mask(length);
                search = 'P';
                bit_cnt = 0;
                return 1;
            } else {
                return 0;
            }
        };

        const decode = (ss, es, code, val) => {
            // State machine.
            if (code === 'RESET/PRESENCE') {
                search = 'P';
                bit_cnt = 0;
                put(ss, es, ANN.CONTROL, ['Reset/presence: ' + (val ? 'true' : 'false')]);
                this.frames.push({ type: 'RESET/PRESENCE', data: val, start: ss, end: es });
                state = 'COMMAND';
                return;
            }

            // For now we're only interested in 'RESET/PRESENCE' and 'BIT' packets.
            if (code !== 'BIT') {
                return;
            }

            if (state === 'COMMAND') {
                // Receiving and decoding a ROM command.
                if (onewire_collect(8, val, ss, es) === 0) {
                    return;
                }
                const cmd = command[Number(data)];
                if (cmd) {
                    putx(ANN.CONTROL, [`ROM command: ${hex2(data)} '${cmd[0]}'`]);
                    state = cmd[1];
                } else {
                    putx(ANN.ERROR, [`ROM command: ${hex2(data)} 'unrecognized'`]);
                    state = 'COMMAND ERROR';
                }
            } else if (state === 'GET ROM') {
                // A 64 bit device address is selected.
                // Family code (1 byte) + serial number (6 bytes) + CRC (1 byte)
                if (onewire_collect(64, val, ss, es) === 0) {
                    return;
                }
                rom = data & 0xffffffffffffffffn;
                putx(ANN.ADDRESS, ['ROM: ' + hex16(rom)]);
                puty(['ROM', rom]);
                state = 'TRANSPORT';
            } else if (state === 'SEARCH ROM') {
                // A 64 bit device address is searched for.
                // Family code (1 byte) + serial number (6 bytes) + CRC (1 byte)
                if (onewire_search(64, val, ss, es) === 0) {
                    return;
                }
                rom = data & 0xffffffffffffffffn;
                putx(ANN.ADDRESS, ['ROM: ' + hex16(rom)]);
                puty(['ROM', rom]);
                state = 'TRANSPORT';
            } else if (state === 'TRANSPORT') {
                // The transport layer is handled in byte sized units.
                if (onewire_collect(8, val, ss, es) === 0) {
                    return;
                }
                putx(ANN.DATA, ['Data: ' + hex2(data)]);
                puty(['DATA', Number(data)]);
            } else if (state === 'COMMAND ERROR') {
                // Since the command is not recognized, print raw data.
                if (onewire_collect(8, val, ss, es) === 0) {
                    return;
                }
                putx(ANN.ERROR, ['ROM error data: ' + hex2(data)]);
            }
        };

        for (const f of source) decode(f.start, f.end, f.type, f.data);
        return { text };
    }
}

window.WS.decoders.registry.push(OneWireNetworkDecoder.Info);
