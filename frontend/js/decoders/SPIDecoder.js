

class SPIDecoder extends Decoder {

    static Info = {
        name: "SPI",
        class: SPIDecoder
    };

    static GuiConfigData = {
        clk:{ label: 'Clock', type: 'channel', default:3 },
        mosi:{ label: 'MOSI', type: 'channel?', default:4 },
        miso:{ label: 'MISO', type: 'channel?', default:5 },
        cs:{ label: 'Enable', type: 'channel?', default:6 },
        csActiveLow:{ label: 'Enable active low', type: 'bool', default:true },
        cpol:{ label: 'CPOL', type: 'select', options: [[0, '0 · idle low'], [1, '1 · idle high']], default:0 },
        cpha:{ label: 'CPHA', type: 'select', options: [[0, '0 · leading edge'], [1, '1 · trailing edge']], default:0 },
        wordBits:{ label: 'Bits/word', type: 'number', default:8 },
        msbFirst:{ label: 'MSB first', type: 'bool', default:true },
        format:{ ...Decoder.FORMAT_FIELD, default: 'hex'},
        subDecoders:{ label: 'subDecoders', type: 'subDecoders', default: []},
    };

    getCfgGui() {
        return SPIDecoder.GuiConfigData;
    }

    constructor(p) {
        super(p);
        this.signals = ['clk', 'mosi', 'miso', 'cs'];
        this.frames = [];
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—';
        return `CLK ${name(c.clk)} · mode ${Number(c.cpol) * 2 + Number(c.cpha)}`
    }

    rows() {
        return [
            {id:'data', label:'DATA', anchor: { signal: 'mosi' }, placement: 'after'},
            {id:'mosi', label:'MOSI', anchor: { signal: 'mosi' }, placement: 'after'},
            {id:'miso', label:'MISO', anchor: { signal: 'miso' }, placement: 'after'}
        ];
    }

    run(buf) {
        const cfg = this.cfg;
        const ANN = window.WS.theme;
        const clkBit = 1 << cfg.clk;
        const mosiBit = cfg.mosi != null ? 1 << cfg.mosi : null;
        const misoBit = cfg.miso != null ? 1 << cfg.miso : null;
        const csBit = cfg.cs != null ? 1 << cfg.cs : null;

        const leadingRising = cfg.cpol === 0;
        const sampleOnLeading = cfg.cpha === 0;
        const sampleRising = sampleOnLeading ? leadingRising : !leadingRising;
        const csActive = (word) => csBit === null ? true : (cfg.csActiveLow ? !(word & csBit) : !!(word & csBit));

        const dataAnns = [];
        const mosiAnns = [];
        const misoAnns = [];
        let mosiWord = 0, misoWord = 0, bitCount = 0, wordStart = 0, active = false;

        for (let i = 1; i < buf.length; i++) {
            const wasActive = active;
            active = csActive(buf.samples[i]);
            if (!wasActive && active) { 
                mosiWord = 0; 
                misoWord = 0; 
                bitCount = 0; 
            }
            if (wasActive && !active) { 
                bitCount = 0; 
            } // drop partial word on CS release
            if (!active) continue;

            const prevClk = !!(buf.samples[i - 1] & clkBit), curClk = !!(buf.samples[i] & clkBit);
            const rising = !prevClk && curClk, falling = prevClk && !curClk;
            if ((sampleRising && rising) || (!sampleRising && falling)) {
                const mb = mosiBit !== null ? ((buf.samples[i] & mosiBit) ? 1 : 0) : 0;
                const sb = misoBit !== null ? ((buf.samples[i] & misoBit) ? 1 : 0) : 0;
                if (bitCount === 0) {
                    wordStart = i;
                }
                if (cfg.msbFirst) {
                    mosiWord = (mosiWord << 1) | mb; 
                    misoWord = (misoWord << 1) | sb; 
                }
                else { 
                    mosiWord |= mb << bitCount; 
                    misoWord |= sb << bitCount;
                }
                bitCount++;
                if (bitCount >= cfg.wordBits) {
                    const digits = Math.ceil(cfg.wordBits / 4);
                    let mosiText = mosiBit !== null ? Decoder.AsFormat({word:mosiWord, type:cfg.format, hexPadding:digits, binPadding:cfg.wordBits}) : '';
                    let misoText = misoBit !== null ? Decoder.AsFormat({word:misoWord, type:cfg.format, hexPadding:digits, binPadding:cfg.wordBits}) : '';
                    let text = mosiText;
                    if (misoBit !== null) text += (text ? ' / ' : '') + 'MISO ' + misoText;
                    dataAnns.push({ start: wordStart, end: i, class: ANN.DATA, text });

                    mosiAnns.push({ start: wordStart, end: i, class: ANN.DATA, text:mosiText });
                    misoAnns.push({ start: wordStart, end: i, class: ANN.DATA, text:misoText });
                    mosiWord = 0; misoWord = 0; bitCount = 0;
                }
            }
        }
        return {data:dataAnns, mosi:mosiAnns, miso:misoAnns};
    }
}

window.WS.decoders.registry.push(SPIDecoder.Info);