
({
    getCfgGui(context) {
		return {
			baud: {
				label: 'Baud rate',
				type: 'number',
				default: 115200
			},
			parity: {
				label: 'Parity',
				type: 'select',
				default: 'none',
				options: ['none', 'even', 'odd']
			},
			format:{ ...Decoder.FORMAT_FIELD, default:'ascii'},
		};
	},
	/** in all functions context is the Decoder Instance */
    /** runs directly after the compile is done */
    init(context) {
        const cfg = context.cfg;
        cfg.channel = 0;
        cfg.baud = 115200;
        cfg.dataBits = 8;
        cfg.stopBits = 1;
        cfg.parity = 'none';
        cfg.format = 'hex';
    },
    /** called from custom decoder rows function*/
    rows(context) {
        return [{id:'data', label:'DATA', anchor: { signal: 'channel' }, placement: 'after'}];
    },
    /** called from custom decoder run function */
    run(input, context) {
        const buf = input;
        const cfg = context.cfg;
        const ANN = window.WS.theme;
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
                start: startSample, end: endSample, row: 0,
                class: (!parityOk || !stopOk) ? ANN.ERROR : ANN.DATA,
                text: (!parityOk ? 'PERR ' : '') + (!stopOk ? 'FERR ' : '') + text
            });
            i = Math.max(i + 1, Math.round(endSample));
        }
        return {data:anns};
    }
})
