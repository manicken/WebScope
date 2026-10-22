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
      /*get: () => {
            return new Proxy(state, {
                get(target, prop, receiver) {
                    if (prop === 'status') {
                        return new Proxy(target.status, {
                            get(status, key, receiver) {
                                if (key === 'channels') {
                                    console.trace('status.channels accessed');
                                }
                                return Reflect.get(status, key, receiver);
                            }
                        });
                    }

                    return Reflect.get(target, prop, receiver);
                }
            });
        },*/
      set: (patch) => {
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
        //console.log("store changed");
        subs.forEach((fn) => fn(state));
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
        status: {
            state: 'idle',
            message: '',
            sampleCount: 0,
            samplerate: 8_000_000,
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
        markerList: [],
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

  WS.store = { createStore, makeChannels, store, get: store.get, set: store.set, toast };
})(window.WS = window.WS || {});
