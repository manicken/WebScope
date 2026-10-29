//
// This file is part of the libsigrokdecode project.
//
// Copyright (C) 2017 Kevin Redon <kingkevin@cuvoodoo.info>
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
// Ported to JavaScript for WebScope from libsigrokdecode decoders/onewire_link (pd.py and __init__.py).
//
// From __init__.py:
//
//   Copyright (C) 2012 Uwe Hermann <uwe@hermann-uwe.de>
//   Copyright (C) 2017 Kevin Redon <kingkevin@cuvoodoo.info>
//   (GNU General Public License, version 2 or (at your option) any later version, as above.)
//
//   This protocol decoder handles the 1-Wire link layer.
//
//   The 1-Wire protocol enables bidirectional communication over a single wire
//   (and ground) between a single master and one or multiple slaves. The protocol
//   is layered:
//
//    - Link layer (reset, presence detection, reading/writing bits)
//    - Network layer (skip/search/match device ROM addresses)
//    - Transport layer (transport data between 1-Wire master and device)
//
//   Sample rate:
//   A sufficiently high samplerate is required to properly detect all the elements
//   of the protocol. A lower samplerate can be used if the master does not use
//   overdrive communication speed. The following minimal values should be used:
//
//    - overdrive available: 2MHz minimum, 5MHz suggested
//    - overdrive not available: 400kHz minimum, 1MHz suggested
//
//   Channels:
//   1-Wire requires a single signal, but some master implementations might have a
//   separate signal used to deliver power to the bus during temperature conversion
//   as an example.
//
//    - owr (1-Wire signal line)
//
//   Options:
//   1-Wire is an asynchronous protocol with fixed timing values, so the decoder
//   must know the samplerate.
//   Two speeds are available: normal and overdrive. The decoder detects when
//   switching speed, but the user can set which to start decoding with:
//
//    - overdrive (to decode starting with overdrive speed)
//
// Port notes:
//  - The state machine is the original one; sigrok's wait() is decoder/srdWait.js.
//  - Output for stacked decoders (getOutput()): [{ type: 'RESET/PRESENCE' | 'BIT', data, start, end }],
//    the original's OUTPUT_PYTHON packets.
//  - The original misses a comma in the "Recovery time" warning (two texts glued together); fixed here.

class OneWireLinkDecoder extends Decoder {

    static Info = {
        name: '1-Wire link layer',
        longname: '1-Wire serial communication bus (link layer)',
        desc: 'Bidirectional, half-duplex, asynchronous serial bus.',
        class: OneWireLinkDecoder
    };

    static GuiConfigData = {
        owr: { label: 'OWR (1-Wire signal line)', type: 'channel', default: 0 },
        overdrive: { label: 'Start in overdrive speed', type: 'bool', default: false },
    };

    // Timing values in us for the signal at regular and overdrive speed.
    static timing = {
        'RSTL': {
            'min': { false: 480.0, true: 48.0 },
            'max': { false: 960.0, true: 80.0 },
        },
        'RSTH': {
            'min': { false: 480.0, true: 48.0 },
        },
        'PDH': {
            'min': { false: 15.0, true: 2.0 },
            'max': { false: 60.0, true: 6.0 },
        },
        'PDL': {
            'min': { false: 60.0, true: 8.0 },
            'max': { false: 240.0, true: 24.0 },
        },
        'SLOT': {
            'min': { false: 60.0, true: 6.0 },
            'max': { false: 120.0, true: 16.0 },
        },
        'REC': {
            'min': { false: 1.0, true: 1.0 },
        },
        'LOWR': {
            'min': { false: 1.0, true: 1.0 },
            'max': { false: 15.0, true: 2.0 },
        },
    };

    constructor(p) {
        super(p);
        this.signals = ['owr'];
        this.frames = [];
    }

    getCfgGui() {
        return OneWireLinkDecoder.GuiConfigData;
    }

    static GetSourceTypes() {
        return ['logic', CustomDecoder.TYPE];
    }

    getOutput() {
        return this.frames;
    }

