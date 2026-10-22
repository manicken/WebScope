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
                const changes = typeof patch === 'function' ? patch(state) : patch;
                state = { ...state, ...changes };
                const args = {state, keys:Object.keys(changes), subkey:null};
                subs.forEach((fn) => fn(args));
            },
            update: (key, patch) => {
                const current = state[key];
                const changes = typeof patch === 'function' ? patch(state) : patch;
                state = {
                    ...state,
                    [key]: {
                        ...current,
                        ...changes
                    }
                };
                const args = {state, keys:Object.keys(changes), subkey:key};
                subs.forEach((fn) => fn(args));
            },
            subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }
        };
    }

    function makeChannels({count=0, names=null, items=null}) {
        let ret = [];
        if (!items) {
            //console.trace({names});
            ret = Array.from({ length: count }, (_, i) => ({
                index: i, name: names?.[i] ?? `CH${i+1}`, color: PALETTE[i % PALETTE.length], visible: true, trigger: null
            }));
        } else {
            //console.trace({items});
            ret = items.map((item) => {return { color: PALETTE[item.index % PALETTE.length], visible: true, trigger: null, ...item}});
        }
        //console.log(ret);
        return ret;
    }


    const store = createStore({
        channels: [],//makeChannels({count:8})
        decoders: [], // { id, kind, name, color, config, rows, visible }
        devices: new Map(),
        selectedDevice: null,
        status: {
            state: 'idle',
            message: '',
            sampleCount: 0,
            samplerate: 8_000_000,
            captureDuration: 1.0, // in seconds
            trigger: null,
            captureId: 0,
            decoding: false,
            decodeGen: 0
        },
        view: { 
            start: 0,
            spp: 1000 /** samples per pixel */
        },
        plotWidth: 1000,
        follow: true,
        markers: [],
        selections: [],
        hover: null,
        measurement: null,
        table: { 
            decoder: null,
            row: 0,
            focus: null
        },
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

    WS.store = { createStore, makeChannels, store, get: store.get, set: store.set, update: store.update, toast };
})(window.WS = window.WS || {});
