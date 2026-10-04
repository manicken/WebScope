class I2CFrame {
    constructor() {
        /* where in the buffer this frame begins */
        this.bufferIndex = 0;
        this.address = 0x00;
        this.payload = [];
    }
}

class I2CDecoder extends Decoder {

    static Info = {
        name: "I2C",
        class: I2CDecoder
    };

    static GuiConfigData = {
        scl:{ label: 'SCL', type: 'channel', default: 1},
        sda:{ label: 'SDA', type: 'channel', default: 2},
        format: { ...FORMAT_FIELD, default: 'hex'},
        subDecoders:{ label: 'subDecoders', type: 'subDecoders', default: []},
    }

    constructor() {
        super();
        this.frames = [];
    }

    run(buf) {
        this.frames = [];
        const ANN = window.WS.theme;
        const sclBit = 1 << this.cfg.scl, sdaBit = 1 << this.cfg.sda;
        const sclHigh = (i) => !!(buf.samples[i] & sclBit);
        const sdaAt = (i) => (buf.samples[i] & sdaBit) ? 1 : 0;
        const anns = [];
        let inTx = false, bitBuf = 0, bitCount = 0, isAddress = true, byteStart = 0;
        let frame = new I2CFrame();
        for (let i = 1; i < buf.length; i++) {
            const prevScl = sclHigh(i - 1), curScl = sclHigh(i);
            const prevSda = sdaAt(i - 1), curSda = sdaAt(i);

            if (prevScl && curScl) {
                if (prevSda === 1 && curSda === 0) { // SDA falls while SCL high: START
                    frame = new I2CFrame();
                    anns.push({ start: i, end: i+2, row: 0, class: ANN.CONTROL, text: 'START' });
                    inTx = true; bitBuf = 0; bitCount = 0; isAddress = true;
                    continue;
                }
                if (prevSda === 0 && curSda === 1) { // SDA rises while SCL high: STOP
                    this.frames.push(frame);
                    anns.push({ start: i, end: i+2, row: 0, class: ANN.CONTROL, text: 'STOP' });
                    inTx = false;
                    continue;
                }
            }

            if (inTx && !prevScl && curScl) { // rising SCL edge: sample a bit
                if (bitCount < 8) {
                    if (bitCount === 0) byteStart = i;
                    bitBuf = (bitBuf << 1) | curSda;
                    bitCount++;
                } else {
                    const ack = curSda === 0; // ACK is SDA held low
                    let text;
                    if (isAddress) {
                        const addr = bitBuf >> 1, rw = bitBuf & 1;
                        text = `0x${addr.toString(16).padStart(2, '0')} ${rw ? 'R' : 'W'}`;
                        isAddress = false;
                        frame.bufferIndex = byteStart;
                        frame.address = addr;
                    } else {
                        text = this.cfg.format === 'hex' ? '0x' + bitBuf.toString(16).padStart(2, '0').toUpperCase() : String(bitBuf);
                        frame.payload.push(bitBuf);
                    }
                    let end = i + 1;
                    while ( end < buf.length && sclHigh(end)) { end++; }
                    while ( end < buf.length && sclHigh(end) == false) { end++; }
                    anns.push({ start: byteStart, end: i, row: 0, class: ANN.DATA , text });
                    anns.push({ start: i, end, row: 0, class: ack ? ANN.ACK : ANN.NACK, text: ack ? 'ACK' : ' NACK' });
                    bitBuf = 0; bitCount = 0;
                }
            }
        }
        let row = 1;
        for (let sub of this.subDecoders) {
            let result  = sub.decode(this.frames);
            for (const ann of result.anns) {
                anns.push({ ...ann, row });
            }
            row++;
        }
        return {anns};
    }
}

window.WS.decoderregistry.push(I2CDecoder.Info);