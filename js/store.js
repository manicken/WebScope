/**
 * store.js — minimal observable store, replacing zustand.
 * get()/set(patch)/subscribe(fn); patch may be a value or an updater function.
 */
(function (WS) {
  'use strict';
  const { PALETTE } = WS.theme;

  function createStore(initial) {
    let state = initial;
    const subs = new Set();
    return {
      get: () => state,
      set: (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
        subs.forEach((fn) => fn(state));
      },
      subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }
    };
  }

  function makeChannels(n, names) {
    return Array.from({ length: n }, (_, i) => ({
      index: i, name: names?.[i] ?? `D${i}`, color: PALETTE[i % PALETTE.length], visible: true, trigger: null
    }));
  }

  const store = createStore({
    channels: makeChannels(8),
    decoders: [], // { id, kind, name, color, config, rows, visible }
    status: {
      state: 'idle', message: '', samples: 0, samplerate: 8_000_000, channels: 8,
      trigger: null, captureId: 0, decoding: false, decodeGen: 0
    },
    view: { start: 0, spp: 1000 },
    plotWidth: 1000,
    follow: true,
    markers: { a: null, b: null },
    hover: null,
    measurement: null,
    table: { decoder: null, row: 0, focus: null },
    toast: null
  });

  function toast(msg) {
    store.set({ toast: msg });
    setTimeout(() => store.get().toast === msg && store.set({ toast: null }), 3500);
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  WS.store = { createStore, makeChannels, store, get: store.get, set: store.set, toast };
})(window.WS = window.WS || {});
