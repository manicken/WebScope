// USB (low-speed and full-speed) packet protocol decoder

// Ported from libsigrokdecode (usb_packet)

// Copyright (C) 2011 Gareth McMullin <gareth@blacksphere.co.nz>
// Copyright (C) 2012-2014 Uwe Hermann <uwe@hermann-uwe.de>

// License: GPLv3+

class USBPacketDecoder extends Decoder {


    static Info = {
        name: 'USB packet',
        longname: 'Universal Serial Bus (LS/FS) packet',
        desc: 'USB (low-speed and full-speed) packet protocol.',
        class: USBPacketDecoder
    };

    static GuiConfigData = {
        
        //subDecoders:{ label: 'Sub-Analyzers', type: 'subDecoders', default: []},
    };

    static GetSourceTypes() {
        return [CustomDecoder.TYPE, USBSignallingDecoder.TYPE];
    }

    static PIDs = {
        // Token
        '10000111': ['OUT', 'TOKEN'],
        '10010110': ['IN', 'TOKEN'],
        '10100101': ['SOF', 'TOKEN'],
        '10110100': ['SETUP', 'TOKEN'],

        // Data
        '11000011': ['DATA0', 'DATA'],
        '11010010': ['DATA1', 'DATA'],
        '11100001': ['DATA2', 'DATA'],
        '11110000': ['MDATA', 'DATA'],

        // Handshake
        '01001011': ['ACK', 'HANDSHAKE'],
        '01011010': ['NAK', 'HANDSHAKE'],
        '01111000': ['STALL', 'HANDSHAKE'],
        '01101001': ['NYET', 'HANDSHAKE'],

        // Special
        '00111100': ['PRE', 'SPECIAL'],
        '00011110': ['SPLIT', 'SPECIAL'],
        '00101101': ['PING', 'SPECIAL'],
        '00001111': ['Reserved', 'SPECIAL']
    };

    static PacketAnnotations = [
        'OUT', 'IN', 'SOF', 'SETUP',
        'DATA0', 'DATA1', 'DATA2', 'MDATA',
        'ACK', 'NAK', 'STALL', 'NYET',
        'PRE', 'ERR', 'SPLIT', 'PING', 'Reserved'
    ];

    getCfgGui() {
        return USBPacketDecoder.GuiConfigData;
    }

    constructor(p) {
        super(p);

        this.signals = [];
        this.frames = [];

        this.reset();
    }

    reset() {
        this.bits = [];
        this.packet = [];
        this.packetSummary = '';

        this.packetStart = null;
        this.packetEnd = null;

        this.state = 'WAIT FOR SOP';
    }

    getOutput() {
        return this.frames;
    }

    summary() {
        return 'USB packet decoder';
    }

    rows() {
        return {
            fields: {
                label: 'Packet fields',
                anchor: { decoder: this.parent.id },
                placement: 'after'
            },
            packet: {
                label: 'Packets',
                anchor: { decoder: this.parent.id },
                placement: 'after'
            }
        };
    }

    bitStringToNumber(bitString) {
        if (!bitString)
            return 0;

        // USB transmits the least significant bit first.
        return parseInt([...bitString].reverse().join(''), 2);
    }

    reverseNumber(num, count) {
        let out = 0;

        for (let i = 0; i < count; i++) {
            if ((num >> i) & 1)
                out |= 1 << (count - 1 - i);
        }

        return out;
    }

    calcCRC5(bitString) {
        const poly = 0x25;
        let crc = 0x1f;

        for (const bit of bitString) {
            crc <<= 1;

            if (Number(bit) !== (crc >> 5))
                crc ^= poly;

            crc &= 0x1f;
        }

        crc ^= 0x1f;

        return this.reverseNumber(crc, 5);
    }

    calcCRC16(bitString) {
        const poly = 0x18005;
        let crc = 0xffff;

        for (const bit of bitString) {
            crc <<= 1;

            if (Number(bit) !== (crc >> 16))
                crc ^= poly;

            crc &= 0xffff;
        }

        crc ^= 0xffff;

        return this.reverseNumber(crc, 16);
    }

    getCategory(pidName) {
        if (['OUT', 'IN', 'SOF', 'SETUP'].includes(pidName))
            return 'TOKEN';

        if (['DATA0', 'DATA1', 'DATA2', 'MDATA'].includes(pidName))
            return 'DATA';

        if (['ACK', 'NAK', 'STALL', 'NYET'].includes(pidName))
            return 'HANDSHAKE';

        return 'SPECIAL';
    }

