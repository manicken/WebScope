/**
 * markers/markerModel.js — time markers (single or paired), Logic 2 style.
 * Replaces the old fixed A/B pair (store key `markers`, now unused) with a list in the store:
 *   markers      [{ id, kind:'single', name, color, comment, at }
 *                    { id, kind:'pair',   name, color, comment, a, b }]     positions are sample indexes
 *   selectedMarker  id | null
 * Display tags: single → "A"; pair → "A1" / "A2".
 */
(function (WS) {
  'use strict';
  const { store } = WS;

  const COLORS = ['#22d3ee', '#ff9f43', '#a78bfa', '#51cf66', '#f783ac', '#ffd43b'];
  let seq = 0;

  const list = () => store.get().markers ?? [];
  const find = (id) => (id == null ? null : list().find((m) => m.id === id) ?? null);

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
    const { view, plotWidth, status } = store.get();
    if (!status.sampleCount) return null;
    const span = view.spp * plotWidth, c = view.start + span / 2;
    const clamp = (v) => Math.max(0, Math.min(status.sampleCount, Math.round(v)));
    seq++;
    const m = { id: 'm' + Date.now().toString(36) + seq, kind, name: nextName(), color: COLORS[(seq - 1) % COLORS.length], comment: '' };
    if (kind === 'pair') {
      m.a = clamp(c - span * 0.1); m.b = clamp(c + span * 0.1);
      if (m.b <= m.a) m.b = Math.min(status.sampleCount, m.a + 1);
    } else m.at = clamp(c);
    store.set((s) => ({ markers: [...(s.markers ?? []), m], selectedMarker: m.id, selectedSelection: null }));
    return m;
  }

  function update(id, patch) {
    store.set((s) => ({ markers: (s.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  }
  function remove(id) {
    store.set((s) => ({
      markers: (s.markers ?? []).filter((m) => m.id !== id),
      selectedMarker: s.selectedMarker === id ? null : s.selectedMarker,
    }));
  }
  function select(id) {
    if ((store.get().selectedMarker ?? null) === id) return;
    store.set(id == null ? { selectedMarker: null } : { selectedMarker: id, selectedSelection: null });
  }

  /** Bring a marker (or the span of a pair) into view. */
  function goTo(m) {
    const { view, plotWidth } = store.get();
    if (m.kind === 'pair') { WS.waveform.frameSpan(Math.min(m.a, m.b), Math.max(m.a, m.b)); return; }
    store.set({ view: WS.waveform.clampView(m.at - (view.spp * plotWidth) / 2, view.spp), follow: false });
  }

  WS.timeMarkers = { COLORS, list, find, positions, add, update, remove, select, goTo };
})(window.WS = window.WS || {});
