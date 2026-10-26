/**
 * ui/rows.js — the current visible-rows layout, shared by the gutter and the waveform canvas.
 * Recomputed when channels or decoders change; listeners are notified only when the row
 * *shape* actually changed (not on every change, which would repaint the gutter needlessly).
 */
(function (WS) {
  'use strict';

  const { appState } = WS;
  const { layoutRows } = WS.uiRowsLayout;

  let rows = [];
  let shapeKey = '';
  let shownChannels = null;  // the channel list `rows` was made from
  const listeners = new Set();

  function rowShapeKey(rs) {
    return rs.map((r) => r.kind + ':' + (r.kind === 'channel' ? r.ch.index : r.dec.id + '.' + r.rowId)).join(',');
  }

  function recompute() {
    rows = layoutRows(appState.channels.value, WS.decoders.list.value);
    const key = rowShapeKey(rows);
    // new channel objects (e.g. another device with as many channels) are a new shape too
    if (key !== shapeKey || shownChannels !== appState.channels.value) {
      shapeKey = key;
      shownChannels = appState.channels.value;
      listeners.forEach((fn) => fn(rows));
    }
  }

  // which channels and decoders are shown; a decoder's rows can change when it ran (settings, compile)
  ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.visible], recompute);
  ReactiveValue.subscribeItems(WS.decoders.list, (d) => [d.visible], recompute);
  WS.decoders.revision.subscribe(recompute);
  recompute();

  WS.uiRows = {
    get: () => rows,
    onShapeChange: (fn) => { listeners.add(fn); },
    rowAt(y, scrollY, rulerH) {
      const yy = y - rulerH + scrollY;
      return rows.find((r) => yy >= r.y && yy < r.y + r.h);
    }
  };
})(window.WS = window.WS || {});
