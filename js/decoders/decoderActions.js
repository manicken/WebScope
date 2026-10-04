/**
 * decoderActions.js — add / remove / show-hide / reconfigure decoder instances.
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;
  const { engine } = WS;
  const A = (WS.actions = WS.actions || {});

  function addDecoder(kind, config) {
    const cfg = { ...WS.decoderDefaults[kind], ...config };
    const id = get().decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1; // find the last used id and add 1
    const n = get().decoders.length;
    const color = WS.theme.DECODER_COLORS[n % WS.theme.DECODER_COLORS.length];
    const rows = WS.decoders[kind].rows();
    const d = { id, kind, name: WS.decoderNames[kind], color, config: cfg, rows, visible: true };
    set({ decoders: [...get().decoders, d], table: { decoder: id, row: 0, focus: null } });
    engine.decode(id);
  }
  function removeDecoder(id) {
    const remaining = get().decoders.filter((d) => d.id !== id);
    const table = get().table;
    set({ decoders: remaining, table: table.decoder === id ? { decoder: remaining[0]?.id ?? null, row: 0, focus: null } : table });
  }
  function toggleDecoderVisible(id) {
    set({ decoders: get().decoders.map((d) => d.id === id ? { ...d, visible: !d.visible } : d) });
  }
  function updateDecoder(id, patch) {
    const d = get().decoders.find((x) => x.id === id);
    if (!d) return;
    const config = { ...d.config, ...patch };
    set({ decoders: get().decoders.map((x) => x.id === id ? { ...x, config } : x) });
    engine.decode(id);
  }

  Object.assign(A, { addDecoder, removeDecoder, toggleDecoderVisible, updateDecoder });
})(window.WS = window.WS || {});
