// USB (low-speed and full-speed) transaction/request protocol decoder

// Ported from libsigrokdecode (usb_request)

// Copyright (C) 2015 Stefan Brüns <stefan.bruens@rwth-aachen.de>

// License: GPLv2+

/**
 * Linux usbmon style packet used for the PCAP export
 * (port of pcap_usb_pkt from the Python decoder).
 * All integers are big-endian, exactly like the original.
 */
class USBRequestPcapPacket {
    constructor(req, ts, isSubmit) {
        this.header = new Uint8Array(64);
        this.view = new DataView(this.header.buffer);

        this.header[8] = isSubmit ? 0x53 : 0x43;   // 'S'ubmit / 'C'omplete
        this.header[9] = 3;                        // transfer type: Bulk
        this.header[14] = 0x2d;                    // setup tag '-' (no setup)
        this.header[15] = 0x3c;                    // data tag '<' (no data)

        this.timestamp = ts;

        this.view.setUint32(4, req.id);            // URB id
        this.view.setUint32(20, ts[0]);            // seconds
        this.view.setUint32(24, ts[1]);            // microseconds

        this.header[11] = req.addr;
        this.header[10] = req.ep;

        if (req.type === 'SETUP IN' || req.type === 'SETUP OUT') {
            this.header[9] = 2;                    // Control
            this.header[14] = 0;                   // setup present
            this.header.set(Array.from(req.setupData).slice(0, 8), 40);
        }

        if (req.type === 'BULK IN')
            this.header[10] = 0x80 | req.ep;

        this.data = Uint8Array.from(req.data);
        this.header[15] = 0;                       // data present
        this.view.setUint32(36, this.data.length); // data length
    }

    get length() {
        return 64 + this.data.length;
    }

    packet() {
        const out = new Uint8Array(this.length);
        out.set(this.header, 0);
        out.set(this.data, 64);
        return out;
    }

    recordHeader() {
        // libpcap per-packet record header, no truncation.
        const out = new Uint8Array(16);
        const v = new DataView(out.buffer);
        v.setUint32(0, this.timestamp[0]);
        v.setUint32(4, this.timestamp[1]);
        v.setUint32(8, this.length);
        v.setUint32(12, this.length);
        return out;
    }
}

class USBRequestDecoder extends Decoder {

    static Info = {
        name: 'USB request',
        longname: 'Universal Serial Bus (LS/FS) transaction/request',
        desc: 'USB (low-speed/full-speed) transaction/request protocol.',
        class: USBRequestDecoder
    };

    static GuiConfigData = {
        // Original option: in_request_start ('submit' | 'first-ack').
        // Not exposed in the GUI yet, see this.inRequestStart in the constructor.
    };

    static GetSourceTypes() {
        return [CustomDecoder.TYPE, USBPacketDecoder.TYPE];
    }

    getCfgGui() {
        return USBRequestDecoder.GuiConfigData;
    }

    constructor(p) {
        super(p);

        // 'submit'    : BULK IN requests start at the SUBMIT (first token)
        // 'first-ack' : BULK IN requests start at the first transaction with data
        this.inRequestStart = 'submit';

        // Needed for PCAP timestamps only. Set this from wherever the
        // capture's sample rate lives. Annotations work without it.
        this.samplerate = null;

        this.frames = [];

        this.reset();
    }

    reset() {
        this.requests = new Map();      // key `${addr}:${ep}` -> request
        this.requestId = 0;

        this.transactionState = 'IDLE';
        this.ssTransaction = null;
        this.esTransaction = null;
        this.transactionEp = null;
        this.transactionAddr = null;
        this.transactionType = null;
        this.transactionData = [];
        this.handshake = null;

        this.pcapChunks = [];

        this.out = { setup: [], bulkIn: [], bulkOut: [], errors: [] };
    }

    getOutput() {
        return this.frames;
    }

    summary() {
        return 'USB request decoder';
    }

    rows() {
        const anchor = { decoder: this.parent.id };

        return {
            setup: { label: 'USB SETUP', anchor, placement: 'after' },
            bulkIn: { label: 'USB BULK IN', anchor, placement: 'after' },
            bulkOut: { label: 'USB BULK OUT', anchor, placement: 'after' },
            errors: { label: 'Errors', anchor, placement: 'after' }
        };
    }

    // ---------------------------------------------------------------- helpers

    putr(row, start, end, text) {
        const theme = window.WS.theme;

        this.out[row].push({
            start,
            end,
            class: row === 'errors' ? (theme.ERROR ?? theme.DATA) : theme.DATA,
            text
        });
    }

