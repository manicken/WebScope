/**
 * ui/rows.js — the current visible-rows layout, shared by the gutter and the waveform canvas.
 * Recomputed whenever channels or decoders change; listeners are notified only when the row
 * *shape* actually changed (not on every store update, which would repaint the gutter needlessly).
 */
(function (WS) {
  'use strict';

  const { store } = WS.store;
  const { layoutRows } = WS.uiRowsLayout;

  let rows = [];
  let shapeKey = '';
  const listeners = new Set();

  function rowShapeKey(rs) { 
    return rs.map((r) => r.kind + ':' + (r.kind === 'channel' ? r.ch.index : r.dec.id + '.' + r.row??0)).join(',');
  }

  function recompute() {
    const s = store.get();
    //console.log(s.decoders);
   // console.log(s.channels, s.decoders);
    rows = layoutRows(s.channels, s.decoders);
    //console.trace(rows);
    const key = rowShapeKey(rows);
    //console.log(key);
    if (key !== shapeKey) { 
      shapeKey = key;
      listeners.forEach((fn) => fn(rows));
    }

  }

  store.subscribe(recompute);

  WS.uiRows = {
    get: () => rows,
    recompute,
    onShapeChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    rowAt(y, scrollY, rulerH) {
      const yy = y - rulerH + scrollY;
      return rows.find((r) => yy >= r.y && yy < r.y + r.h);
    }
  };
})(window.WS = window.WS || {});
