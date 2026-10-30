({
    /** Runs when you press Run. ws: the capture, the decoders and save(), see README "Scripts". */
    run(ws) {
        const i2c = ws.decoders.find((d) => d.settings.decoder === 'i2c');

        const frames = [];   // en frame = START .. STOP
        let frame = null;    // { start, end, segments: [{ address, read, data: [], nack }] }
        let seg = null;

        for (const f of i2c.output) {
            switch (f.type) {
                case 'START':
                    frame = { start: f.start, end: f.end, segments: [] };
                    seg = null;
                    break;
                case 'START REPEAT':          // ny adress i samma transaktion
                    seg = null;
                    break;
                case 'ADDRESS WRITE':
                case 'ADDRESS READ':
                    if (!frame) frame = { start: f.start, end: f.end, segments: [] };   // fångsten började mitt i en transaktion
                    seg = { address: f.data[1], read: f.type === 'ADDRESS READ', data: [], nack: false };
                    frame.segments.push(seg);
                    break;
                case 'DATA WRITE':
                case 'DATA READ':
                    seg?.data.push(f.data[1]);
                    break;
                case 'NACK':
                    if (seg) seg.nack = true;
                    break;
                case 'STOP':
                    if (frame) {
                        frame.end = f.end;
                        frames.push(frame);
                    }
                    frame = seg = null;
                    break;
                // 'BITS' och 'ACK' behövs inte här
            }
        }
        if (frame) frames.push(frame);   // fångsten tog slut före STOP

        const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
        const frameText = (fr) => {
            let prev = null;
            return fr.segments.map((s) => {
                const addr = s.address === prev ? '' : `${hex(s.address)} `;   // samma adress: visas inte igen
                prev = s.address;
                const err = s.nack && !s.read ? ' NACK' : '';                     // NACK vid läsning är normalt slut
                return `${addr}${s.read ? 'R' : 'W'} [${s.data.map(hex).join(' ')}]${err}`;
            }).join(' ');
        };
        ws.show({ text: frames.map((fr) => `${fr.start}: ${frameText(fr)}`).join('\n') });
        
    },
})
