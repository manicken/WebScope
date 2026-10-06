/**
 * captureActions.js — start/stop a capture on a source and feed the result into the engine.
 * Talks to WS.sources instead of a physical device list (all FX2/sigrok/Electron device management
 * from edgewise's actions.ts was removed).
 */
(function (WS) {
  'use strict';
  const { get, set, makeChannels, toast } = WS.store;
  const { engine } = WS;
  const A = (WS.actions = WS.actions || {});

  /* ---- capture orchestration ---- */
  let activeSource = null;
  let growing = null; // Uint32Array being filled while a capture streams in

  function startCapture(source, {samplerate, duration, channels} = {}) {
    const total = Math.max(64, Math.round(samplerate * duration));
    growing = new Uint32Array(total);
    set({
      follow: true, markers: { a: null, b: null }, measurement: null,
      status: { ...get().status, state: 'running', samples: 0, samplerate, captureId: get().status.captureId + 1 }
    });
    activeSource = source;
    activeSource.start(
      { samplerate, samplecount:total, channels },
      /* onData */
      (chunk, offset) => {
        const available = growing.length - offset;
        if (chunk.length > available) {
          console.warn(
              `capture overflow: ` +
              `offset=${offset}, ` +
              `chunk=${chunk.length}, ` +
              `available=${available}, ` +
              `diff=${chunk.length - available}, ` +
              `total=${total}`
          );
        }
        const count = Math.min(chunk.length, available);

        if (count > 0) {
            // this is a failsafe in cases where the received amount exceed the expected amount
            growing.set(chunk.subarray(0, count), offset); 
        }

        const samples = Math.min(total, offset + count); // sample count

        set((s) => ({
            status: { ...s.status, samples }
        }));

        if (get().follow) A.fit();
      },
      /* onDone */
      (info) => {
        engine.setBuffer(new WS.CaptureBuffer(growing.slice(0, info.samples), info.samplerate, info.channels));
        if (get().channels.length !== info.channels) set({ channels: makeChannels(info.channels) });
        set((s) => ({ status: { ...s.status, state: 'done', samples: info.samples, samplerate: info.samplerate, channels: info.channels, trigger: null } }));
        for (const d of get().decoders) engine.decode(d.id);
        if (get().follow) A.fit();
      },
      /* onError */
      (msg) => { set((s) => ({ status: { ...s.status, state: 'error', message: msg } })); toast(msg); }
    );
  }

  function stopCapture() {
    activeSource?.stop();
    if (growing && get().status.samples > 0) {
      const n = get().status.samples;
      engine.setBuffer(new WS.CaptureBuffer(growing.slice(0, n), get().status.samplerate, get().channels.length));
      for (const d of get().decoders) engine.decode(d.id);
    }
    set((s) => ({ status: { ...s.status, state: s.status.samples > 0 ? 'done' : 'idle' } }));
  }

  Object.assign(A, { startCapture, stopCapture });
})(window.WS = window.WS || {});