    getPacketAnnotationIndex(pidName) {
        const index = USBPacketDecoder.PacketAnnotations.indexOf(pidName);
        return index === -1 ? 28 : index + 11;
    }

    /**
     * Add a machine-readable protocol event.
     *
     * Event format:
     * {
     *   type: 'PID',
     *   data: 'DATA0',
     *   start: sample,
     *   end: sample
     * }
     */
    putPython(type, data, start = this.fieldStart, end = this.fieldEnd) {
        this.frames.push({
            type,
            data,
            start,
            end
        });
    }

    /**
     * Add a visual field annotation.
     */
    putField(text, start = this.fieldStart, end = this.fieldEnd) {
        this.fieldAnnotations.push({
            start,
            end,
            class: window.WS.theme.DATA,
            text
        });
    }

    /**
     * Add a complete packet annotation.
     */
    putPacket(text, start = this.packetStart, end = this.packetEnd) {
        this.packetAnnotations.push({
            start,
            end,
            class: window.WS.theme.DATA,
            text
        });
    }

    /**
     * Decode the accumulated packet bits.
     */
    handlePacket() {
        const packetBits = this.bits.map(b => b.bit).join('');

        if (packetBits.length < 8) {
            this.putPacket('Invalid packet (shorter than 8 bits)');
            return;
        }

        // SYNC: bits 0–7
        const sync = packetBits.slice(0, 8);

        this.fieldStart = this.bits[0].start;
        this.fieldEnd = this.bits[7].end;

        if (sync !== '00000001') {
            this.putPython('SYNC ERROR', sync);
            this.putField(`SYNC ERROR: ${sync}`);
        } else {
            this.putPython('SYNC', sync);
            this.putField(`SYNC: ${sync}`);
        }

        this.packet.push(sync);

        if (packetBits.length < 16) {
            this.putPacket('Invalid packet (shorter than 16 bits)');
            return;
        }

        // PID: bits 8–15
        const pid = packetBits.slice(8, 16);
        const [pidName] = USBPacketDecoder.PIDs[pid] ?? ['UNKNOWN', 'SPECIAL'];

        this.fieldStart = this.bits[8].start;
        this.fieldEnd = this.bits[15].end;

        this.putPython('PID', pidName);
        this.putField(`PID: ${pidName}`);

        this.packet.push(pid);
        this.packetSummary += pidName;

        if (['OUT', 'IN', 'SOF', 'SETUP', 'PING'].includes(pidName)) {
            if (packetBits.length < 32) {
                this.putPacket('Invalid packet (shorter than 32 bits)');
                return;
            }

            if (pidName === 'SOF') {
                // FRAMENUM: bits 16–26
                const frameNum = this.bitStringToNumber(packetBits.slice(16, 27));

                this.fieldStart = this.bits[16].start;
                this.fieldEnd = this.bits[26].end;

                this.putPython('FRAMENUM', frameNum);
                this.putField(`Frame: ${frameNum}`);

                this.packet.push(frameNum);
                this.packetSummary += ` ${frameNum}`;
            } else {
                // ADDR: bits 16–22
                const addr = this.bitStringToNumber(packetBits.slice(16, 23));

                this.fieldStart = this.bits[16].start;
                this.fieldEnd = this.bits[22].end;

                this.putPython('ADDR', addr);
                this.putField(`Address: ${addr}`);

                this.packet.push(addr);
                this.packetSummary += ` ADDR ${addr}`;

                // EP: bits 23–26
                const ep = this.bitStringToNumber(packetBits.slice(23, 27));

                this.fieldStart = this.bits[23].start;
                this.fieldEnd = this.bits[26].end;

                this.putPython('EP', ep);
                this.putField(`Endpoint: ${ep}`);

                this.packet.push(ep);
                this.packetSummary += ` EP ${ep}`;
            }

            // CRC5: bits 27–31
            const crc5 = this.bitStringToNumber(packetBits.slice(27, 32));
            const crc5Calc = this.calcCRC5(packetBits.slice(16, 27));

            this.fieldStart = this.bits[27].start;
            this.fieldEnd = this.bits[31].end;

            if (crc5 === crc5Calc) {
                this.putPython('CRC5', crc5);
                this.putField(`CRC5: 0x${crc5.toString(16).toUpperCase().padStart(2, '0')}`);
            } else {
                this.putPython('CRC5 ERROR', crc5);
                this.putField(`CRC5 ERROR: 0x${crc5.toString(16).toUpperCase().padStart(2, '0')}`);
            }

            this.packet.push(crc5);
        } else if (['DATA0', 'DATA1', 'DATA2', 'MDATA'].includes(pidName)) {
            // Data payload is everything between PID and CRC16.
            const dataBits = packetBits.slice(16, -16);
            const dataBytes = [];

            this.packetSummary += ' [';

            for (let i = 0; i < dataBits.length; i += 8) {
                const byteBits = dataBits.slice(i, i + 8);
                const byte = this.bitStringToNumber(byteBits);

                dataBytes.push(byte);

                if (i + 8 <= dataBits.length) {
                    this.fieldStart = this.bits[16 + i].start;
                    this.fieldEnd = this.bits[23 + i].end;

                    this.putPython('DATABYTE', byte);

                    const hex = byte.toString(16).toUpperCase().padStart(2, '0');
                    this.putField(`Databyte: ${hex}`);

                    this.packetSummary += ` ${hex}`;
                }
            }

            this.packetSummary += ' ]';

            if (packetBits.length < 32) {
                this.putPacket('Invalid packet (shorter than 32 bits)');
                return;
            }

            // Convenience event containing all data bytes.
            this.fieldStart = this.bits[16].start;
            this.fieldEnd = this.bits[packetBits.length - 17].end;

            this.putPython('DATABYTES', dataBytes);
            this.packet.push(dataBytes);

            // CRC16: final 16 bits
            const crc16 = this.bitStringToNumber(packetBits.slice(-16));
            const crc16Calc = this.calcCRC16(dataBits);

            this.fieldStart = this.bits[packetBits.length - 16].start;
            this.fieldEnd = this.bits[packetBits.length - 1].end;

            if (crc16 === crc16Calc) {
                this.putPython('CRC16', crc16);
                this.putField(`CRC16: 0x${crc16.toString(16).toUpperCase().padStart(4, '0')}`);
            } else {
                this.putPython('CRC16 ERROR', crc16);
                this.putField(`CRC16 ERROR: 0x${crc16.toString(16).toUpperCase().padStart(4, '0')}`);
            }

            this.packet.push(crc16);
        } else if (['ACK', 'NAK', 'STALL', 'NYET', 'ERR', 'PRE'].includes(pidName)) {
            // These packet types have no additional fields here.
        }

        // Complete packet event.
        const category = this.getCategory(pidName);

        this.putPython('PACKET', [
            category,
            pidName,
            this.packet
        ], this.packetStart, this.packetEnd);

        this.putPacket(
            this.packetSummary,
            this.packetStart,
            this.packetEnd
        );
    }