    summary(channels) {
        const c = this.cfg;
        const name = (i) => (typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—');
        return `${name(c.owr)}${c.overdrive ? ' · overdrive' : ''}`;
    }

    // annotation_rows = (('bits', 'Bits', (0, 2, 3)), ('info', 'Info', (4,)), ('warnings', 'Warnings', (1,)))
    rows() {
        return {
            bits: { label: 'Bits', anchor: { signal: 'owr' }, placement: 'after' },
            info: { label: 'Info', anchor: { signal: 'owr' }, placement: 'after' },
            warnings: { label: 'Warnings', anchor: { signal: 'owr' }, placement: 'after' },
        };
    }

    run() {
        const buf = this.getSource();
        const cfg = this.cfg;
        const { ANN } = window.WS.theme;
        const timing = OneWireLinkDecoder.timing;
        const out = { bits: [], info: [], warnings: [] };
        this.frames = [];

        if (!buf?.samplerate)
            throw new Error('1-Wire link: Cannot decode without samplerate.');   // SamplerateError
        if (typeof cfg.owr !== 'number' || buf.length < 2)
            return out;

        const samplerate = buf.samplerate;
        const w = new SrdWait(buf, [cfg.owr]);

        // annotations = bit, warning, reset, presence, overdrive: the row and color of each
        const ANNS = [['bits', ANN.DATA], ['warnings', ANN.WARN], ['bits', ANN.CONTROL], ['bits', ANN.ACK], ['info', ANN.CONTROL]];
        const put = (ss, es, [cls, texts]) => {
            const [row, color] = ANNS[cls];
            out[row].push({ start: ss, end: Math.max(ss, es), class: color, text: texts });
        };
        const putpy = (ss, es, [type, data]) => this.frames.push({ type, data, start: ss, end: es });
        // Python's str() of a float: 480.0, not 480
        const num = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

        // reset() / start()
        let state = 'INITIAL';
        let bit = 0;
        let bit_count = -1;
        let command = 0;
        let overdrive = !!cfg.overdrive;
        let fall = 0;
        let rise = 0;

        const putm = (data) => put(0, 0, data);
        const putpfs = (data) => putpy(fall, w.samplenum, data);
        const putfs = (data) => put(fall, w.samplenum, data);
        const putfr = (data) => put(fall, rise, data);
        const putprs = (data) => putpy(rise, w.samplenum, data);
        const putrs = (data) => put(rise, w.samplenum, data);

        const checks = () => {
            // Check if samplerate is appropriate.
            if (cfg.overdrive) {
                if (samplerate < 2000000) {
                    putm([1, ['Sampling rate is too low. Must be above ' +
                              '2MHz for proper overdrive mode decoding.']]);
                } else if (samplerate < 5000000) {
                    putm([1, ['Sampling rate is suggested to be above 5MHz ' +
                              'for proper overdrive mode decoding.']]);
                }
            } else {
                if (samplerate < 400000) {
                    putm([1, ['Sampling rate is too low. Must be above ' +
                              '400kHz for proper normal mode decoding.']]);
                } else if (samplerate < 1000000) {
                    putm([1, ['Sampling rate is suggested to be above ' +
                              '1MHz for proper normal mode decoding.']]);
                }
            }
        };

        const wait_falling_timeout = (start, t) => {
            // Wait until either a falling edge is seen, and/or the specified
            // number of samples have been skipped (i.e. time has passed).
            const cnt = Math.trunc((t[overdrive] / 1000000.0) * samplerate);
            let samples_to_skip = (start + cnt) - w.samplenum;
            samples_to_skip = (samples_to_skip > 0) ? samples_to_skip : 0;
            return w.wait([{ 0: 'f' }, { skip: samples_to_skip }]);
        };

        checks();
        for (;;) {
            // State machine.
            if (state === 'INITIAL') { // Unknown initial state.
                // Wait until we reach the idle high state.
                if (!w.wait({ 0: 'h' })) break;
                rise = w.samplenum;
                state = 'IDLE';
            } else if (state === 'IDLE') { // Idle high state.
                // Wait for falling edge.
                if (!w.wait({ 0: 'f' })) break;
                fall = w.samplenum;
                // Get time since last rising edge.
                const time = ((fall - rise) / samplerate) * 1000000.0;
                if (rise > 0 &&
                    time < timing['REC']['min'][overdrive]) {
                    putfr([1, ['Recovery time not long enough',
                        'Recovery too short',
                        'REC < ' + num(timing['REC']['min'][overdrive])]]);
                }
                // A reset pulse or slot can start on a falling edge.
                state = 'LOW';
                // TODO: Check minimum recovery time.
            } else if (state === 'LOW') { // Reset pulse or slot.
                // Wait for rising edge.
                if (!w.wait({ 0: 'r' })) break;
                rise = w.samplenum;
                // Detect reset or slot base on timing.
                const time = ((rise - fall) / samplerate) * 1000000.0;
                if (time >= timing['RSTL']['min'][false]) { // Normal reset pulse.
                    if (time > timing['RSTL']['max'][false]) {
                        putfr([1, ['Too long reset pulse might mask interrupt ' +
                            'signalling by other devices',
                            'Reset pulse too long',
                            'RST > ' + num(timing['RSTL']['max'][false])]]);
                    }
                    // Regular reset pulse clears overdrive speed.
                    if (overdrive) {
                        putfr([4, ['Exiting overdrive mode', 'Overdrive off']]);
                    }
                    overdrive = false;
                    putfr([2, ['Reset', 'Rst', 'R']]);
                    state = 'PRESENCE DETECT HIGH';
                } else if (overdrive === true &&
                    time >= timing['RSTL']['min'][overdrive] &&
                    time < timing['RSTL']['max'][overdrive]) {
                    // Overdrive reset pulse.
                    putfr([2, ['Reset', 'Rst', 'R']]);
                    state = 'PRESENCE DETECT HIGH';
                } else if (time < timing['SLOT']['max'][overdrive]) {
                    // Read/write time slot.
                    if (time < timing['LOWR']['min'][overdrive]) {
                        putfr([1, ['Low signal not long enough',
                            'Low too short',
                            'LOW < ' + num(timing['LOWR']['min'][overdrive])]]);
                    }
                    if (time < timing['LOWR']['max'][overdrive]) {
                        bit = 1; // Short pulse is a 1 bit.
                    } else {
                        bit = 0; // Long pulse is a 0 bit.
                    }
                    // Wait for end of slot.
                    state = 'SLOT';
                } else {
                    // Timing outside of known states.
                    putfr([1, ['Erroneous signal', 'Error', 'Err', 'E']]);
                    state = 'IDLE';
                }
            } else if (state === 'PRESENCE DETECT HIGH') { // Wait for slave presence signal.
                // Wait for a falling edge and/or presence detect signal.
                if (!wait_falling_timeout(rise, timing['PDH']['max'])) break;

                // Calculate time since rising edge.
                const time = ((w.samplenum - rise) / samplerate) * 1000000.0;

                if (w.matched[0] && !w.matched[1]) {
                    // Presence detected.
                    if (time < timing['PDH']['min'][overdrive]) {
                        putrs([1, ['Presence detect signal is too early',
                            'Presence detect too early',
                            'PDH < ' + num(timing['PDH']['min'][overdrive])]]);
                    }
                    fall = w.samplenum;
                    state = 'PRESENCE DETECT LOW';
                } else { // No presence detected.
                    putrs([3, ['Presence: false', 'Presence', 'Pres', 'P']]);
                    putprs(['RESET/PRESENCE', false]);
                    state = 'IDLE';
                }
            } else if (state === 'PRESENCE DETECT LOW') { // Slave presence signalled.
                // Wait for end of presence signal (on rising edge).
                if (!w.wait({ 0: 'r' })) break;
                // Calculate time since start of presence signal.
                const time = ((w.samplenum - fall) / samplerate) * 1000000.0;
                if (time < timing['PDL']['min'][overdrive]) {
                    putfs([1, ['Presence detect signal is too short',
                        'Presence detect too short',
                        'PDL < ' + num(timing['PDL']['min'][overdrive])]]);
                } else if (time > timing['PDL']['max'][overdrive]) {
                    putfs([1, ['Presence detect signal is too long',
                        'Presence detect too long',
                        'PDL > ' + num(timing['PDL']['max'][overdrive])]]);
                }
                if (time > timing['RSTH']['min'][overdrive]) {
                    rise = w.samplenum;
                }
                // Wait for end of presence detect.
                state = 'PRESENCE DETECT';
            }

            // End states (for additional checks).
            if (state === 'SLOT') { // Wait for end of time slot.
                // Wait for a falling edge and/or end of timeslot.
                if (!wait_falling_timeout(fall, timing['SLOT']['min'])) break;

                if (w.matched[0] && !w.matched[1]) {
                    // Low detected before end of slot.
                    putfs([1, ['Time slot not long enough',
                        'Slot too short',
                        'SLOT < ' + num(timing['SLOT']['min'][overdrive])]]);
                    // Don't output invalid bit.
                    fall = w.samplenum;
                    state = 'LOW';
                } else { // End of time slot.
                    // Output bit.
                    putfs([0, ['Bit: ' + bit, String(bit)]]);
                    putpfs(['BIT', bit]);
                    // Save command bits.
                    if (bit_count >= 0) {
                        command += (bit << bit_count);
                        bit_count += 1;
                    }
                    // Check for overdrive ROM command.
                    if (bit_count >= 8) {
                        if (command === 0x3c || command === 0x69) {
                            overdrive = true;
                            put(w.samplenum, w.samplenum,
                                [4, ['Entering overdrive mode', 'Overdrive on']]);
                        }
                        bit_count = -1;
                    }
                    state = 'IDLE';
                }
            }

            if (state === 'PRESENCE DETECT') {
                // Wait for a falling edge and/or end of presence detect.
                if (!wait_falling_timeout(rise, timing['RSTH']['min'])) break;

                if (w.matched[0] && !w.matched[1]) {
                    // Low detected before end of presence detect.
                    putfs([1, ['Presence detect not long enough',
                        'Presence detect too short',
                        'RTSH < ' + num(timing['RSTH']['min'][overdrive])]]);
                    // Inform about presence detected.
                    putrs([3, ['Slave presence detected', 'Slave present',
                        'Present', 'P']]);
                    putprs(['RESET/PRESENCE', true]);
                    fall = w.samplenum;
                    state = 'LOW';
                } else { // End of time slot.
                    // Inform about presence detected.
                    putrs([3, ['Presence: true', 'Presence', 'Pres', 'P']]);
                    putprs(['RESET/PRESENCE', true]);
                    rise = w.samplenum;
                    // Start counting the first 8 bits to get the ROM command.
                    bit_count = 0;
                    command = 0;
                    state = 'IDLE';
                }
            }
        }
        return out;
    }
}

window.WS.decoders.registry.push(OneWireLinkDecoder.Info);
