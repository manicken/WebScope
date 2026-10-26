/**
 * appState.js — the shared application state: plain objects holding ReactiveValues.
 * A module subscribes directly to the values it shows, e.g. a gutter row to its channel's
 * `name`, the status bar to WS.capture.buffer and appState.view.spp.
 *
 *   channels         ReactiveValue<Channel[]>, replaced when the device or the capture changes
 *                    Channel = { index, name, color, visible }  (name, color, visible are ReactiveValues)
 *   acquisition      the capture that is running, not the data on screen
 *   captureSettings  what the next capture should use (edited in the Capture panel)
 *   view             the visible part of the capture
 *   pointer          mouse hover over the waveform (changes on every mouse move)
 *   markers          time markers, see markers/markerModel.js
 *   selections       measurement selections, see selections/selectionModel.js
 *   table            what the "Decoded data" table shows
 *
 * Owned by their modules instead:
 *   WS.capture.buffer     ReactiveValue<CaptureBuffer|null>, the data on screen (samplerate, length, trigger)
 *   WS.decoders.list      ReactiveValue<Decoder[]>, a decoder's settings are in decoder.settings
 *   WS.decoders.revision  bumped after decoders ran (annotations changed)
 */
(function (WS) {
    'use strict';
    const { PALETTE } = WS.theme;
    const rv = (value) => new ReactiveValue(value);

    function makeChannel({ index, name, color }) {
        return {
            index,
            name: rv(name ?? `CH${index + 1}`),
            color: rv(color ?? PALETTE[index % PALETTE.length]),
            visible: rv(true),
        };
    }

    /** New channel objects, from a count (+ optional names) or from device info items { index, name }. */
    function makeChannels({ count = 0, names = null, items = null }) {
        items ??= Array.from({ length: count }, (_, i) => ({ index: i, name: names?.[i] }));
        return items.map(makeChannel);
    }

    const appState = {
        channels: rv([]),
        acquisition: {
            state: rv('idle'),          // 'idle' | 'running' | 'done' | 'error'
            message: rv(''),
        },
        captureSettings: {
            deviceName: rv(''),
            samplerates: rv([]),
            samplerate: rv(null),
            mode: rv('timer'),          // 'looping' | 'oneshot' | 'timer' | 'trigger'
            timerSeconds: rv(1),
            /** { channel, type, pulseWidth, conditions }  type: 'L2H' | 'H2L' | 'PulseH' | 'PulseL',
             *  pulseWidth in s (pulses only), conditions: { channelIndex: 'lo'|'hi' } */
            trigger: rv({ channel: 0, type: 'L2H', pulseWidth: 1e-5, conditions: {} }),
            preTrigger: rv(1),          // seconds
            postTrigger: rv(1),         // seconds
            memoryMB: rv(1024),         // Looping: how much is kept; One shot: when it stops
        },
        view: {
            start: rv(0),
            spp: rv(1000),              // samples per pixel
            plotWidth: rv(1000),
            follow: rv(true),           // keep fitting the whole capture while it streams in
        },
        pointer: {
            hover: rv(null),            // { sample, channel, x, y }
            measurement: rv(null),      // pulse under the pointer, see CaptureBuffer.measure()
        },
        markers: {
            list: rv([]),
            selected: rv(null),
        },
        selections: {
            list: rv([]),
            selected: rv(null),
            statChannel: rv({}),        // selection id -> channel the popup shows stats for
        },
        table: {
            decoder: rv(null),
            rowId: rv(null),
            focus: rv(null),
        },
    };

    function toast(msg) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }

    WS.appState = appState;
    WS.makeChannels = makeChannels;
    WS.toast = toast;
})(window.WS = window.WS || {});
