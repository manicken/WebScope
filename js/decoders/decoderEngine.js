/**
 * decoderEngine.js — runs decoders over the capture and keeps their results.
 * Adds decode()/decodedResult() to WS.engine. Annotation queries on top of the results live in
 * annotations/annotationEngine.js.
 */
(function (WS) {
    'use strict';
    const { engine, store } = WS;

    const decodedCache = new Map(); // decoder id -> { anns: Annotation[] }

    function addNewDecoder(classItem) {
        const decoders = store.get().decoders;
        const id = decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1; // find the last used id and add 1
        const color = WS.theme.DECODER_COLORS[decoders.length % WS.theme.DECODER_COLORS.length];
        const newDec = new classItem({ id, color });
        store.set({ decoders: [...decoders, newDec], table: { decoder: id, row: 0, focus: null } });
        console.log(newDec);
        decode(id);
    }

    function removeDecoder(id) {
        const remaining = store.get().decoders.filter((d) => d.id !== id);
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

    function runRootDecoder(inst) {
        return inst.run(WS.engine.getBuffer());
    }

    function decode(id) {
        console.log("decode ID:" + id);
        if (!engine.hasData()) return;
        const inst = WS.store.get().decoders.find((d) => d.id === id);
        if (!inst) return;

        decodedCache.set(id, runRootDecoder(inst));
        
        WS.store.set((s) => ({ status: { ...s.status, decodeGen: s.status.decodeGen + 1 } }));
    }

    WS.decoders = WS.decoders??{};

    Object.assign(WS.decoders, {
        decode,
        addNewDecoder,
        removeDecoder,
        toggleDecoderVisible, 
        updateDecoder,
        /** Result stored by the decode(id), or undefined. Annotations are in `.anns`. */
        decodedResult(id) { return decodedCache.get(id); }
    });
})(window.WS = window.WS || {});
