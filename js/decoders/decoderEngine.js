/**
 * decoderEngine.js — runs decoders over the capture and keeps their results.
 * Adds decode()/decodedResult() to WS.engine. Annotation queries on top of the results live in
 * annotations/annotationEngine.js.
 */
(function (WS) {
  'use strict';
  const { engine } = WS;

  const decodedCache = new Map(); // decoder id -> { anns: Annotation[] }

  function runDecoder(inst) {
    const impl = WS.decoders[inst.kind];
    if (!impl) return null;
    //console.log(WS.engine);
    return impl.run(WS.engine.getBuffer(), inst.config);
  }

  Object.assign(engine, {
    decode(id) {
      console.log("decode ID:" + id);
      if (!engine.hasData()) return;
      const inst = WS.store.get().decoders.find((d) => d.id === id);
      if (!inst) return;

      decodedCache.set(id, runDecoder(inst));
      
      WS.store.set((s) => ({ status: { ...s.status, decodeGen: s.status.decodeGen + 1 } }));
    },
    /** Result stored by the last decode(id), or undefined. Annotations are in `.anns`. */
    decodedResult(id) { return decodedCache.get(id); }
  });
})(window.WS = window.WS || {});
