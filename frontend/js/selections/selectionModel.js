/**
 * selections/selectionModel.js — state + actions for measurement selections (Logic 2 style "M0, M1…").
 *
 * A selection lives in the store as plain, serialisable data:
 *   { id, name, start, end, rows:[rowKey…], color, comment }
 *     start/end  sample positions (integers, start < end)
 *     rows       row KEYS, not y-positions or indexes, so they survive layout changes:
 *                  'c<channelIndex>'          a channel row
 *                  'd<decoderId>.<rowId>'     a decoder row
 * Store keys used: `selections` (array) and `selectedSelection` (id | null).
 */
(function (WS) {
  'use strict';
  const { store } = WS;

  const COLORS = ['#d6336c', '#0ca35b', '#1f9bde', '#e0492f'];
  let seq = 0;

  const list = () => store.get().selections ?? [];
  const find = (id) => (id == null ? null : list().find((s) => s.id === id) ?? null);

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
    store.set((s) => ({ selections: [...(s.selections ?? []), sel], selectedSelection: sel.id }));
    return sel;
  }

  function update(id, patch) {
    store.set((s) => ({ selections: (s.selections ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  }

  function remove(id) {
    store.set((s) => ({
      selections: (s.selections ?? []).filter((x) => x.id !== id),
      selectedSelection: s.selectedSelection === id ? null : s.selectedSelection,
    }));
  }

  function select(id) {
    if ((store.get().selectedSelection ?? null) !== id) store.set({ selectedSelection: id });
  }

  /** The panel's "+" button: a selection in the middle of the view on the first row. */
  function addAtCenter() {
    const { view, plotWidth, status } = store.get();
    const rows = WS.uiRows.get();
    if (!rows.length || !status.sampleCount) return null;
    const span = view.spp * plotWidth, c = view.start + span / 2;
    const clamp = (v) => Math.max(0, Math.min(status.sampleCount, Math.round(v)));
    let start = clamp(c - span * 0.1), end = clamp(c + span * 0.1);
    if (end - start < 1) { start = clamp(c); end = Math.min(status.sampleCount, start + 1); }
    return create({ start, end, rows: [rowKey(rows[0])] });
  }

  WS.selections = Object.assign(WS.selections ?? {}, {
    COLORS, list, find, rowKey, channelsOf, runs, indexRange, keysBetween, create, update, remove, select, addAtCenter,
  });
})(window.WS = window.WS || {});
