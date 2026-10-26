/**
 * selections/selectionModel.js — state + actions for measurement selections (Logic 2 style "M0, M1…").
 *
 * A selection is plain, serialisable data:
 *   { id, name, start, end, rows:[rowKey…], color, comment }
 *     start/end  sample positions (integers, start < end)
 *     rows       row KEYS, not y-positions or indexes, so they survive layout changes:
 *                  'c<channelIndex>'          a channel row
 *                  'd<decoderId>.<rowId>'     a decoder row
 * State in appState.selections (ReactiveValues): list, selected (id | null) and statChannel (see selectionPopup.js).
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const state = appState.selections;

  const COLORS = ['#d6336c', '#0ca35b', '#1f9bde', '#e0492f'];
  let seq = 0;

  const list = () => state.list.value;
  const find = (id) => (id == null ? null : list().find((s) => s.id === id) ?? null);
  const selected = () => state.selected.value;

  function rowKey(r) { return r.kind === 'channel' ? 'c' + r.ch.index : 'd' + r.dec.id + '.' + r.rowId; }
  function channelsOf(sel) { return sel.rows.filter((k) => k[0] === 'c').map((k) => parseInt(k.slice(1), 10)); }

  /** Contiguous vertical runs of rows covered by the selection, in canvas content coordinates. */
  function runs(sel, rows) {
    const keys = new Set(sel.rows);
    const out = [];
    for (const r of rows) {
      if (!keys.has(rowKey(r))) continue;
      const last = out[out.length - 1];
      if (last && Math.abs(last.y1 - r.y) < 0.5) last.y1 = r.y + r.h;
      else out.push({ y0: r.y, y1: r.y + r.h });
    }
    return out;
  }

  /** Lowest/highest index (in the current layout) of the rows the selection covers. */
  function indexRange(sel, rows) {
    const keys = new Set(sel.rows);
    let lo = -1, hi = -1;
    rows.forEach((r, i) => { if (keys.has(rowKey(r))) { if (lo < 0) lo = i; hi = i; } });
    return lo < 0 ? null : { lo, hi };
  }

  function keysBetween(rows, a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return rows.slice(lo, hi + 1).map(rowKey);
  }

  function nextName() {
    const used = new Set(list().map((s) => s.name));
    let i = 0; while (used.has('M' + i)) i++;
    return 'M' + i;
  }

  function create({ start, end, rows, color }) {
    seq++;
    const sel = {
      id: 's' + Date.now().toString(36) + seq,
      name: nextName(),
      start: Math.min(start, end), end: Math.max(start, end),
      rows: rows ?? [],
      color: color ?? COLORS[(seq - 1) % COLORS.length],
      comment: '',
    };
    state.list.set([...list(), sel]);
    select(sel.id);
    return sel;
  }

  function update(id, patch) {
    const i = list().findIndex((x) => x.id === id);
    if (i < 0) return;
    const next = [...list()];
    next[i] = { ...next[i], ...patch };
    state.list.set(next);
  }

  function remove(id) {
    if (selected() === id) state.selected.set(null);
    state.list.set(list().filter((x) => x.id !== id));
  }

  function select(id) {
    if (id != null) appState.markers.selected.set(null);
    state.selected.set(id);
  }

  /** The panel's "+" button: a selection in the middle of the view on the first row. */
  function addAtCenter() {
    const view = WS.waveform.getView();
    const sampleCount = WS.capture.length();
    const rows = WS.uiRows.get();
    if (!rows.length || !sampleCount) return null;
    const span = view.spp * view.plotWidth, c = view.start + span / 2;
    const clamp = (v) => Math.max(0, Math.min(sampleCount, Math.round(v)));
    let start = clamp(c - span * 0.1), end = clamp(c + span * 0.1);
    if (end - start < 1) { start = clamp(c); end = Math.min(sampleCount, start + 1); }
    return create({ start, end, rows: [rowKey(rows[0])] });
  }

  WS.selections = Object.assign(WS.selections ?? {}, {
    COLORS, list, find, selected, rowKey, channelsOf, runs, indexRange, keysBetween, create, update, remove, select, addAtCenter,
  });
})(window.WS = window.WS || {});
