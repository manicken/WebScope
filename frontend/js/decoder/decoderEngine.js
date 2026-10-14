/**
 * decoderEngine.js — runs decoders over the capture and keeps their results.
 * 
 * annotations/annotationEngine.js.
 */
(function (WS) {
    'use strict';
    const { store } = WS;

    const decodedCache = new Map(); // decoder id -> { anns: Annotation[] }
    const registry = [];

    function addNewDecoder({item, parentDecoder=null}) {
        const decoders = store.get().decoders;
        const id = decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1; // find the last used id and add 1
        const color = WS.theme.DECODER_COLORS[decoders.length % WS.theme.DECODER_COLORS.length];
        const newDec = new item.class({ id, color, parentDecoder });
        if (parentDecoder != null) {
            parentDecoder.addSubDecoder(newDec);
        }
        store.set({ decoders: [...decoders, newDec], table: { decoder: id, row: 0, focus: null } });
        console.log(newDec);
        decode(id);
    }

    function removeDecoder(id) {
        console.log("removed decoder:" + id);
        const d = store.get().decoders.find((x) => x.id === id);
        if (d) {
            d.destroy();
        }
        const remaining = store.get().decoders.filter((d) => d.id !== id);
        console.log(remaining);
        const table = store.get().table;
        store.set({ decoders: remaining, table: table.decoder === id ? { decoder: remaining[0]?.id ?? null, row: 0, focus: null } : table });
    }
    function toggleDecoderVisible(id) {
        const d = store.get().decoders.find((x) => x.id === id);
        if (!d) return;
        d.visible = !d.visible;
        store.set({ decoders: store.get().decoders });
    }
    function updateDecoder(id, patch) {
        const d = store.get().decoders.find((x) => x.id === id);
        if (!d) return;
        d.cfg = { ...d.cfg, ...patch };
        store.set({ decoders: store.get().decoders });
        decode(id);
    }

    function decode(id) {
        //console.log("decode ID:" + id);
        if (!WS.capture.hasData()) return;
        const inst = WS.store.get().decoders.find((d) => d.id === id);
        if (!inst) return;

        let decRes = inst.run(WS.capture.getBuffer());
        //console.log(decRes);
        decodedCache.set(id, decRes);
        
        WS.store.set((s) => ({ status: { ...s.status, decodeGen: s.status.decodeGen + 1 } }));
    }

    WS.decoders = Object.assign(WS.decoders ?? {}, {
        registry,
        decode,
        addNewDecoder,
        removeDecoder,
        toggleDecoderVisible, 
        updateDecoder,
        /** Result stored by the decode(id), or undefined. Annotations are in `.anns`. */
        decodedResult(id) { return decodedCache.get(id); }
    });
})(window.WS = window.WS ?? {});
