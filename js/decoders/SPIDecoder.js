

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
        format:{ ...FORMAT_FIELD, default: 'hex'},
        subDecoders:{ label: 'subDecoders', type: 'subDecoders', default: []},
    };

    constructor() {
        super();
        this.frames = [];
    }

    run(buf) {
        const ANN = window.WS.theme;
        const clkBit = 1 << this.cfg.clk;
        const mosiBit = this.cfg.mosi != null ? 1 << this.cfg.mosi : null;
        const misoBit = this.cfg.miso != null ? 1 << this.cfg.miso : null;
        const csBit = this.cfg.cs != null ? 1 << this.cfg.cs : null;

        const leadingRising = this.cfg.cpol === 0;
        const sampleOnLeading = this.cfg.cpha === 0;
        const sampleRising = sampleOnLeading ? leadingRising : !leadingRising;
        const csActive = (word) => csBit === null ? true : (this.cfg.csActiveLow ? !(word & csBit) : !!(word & csBit));

        const anns = [];
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
                if (this.cfg.msbFirst) {
                    mosiWord = (mosiWord << 1) | mb; 
                    misoWord = (misoWord << 1) | sb; 
                }
                else { 
                    mosiWord |= mb << bitCount; 
                    misoWord |= sb << bitCount;
                }
                bitCount++;
                if (bitCount >= this.cfg.wordBits) {
                    const digits = Math.ceil(this.cfg.wordBits / 4);
                    const fmt = (v) => this.cfg.format === 'hex' ? '0x' + v.toString(16).padStart(digits, '0').toUpperCase() : String(v);
                    let text = mosiBit !== null ? fmt(mosiWord) : '';
                    if (misoBit !== null) text += (text ? ' / ' : '') + 'MISO ' + fmt(misoWord);
                    anns.push({ start: wordStart, end: i, row: 0, class: ANN.DATA, text });
                    mosiWord = 0; misoWord = 0; bitCount = 0;
                }
            }
        }
        return {anns};
    }
}

window.WS.decoderregistry.push(SPIDecoder.Info);