    hex2(b) {
        return b.toString(16).toUpperCase().padStart(2, '0');
    }

    requestKey(addr, ep) {
        return `${addr}:${ep}`;
    }

    tsFromSample(sample) {
        if (!this.samplerate)
            return [0, 0];

        const ts = sample / this.samplerate;
        return [Math.floor(ts), Math.floor((ts % 1) * 1e6)];
    }

    /**
     * PCAP file (LINKTYPE_USB_LINUX_MMAPPED) of all requests seen in the last run().
     * Returns a Uint8Array. Timestamps are 0 unless this.samplerate is set.
     */
    getPcap() {
        const globalHeader = Uint8Array.from([
            0xa1, 0xb2, 0xc3, 0xd4,   // magic, microsecond resolution
            0x00, 0x02,               // major 2
            0x00, 0x04,               // minor 4
            0x00, 0x00, 0x00, 0x00,   // correction vs. UTC
            0x00, 0x00, 0x00, 0x00,   // timestamp accuracy
            0xff, 0xff, 0xff, 0xff,   // max packet length
            0x00, 0x00, 0x00, 0xdc    // link layer: 220
        ]);

        const chunks = [globalHeader, ...this.pcapChunks];
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);

        let pos = 0;
        for (const c of chunks) {
            out.set(c, pos);
            pos += c.length;
        }