    /**
     * Read usb_signalling events and decode complete USB packets.
     *
     * Expected source event format:
     * {
     *   type: 'SOP' | 'BIT' | 'EOP' | 'ERR',
     *   data: bit value or other event data,
     *   start: sample position,
     *   end: sample position
     * }
     */
    run() {
        console.log("packer is running");
        const source = this.getSource();

        this.frames = [];
        this.fieldAnnotations = [];
        this.packetAnnotations = [];

        this.reset();

        for (const event of source) {
            const { type, data, start, end } = event;

            if (!['SOP', 'BIT', 'EOP', 'ERR'].includes(type))
                continue;

            if (this.state === 'WAIT FOR SOP') {
                if (type !== 'SOP')
                    continue;

                this.packetStart = start;
                this.state = 'GET BIT';
                continue;
            }

            if (this.state === 'GET BIT') {
                if (type === 'BIT') {
                    this.bits.push({
                        bit: String(data),
                        start,
                        end
                    });
                } else if (type === 'EOP' || type === 'ERR') {
                    this.packetEnd = end;

                    this.handlePacket();

                    this.bits = [];
                    this.packet = [];
                    this.packetSummary = '';
                    this.packetStart = null;
                    this.packetEnd = null;
                    this.state = 'WAIT FOR SOP';
                }
            }
        }

        return {
            fields: this.fieldAnnotations,
            packet: this.packetAnnotations
        };
    }
}

window.WS.decoders.registry.push(USBPacketDecoder.Info);