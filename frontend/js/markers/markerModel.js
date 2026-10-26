/**
 * markers/markerModel.js — time markers (single or paired), Logic 2 style.
 * State in appState.markers (ReactiveValues):
 *   list      [{ id, kind:'single', name, color, comment, at }
 *              { id, kind:'pair',   name, color, comment, a, b }]     positions are sample indexes
 *   selected  id | null      (selecting a marker deselects the selected measurement selection)
 * Display tags: single → "A"; pair → "A1" / "A2".
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const state = appState.markers;

  const COLORS = ['#22d3ee', '#ff9f43', '#a78bfa', '#51cf66', '#f783ac', '#ffd43b'];
  let seq = 0;

  const list = () => state.list.value;
  const find = (id) => (id == null ? null : list().find((m) => m.id === id) ?? null);
  const selected = () => state.selected.value;

  function positions(m) {
    return m.kind === 'pair'
      ? [{ key: 'a', s: m.a, tag: m.name + '1' }, { key: 'b', s: m.b, tag: m.name + '2' }]
      : [{ key: 'at', s: m.at, tag: m.name }];
  }

  function letter(n) { // 0→A … 25→Z, 26→AA …
    let s = ''; n++;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function nextName() {
    const used = new Set(list().map((m) => m.name));
    let i = 0; while (used.has(letter(i))) i++;
    return letter(i);
  }

  function add(kind) {
    const view = WS.waveform.getView();
    const sampleCount = WS.capture.length();
    if (!sampleCount) return null;
    const span = view.spp * view.plotWidth, c = view.start + span / 2;
    const clamp = (v) => Math.max(0, Math.min(sampleCount, Math.round(v)));
    seq++;
    const m = { id: 'm' + Date.now().toString(36) + seq, kind, name: nextName(), color: COLORS[(seq - 1) % COLORS.length], comment: '' };
    if (kind === 'pair') {
      m.a = clamp(c - span * 0.1); m.b = clamp(c + span * 0.1);
      if (m.b <= m.a) m.b = Math.min(sampleCount, m.a + 1);
    } else m.at = clamp(c);
    state.list.set([...list(), m]);
    select(m.id);
    return m;
  }

  function update(id, patch) {
    const i = list().findIndex((m) => m.id === id);
    if (i < 0) return;
    const next = [...list()];
    next[i] = { ...next[i], ...patch };
    state.list.set(next);
  }
  function remove(id) {
    if (selected() === id) state.selected.set(null);
    state.list.set(list().filter((m) => m.id !== id));
  }
  function select(id) {
    if (id != null) appState.selections.selected.set(null);
    state.selected.set(id);
  }

  /** Bring a marker (or the span of a pair) into view. */
  function goTo(m) {
    const view = WS.waveform.getView();
    if (m.kind === 'pair') { WS.waveform.frameSpan(Math.min(m.a, m.b), Math.max(m.a, m.b)); return; }
    WS.waveform.setView(WS.waveform.clampView(m.at - (view.spp * view.plotWidth) / 2, view.spp));
  }

  WS.timeMarkers = { COLORS, list, find, selected, positions, add, update, remove, select, goTo };
})(window.WS = window.WS || {});