        return out;
    }

    // ------------------------------------------------------------ transfers

    requestSummary(request) {
        let s = '[';

        if (request.type === 'SETUP IN' || request.type === 'SETUP OUT') {
            for (const b of request.setupData)
                s += ` ${this.hex2(b)}`;

            s += ' ][';
        }

        for (const b of request.data)
            s += ` ${this.hex2(b)}`;

        s += ` ] : ${request.handshake ?? 'no handshake'}`;

        return s;
    }

    handleRequest(requestStart, requestEnd) {
        if (requestStart !== 1 && requestEnd !== 1)
            return;

        const key = this.requestKey(this.transactionAddr, this.transactionEp);
        const request = this.requests.get(key);

        const ss = request.ss;
        const es = request.es;
        let ssData = request.ssData;

        if (this.inRequestStart === 'submit')
            ssData = ss;

        if (requestStart === 1) {
            // PCAP 'SUBMIT' packet
            const pkt = new USBRequestPcapPacket(request, this.tsFromSample(ss), true);
            this.pcapChunks.push(pkt.recordHeader(), pkt.packet());
        }

        if (requestEnd === 1) {
            const summary = this.requestSummary(request);

            if (request.type === 'SETUP IN')
                this.putr('setup', ss, es, `SETUP in: ${summary}`);
            else if (request.type === 'SETUP OUT')
                this.putr('setup', ss, es, `SETUP out: ${summary}`);
            else if (request.type === 'BULK IN')
                this.putr('bulkIn', ssData ?? ss, es, `BULK in: ${summary}`);
            else if (request.type === 'BULK OUT')
                this.putr('bulkOut', ss, es, `BULK out: ${summary}`);

            // Machine-readable event for decoders stacked on top of this one.
            this.frames.push({
                type: 'REQUEST',
                data: {
                    type: request.type,
                    addr: request.addr,
                    ep: request.ep,
                    setupData: request.setupData,
                    data: request.data,
                    handshake: request.handshake
                },
                start: ss,
                end: es
            });

            // PCAP 'COMPLETE' packet
            const pkt = new USBRequestPcapPacket(request, this.tsFromSample(es), false);
            this.pcapChunks.push(pkt.recordHeader(), pkt.packet());

            this.requests.delete(key);
        }
    }

    handleTransfer() {
        let requestStarted = 0;
        const requestEnd = ['ACK', 'STALL', 'timeout'].includes(this.handshake) ? 1 : 0;
        const ep = this.transactionEp;
        const addr = this.transactionAddr;
        const key = this.requestKey(addr, ep);

        // Handle protocol STALLs, condition lasts until next SETUP transfer (8.5.3.4)
        if (this.transactionType === 'SETUP' && this.requests.has(key)) {
            const old = this.requests.get(key);

            if (old.type === 'SETUP IN' || old.type === 'SETUP OUT') {
                old.es = this.ssTransaction;
                this.handleRequest(0, 1);
            }
        }

        if (!this.requests.has(key)) {
            this.requests.set(key, {
                setupData: [],
                data: [],
                type: null,
                ss: this.ssTransaction,
                es: null,
                ssData: null,
                id: this.requestId,
                addr,
                ep
            });

            this.requestId++;
            requestStarted = 1;
        }

        const request = this.requests.get(key);

        if (requestEnd) {
            request.es = this.esTransaction;
            request.handshake = this.handshake;
        }

        const t = this.transactionType;
        const td = this.transactionData;

        // BULK or INTERRUPT transfer
        if ((request.type === null || request.type === 'BULK IN') && t === 'IN') {
            request.type = 'BULK IN';

            if (request.data.length === 0 && td.length > 0)
                request.ssData = this.ssTransaction;

            request.data.push(...td);
            this.handleRequest(requestStarted, requestEnd);
        } else if ((request.type === null || request.type === 'BULK OUT') && t === 'OUT') {
            request.type = 'BULK OUT';

            if (this.handshake === 'ACK')
                request.data.push(...td);

            this.handleRequest(requestStarted, requestEnd);
        }

        // CONTROL, SETUP stage
        else if (request.type === null && t === 'SETUP') {
            request.setupData = td;
            request.wLength = (td[6] ?? 0) | ((td[7] ?? 0) << 8);

            if ((td[0] ?? 0) & 0x80) {
                request.type = 'SETUP IN';
                this.handleRequest(1, 0);
            } else {
                request.type = 'SETUP OUT';
                this.handleRequest(request.wLength === 0 ? 1 : 0, 0);
            }
        }

        // CONTROL, DATA stage
        else if (request.type === 'SETUP IN' && t === 'IN') {
            request.data.push(...td);
        } else if (request.type === 'SETUP OUT' && t === 'OUT') {
            if (this.handshake === 'ACK')
                request.data.push(...td);

            if (request.wLength === request.data.length)
                this.handleRequest(1, 0);
        }

        // CONTROL, STATUS stage
        else if (request.type === 'SETUP IN' && t === 'OUT') {
            this.handleRequest(0, requestEnd);
        } else if (request.type === 'SETUP OUT' && t === 'IN') {
            this.handleRequest(0, requestEnd);
        }
    }

    // --------------------------------------------------------------- packets

    /**
     * Handle one 'PACKET' event from the usb_packet decoder.
     *
     * event.data = [category, pidName, packet] where packet is
     *   TOKEN:     [sync, pid, addr, ep, crc5]
     *   DATA:      [sync, pid, dataBytes, crc16]
     *   HANDSHAKE: [sync, pid]
     */
    handlePacketEvent(event) {
        const ss = event.start;
        const es = event.end;
        const [category, pname, pinfo] = event.data;

        const stateError = () => this.putr('errors', ss, es,
            `ERR: received ${pname} token in state ${this.transactionState}`);

        if (category === 'TOKEN') {
            if (pname === 'SOF')
                return;

            if (this.transactionState === 'TOKEN RECEIVED') {
                // Token length is 35 bits, timeout is 16..18 bit times
                // (USB 2.0 7.1.19.1).
                const transactionTimeout = this.esTransaction +
                    Math.trunc((this.esTransaction - this.ssTransaction) / 2);

                if (ss > transactionTimeout) {
                    this.esTransaction = transactionTimeout;
                    this.handshake = 'timeout';
                    this.handleTransfer();
                    this.transactionState = 'IDLE';
                }
            }

            if (this.transactionState !== 'IDLE') {
                stateError();
                return;
            }

            const [, , addr, ep] = pinfo;

            this.transactionData = [];
            this.ssTransaction = ss;
            this.esTransaction = es;
            this.transactionState = 'TOKEN RECEIVED';
            this.transactionEp = ep;

            if (ep > 0 && pname === 'IN')
                this.transactionEp = ep + 0x80;

            this.transactionAddr = addr;
            this.transactionType = pname;   // IN OUT SETUP
        } else if (category === 'DATA') {
            if (this.transactionState !== 'TOKEN RECEIVED') {
                stateError();
                return;
            }

            this.transactionData = pinfo[2];
            this.transactionState = 'DATA RECEIVED';
        } else if (category === 'HANDSHAKE') {
            if (this.transactionState !== 'TOKEN RECEIVED' &&
                this.transactionState !== 'DATA RECEIVED') {
                stateError();
                return;
            }

            this.handshake = pname;
            this.transactionState = 'IDLE';
            this.esTransaction = es;
            this.handleTransfer();
        } else if (pname === 'PRE') {
            return;
        } else {
            this.putr('errors', ss, es,
                `ERR: received unhandled ${pname} token in state ${this.transactionState}`);
        }
    }

    run() {
        const source = this.getSource();

        this.frames = [];
        this.reset();

        for (const event of source) {
            if (event.type !== 'PACKET')
                continue;

            this.handlePacketEvent(event);
        }

        return this.out;
    }
}

window.WS.decoders.registry.push(USBRequestDecoder.Info);
