
class UARTDecoder extends Decoder {

    static Info = {
        name: "UART",
        class: UARTDecoder
    };

    static GuiConfigData = {
        channel:{ label: 'Channel', type: 'channel', default: 0 },
        baud:{ label: 'Baud', type: 'number', default:115200 },
        dataBits:{ label: 'Data bits', type: 'select', options: [5, 6, 7, 8, 9].map((n) => [n, String(n)]), default:8 },
        parity:{ label: 'Parity', type: 'select', options: [['none', 'None'], ['even', 'Even'], ['odd', 'Odd']], default:'none' },
        stopBits:{ label: 'Stop bits', type: 'select', options: [[1, '1'], [2, '2']], default:1 },
        msbFirst:{ label: 'MSB first', type: 'bool', default: false },
        invert:{ label: 'Inverted', type: 'bool', default:false },
        format:{ ...Decoder.FORMAT_FIELD, default:'ascii'},
        subDecoders:{ label: 'subDecoders', type: 'subDecoders', default: []},
    };

    getCfgGui() {
        return UARTDecoder.GuiConfigData;
    }

    loadDefaultConfig() {
        this.cfg = {
            channel: UARTDecoder.GuiConfigData.channel.default,
            baud: UARTDecoder.GuiConfigData.baud.default,
            dataBits: UARTDecoder.GuiConfigData.dataBits.default,
            parity: UARTDecoder.GuiConfigData.parity.default,
            stopBits: UARTDecoder.GuiConfigData.stopBits.default,
            msbFirst: UARTDecoder.GuiConfigData.msbFirst.default,
            invert: UARTDecoder.GuiConfigData.invert.default,
            format: UARTDecoder.GuiConfigData.format.default,
        }
    }


    constructor(p) {
        super(p);
        this.signals = ['channel'];
        this.frames = [];
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—';
        return `${name(c.channel)} · ${c.baud} baud`;
    }

    rows() { return [{id:'data', label:'DATA', anchor: { signal: 'channel' }, placement: 'after'}] }

    run(buf) {
        const ANN = window.WS.theme.ANN;
        console.log(ANN);
        const cfg = this.cfg;
        const ch = cfg.channel;
        const spb = buf.samplerate / cfg.baud; // samples per bit
        const invert = !!cfg.invert;
        const get = (n) => {
            const idx = Math.max(0, Math.min(buf.length - 1, Math.round(n)));
            const v = (buf.samples[idx] >> ch) & 1;
            return invert ? 1 - v : v;
        };
        const anns = [];
        let i = 0;
        while (i < buf.length) {
            while (i < buf.length && get(i) !== 0) { i++; }
            if (i >= buf.length) { break; }
            if (i > 0 && get(i - 1) !== 1) { 
                i++;
                continue;
            }
            const startSample = i;
            const mid = (n) => startSample + (n + 0.5) * spb;
            if (get(mid(0)) !== 0) { 
                i = Math.max(i + 1, Math.round(startSample + spb));
                continue;
            }
            let byte = 0;
            for (let b = 0; b < cfg.dataBits; b++) {
                const v = get(mid(1 + b));
                if (cfg.msbFirst) {
                    byte = (byte << 1) | v;
                } else {
                    byte |= v << b;
                }
            }
            let bitIdx = 1 + cfg.dataBits;
            let parityOk = true;
            if (cfg.parity !== 'none') {
                const p = get(mid(bitIdx)); bitIdx++;
                let ones = 0; for (let b = 0; b < cfg.dataBits; b++) if ((byte >> b) & 1) ones++;
                parityOk = p === (cfg.parity === 'even' ? ones % 2 : 1 - (ones % 2));
            }
            let stopOk = true;
            for (let s = 0; s < cfg.stopBits; s++) if (get(mid(bitIdx + s)) !== 1) stopOk = false;
            const endSample = startSample + (bitIdx + cfg.stopBits) * spb;
            const text = Decoder.AsFormat({type:cfg.format, word:byte, binPadding:cfg.dataBits});
                
            anns.push({
                start: startSample, 
                end: endSample,
                class: (!parityOk || !stopOk) ? ANN.ERROR : ANN.DATA,
                text: (!parityOk ? 'PERR ' : '') + (!stopOk ? 'FERR ' : '') + text
            });
            i = Math.max(i + 1, Math.round(endSample));
        }
        return {data:anns};
    }

}

window.WS.decoders.registry.push(UARTDecoder.Info);