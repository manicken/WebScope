//
// This file is part of the libsigrokdecode project.
//
// Copyright (C) 2012 Joel Holdsworth <joel@airwebreathe.org.uk>
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
// Ported to JavaScript for WebScope from libsigrokdecode decoders/i2s (pd.py and __init__.py).
//
// From __init__.py:
//
//   Copyright (C) 2012 Joel Holdsworth <uwe@hermann-uwe.de>
//   (GNU General Public License, version 2 or (at your option) any later version, as above.)
//
//   I²S (Integrated Interchip Sound) is a serial bus for connecting digital
//   audio devices (usually on the same device/board).
//
//   Details:
//   http://www.nxp.com/acrobat_download/various/I2SBUS.pdf
//   http://en.wikipedia.org/wiki/I2s
//
// From pd.py:
//
//   OUTPUT_PYTHON format:
//
//   Packet:
//   [<ptype>, <pdata>]
//
//   <ptype>, <pdata>:
//    - 'DATA', [<channel>, <value>]
//
//   <channel>: 'L' or 'R'
//   <value>: integer
//
// Port notes:
//  - Output for stacked decoders and scripts (getOutput()): [{ type: 'DATA', data: [channel, value], start, end }].
//  - The original also writes a WAV file (sigrok's OUTPUT_BINARY), which WebScope does not have: a script
//    can write one from getOutput() (ws.decoders[...].output). The original WAV code is kept below.
//  - Words are collected as numbers (data * 2 + bit), so words up to 53 bits stay exact; Python's are unlimited.
//  - report() (the original's metadata text) is shown in the decoder's summary after a run.

class I2SDecoder extends Decoder {

    static Info = {
        name: 'I²S',
        longname: 'Integrated Interchip Sound',
        desc: 'Serial bus for connecting digital audio devices.',
        class: I2SDecoder
    };

    static GuiConfigData = {
        sck: { label: 'SCK (bit clock)', type: 'channel', default: 0 },
        ws: { label: 'WS (word select)', type: 'channel', default: 1 },
        sd: { label: 'SD (serial data)', type: 'channel', default: 2 },
    };

    static GetSourceTypes() {
        return ['logic', CustomDecoder.TYPE];
    }

    constructor(p) {
        super(p);
        this.signals = ['sck', 'ws', 'sd'];
        this.frames = [];
        this.reportText = '';
    }

    getCfgGui() {
        return I2SDecoder.GuiConfigData;
    }

    getOutput() {
        return this.frames;
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => (typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—');
        const pins = `SCK ${name(c.sck)} · WS ${name(c.ws)} · SD ${name(c.sd)}`;
        return this.reportText ? `${pins} · ${this.reportText}` : pins;
    }

    // annotations = left, right, warnings (no annotation_rows: one row each)
    rows() {
        return {
            left: { label: 'Left channel', anchor: { signal: 'sd' }, placement: 'after' },
            right: { label: 'Right channel', anchor: { signal: 'sd' }, placement: 'after' },
            warnings: { label: 'Warnings', anchor: { signal: 'sd' }, placement: 'after' },
        };
    }

    /* The original's WAV output (sigrok OUTPUT_BINARY), not used in WebScope:

        def wav_header(self):
            # Chunk descriptor
            h  = b'RIFF'
            h += b'\x24\x80\x00\x00' # Chunk size (2084)
            h += b'WAVE'
            # Fmt subchunk
            h += b'fmt '
            h += b'\x10\x00\x00\x00' # Subchunk size (16 bytes)
            h += b'\x01\x00'         # Audio format (0x0001 == PCM)
            h += b'\x02\x00'         # Number of channels (2)
            h += b'\x80\x3e\x00\x00' # Samplerate (16000)
            h += b'\x00\xfa\x00\x00' # Byterate (64000)
            h += b'\x04\x00'         # Blockalign (4)
            h += b'\x20\x00'         # Bits per sample (32)
            # Data subchunk
            h += b'data'
            h += b'\xff\xff\xff\xff' # Subchunk size (4G bytes) TODO
            return h

        def wav_sample(self, sample):
            return struct.pack('<I', self.data)
    */

    run() {
        const buf = this.getSource();
        const cfg = this.cfg;
        const { ANN } = window.WS.theme;
        const out = { left: [], right: [], warnings: [] };
        this.frames = [];
        this.reportText = '';

        if (!buf || buf.length < 2 || ![cfg.sck, cfg.ws, cfg.sd].every((c) => typeof c === 'number'))
            return out;

        const w = new SrdWait(buf, [cfg.sck, cfg.ws, cfg.sd]);
        const ROWS = ['left', 'right', 'warnings'];

        // reset()
        const samplerate = buf.samplerate;
        let oldws = 1;
        let bitcount = 0;
        let data = 0;
        let samplesreceived = 0;
        let first_sample = null;
        let ss_block = null;
        let wordlength = -1;

        const putpb = ([type, value]) => this.frames.push({ type, data: value, start: ss_block, end: w.samplenum });
        const putb = ([cls, texts]) => out[ROWS[cls]].push({ start: ss_block, end: w.samplenum, class: cls === 2 ? ANN.WARN : ANN.DATA, text: texts });

        const report = () => {
            // Calculate the sample rate.
            let rate = '?';
            if (ss_block !== null &&
                first_sample !== null &&
                ss_block > first_sample &&
                samplerate) {
                rate = String(Math.trunc(samplesreceived *
                    samplerate / (ss_block -
                    first_sample)));
            }

            return `I²S: ${samplesreceived} ${wordlength}-bit samples received at ${rate}Hz`;
        };

        for (;;) {
            // Wait for a rising edge on the SCK pin.
            const pins = w.wait({ 0: 'r' });
            if (!pins) break;
            const [, ws, sd] = pins;

            data = data * 2 + sd;   // (self.data << 1) | sd
            bitcount += 1;

            // This was not the LSB unless WS has flipped.
            if (ws === oldws) {
                continue;
            }

            // Only submit the sample, if we received the beginning of it.
            if (ss_block !== null) {

                samplesreceived += 1;

                if (!w.wait({ 0: 'f' })) break;

                const idx = !oldws ? 0 : 1;
                const c1 = !oldws ? 'Left channel' : 'Right channel';
                const c2 = !oldws ? 'Left' : 'Right';
                const c3 = !oldws ? 'L' : 'R';
                const v = data.toString(16).padStart(8, '0');
                putpb(['DATA', [c3, data]]);
                putb([idx, [`${c1}: ${v}`, `${c2}: ${v}`,
                            `${c3}: ${v}`, c3]]);

                // Check that the data word was the correct length.
                if (wordlength !== -1 && wordlength !== bitcount) {
                    putb([2, [`Received ${bitcount}-bit word, expected ${wordlength}-bit ` +
                              'word']]);
                }

                wordlength = bitcount;
            } else {
                if (!w.wait({ 0: 'f' })) break;
            }

            // Reset decoder state.
            data = 0;
            bitcount = 0;
            ss_block = w.samplenum;

            // Save the first sample position.
            if (first_sample === null) {
                first_sample = w.samplenum;
            }

            oldws = ws;
        }
        if (samplesreceived) this.reportText = report();
        return out;
    }
}

window.WS.decoders.registry.push(I2SDecoder.Info);
