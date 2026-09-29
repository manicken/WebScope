/**
 * ui/waveform.js — the canvas render loop (coalesced to one frame, like the original
 * draw.current.pending/busy/again pattern) and all pointer interaction: pan, zoom, A/B
 * markers, hover measurement, Cmd/Ctrl+click to frame an annotation or burst, and plain
 * click on a decoder row to focus that row in the data table.
 * Ported from edgewise's src/renderer/src/components/Waveform.tsx.
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;
  const { drawFrame, annKey } = WS.draw;
  const { engine } = WS;
  const { annotationAt } = WS.view;
  const { RULER_H } = WS.theme;
  const { fmtTime, fmtFreq } = WS.format;
  const A = WS.actions;

  function init({ canvas, plotWrap, hoverTipEl, emptyStateEl }) {
    const size = { w: 0, h: 0, dpr: 1 };
    const scroll = { y: 0 };
    let lastBurst = null;
    let pointer = null;
    let modHeld = false;
    let drag = null; // { kind:'pan'|'marker', marker, x0, last, moved }
    const MOD_KEY = navigator.platform?.startsWith('Mac') ? 'metaKey' : 'ctrlKey';

    function resize() {
      const r = plotWrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.w = r.width; size.h = r.height; size.dpr = dpr;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      set({ plotWidth: r.width });
    }
    new ResizeObserver(resize).observe(plotWrap);

    let drawPending = false;
    function requestDraw() { if (!drawPending) { drawPending = true; requestAnimationFrame(render); } }

    function rowAt(y) { return WS.uiRows.rowAt(y, scroll.y, RULER_H); }

    function hitTestAnnotation() {
      if (!modHeld || !pointer || pointer.y < RULER_H) return null;
      const row = rowAt(pointer.y);
      if (!row || row.kind !== 'decoder') return null;
      const { view } = get();
      const anns = engine.annotations(row.dec.id, row.row, view.start, view.start + size.w * view.spp, view.spp * 3, 4000);
      const a = annotationAt(anns, view.start + pointer.x * view.spp, 2 * view.spp);
      return a ? { decoder: row.dec.id, row: row.row, start: a.start, end: a.end } : null;
    }

    function burstTarget() {
      if (!modHeld || !pointer || pointer.y < RULER_H) return null;
      const row = rowAt(pointer.y);
      if (!row || row.kind !== 'channel') return null;
      const { view } = get();
      const sample = view.start + pointer.x * view.spp;
      return sample < 0 ? null : { channel: row.ch.index, sample, spp: view.spp };
    }
    function updateBurst() {
      const t = burstTarget();
      const next = t ? (() => { const b = engine.burstAt(t.channel, t.sample, 8 * t.spp, 2 * t.spp); return b ? { channel: t.channel, ...b } : null; })() : null;
      if (next && lastBurst && next.channel === lastBurst.channel && next.start === lastBurst.start && next.end === lastBurst.end) return;
      if (!next && !lastBurst) return;
      lastBurst = next;
    }

    function local(e) { const r = plotWrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    function render() {
      drawPending = false;
      const { w, h, dpr } = size;
      if (w === 0) return;
      const st = get();
      emptyStateEl.style.display = st.status.samples > 0 || st.status.state === 'running' ? 'none' : 'flex';
      const cols = Math.ceil(w * dpr);
      let wave = null;
      if (st.status.samples > 0) {
        if (st.view.spp >= 1) wave = { kind: 'lod', data: engine.render(st.view.start, st.view.spp / dpr, cols), spp: st.view.spp };
        else {
          const first = Math.max(0, Math.floor(st.view.start));
          const { first: f0, data } = engine.samples(first, Math.ceil(w * st.view.spp) + 2);
          wave = { kind: 'raw', data, first: f0 };
        }
      }
      const rows = WS.uiRows.get();
      const decRows = rows.filter((r) => r.kind === 'decoder');
      const end = st.view.start + w * st.view.spp;
      const annotations = new Map();
      for (const r of decRows) annotations.set(annKey(r.dec.id, r.row), engine.annotations(r.dec.id, r.row, st.view.start, end, st.view.spp * 3, 4000));

      const hl = hitTestAnnotation();
      updateBurst();

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrame(ctx, w, h, dpr, {
        view: st.view, samplerate: st.status.samplerate, samples: st.status.samples, trigger: st.status.trigger,
        rows, scrollY: scroll.y, wave, annotations, markers: st.markers, hover: st.hover, measurement: st.measurement,
        hoverChannel: st.hover ? st.hover.channel : null, highlight: hl, burst: lastBurst
      });
      renderHoverTip();
    }

    function renderHoverTip() {
      const { hover, measurement, status } = get();
      if (!hover || !measurement || hover.channel === null) { hoverTipEl.style.display = 'none'; return; }
      const width = (measurement.end - measurement.start) / status.samplerate;
      const period = measurement.period ? measurement.period / status.samplerate : null;
      let html = `<div><b>${measurement.high ? 'High' : 'Low'}</b> ${fmtTime(width)}</div>`;
      if (period) {
        html += `<div><span class="muted">Period</span> ${fmtTime(period)}</div>`;
        html += `<div><span class="muted">Freq</span> ${fmtFreq(1 / period)}</div>`;
        html += `<div><span class="muted">Duty</span> ${(((measurement.highTime || 0) / (measurement.period || 1)) * 100).toFixed(1)}%</div>`;
      }
      hoverTipEl.innerHTML = html;
      hoverTipEl.style.left = hover.x + 14 + 'px'; hoverTipEl.style.top = hover.y + 14 + 'px';
      hoverTipEl.style.display = 'block';
    }

    canvas.addEventListener('pointerdown', (e) => {
      const { x, y } = local(e);
      const { view, markers } = get();
      pointer = { x, y }; modHeld = e[MOD_KEY];
      const row = y >= RULER_H ? rowAt(y) : undefined;
      if (modHeld && row?.kind === 'decoder') { const hit = hitTestAnnotation(); if (hit) A.frameSpan(hit.start, hit.end); return; }
      if (modHeld && row?.kind === 'channel') { const t = burstTarget(); if (t) { const b = engine.burstAt(t.channel, t.sample, 8 * t.spp, 2 * t.spp); if (b) A.frameSpan(b.start, b.end); } return; }
      canvas.setPointerCapture(e.pointerId);
      if (y < RULER_H) {
        const near = (s) => s !== null && Math.abs((s - view.start) / view.spp - x) < 8;
        const marker = near(markers.b) ? 'b' : near(markers.a) ? 'a' : markers.a === null ? 'a' : 'b';
        set({ markers: { ...markers, [marker]: view.start + x * view.spp } });
        drag = { kind: 'marker', marker, x0: x, last: x, moved: false };
      } else drag = { kind: 'pan', x0: x, last: x, moved: false };
    });

    canvas.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      const { view } = get();
      const sample = view.start + x * view.spp;
      pointer = { x, y }; modHeld = e[MOD_KEY];
      if (drag) {
        if (Math.abs(x - drag.x0) > 3) drag.moved = true;
        if (drag.kind === 'pan') A.panBy(drag.last - x);
        else set({ markers: { ...get().markers, [drag.marker]: sample } });
        drag.last = x; return;
      }
      const row = y >= RULER_H ? rowAt(y) : undefined;
      const channel = row?.kind === 'channel' ? row.ch.index : null;
      set({ hover: { sample, channel, x, y } });
      if (channel !== null && engine.hasData()) set({ measurement: engine.measure(channel, Math.floor(sample)) });
      else if (get().measurement) set({ measurement: null });
    });

    window.addEventListener('pointerup', (e) => {
      const dr = drag;
      drag = null;
      if (!dr || dr.moved || dr.kind !== 'pan') return;
      // Plain click on a decoder row: focus that annotation in the data table.
      const { x, y } = local(e);
      const row = rowAt(y);
      if (row?.kind === 'decoder' && engine.hasData()) {
        const sample = get().view.start + x * get().view.spp;
        const index = engine.annotationIndex(row.dec.id, row.row, sample);
        set({ table: { decoder: row.dec.id, row: row.row, focus: index } });
      }
    });

    canvas.addEventListener('pointerleave', () => { pointer = null; if (!drag) set({ hover: null, measurement: null }); requestDraw(); });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = local(e);
      if (get().measurement) set({ measurement: null });
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal || e.shiftKey) A.panBy(horizontal ? e.deltaX : e.deltaY);
      else { const k = e.ctrlKey ? 0.012 : 0.0025; A.zoomAt(Math.exp(e.deltaY * k), x); }
    }, { passive: false });

    canvas.addEventListener('dblclick', (e) => { if (local(e).y < RULER_H) set({ markers: { a: null, b: null } }); });

    const modKeyName = MOD_KEY === 'metaKey' ? 'Meta' : 'Control';
    window.addEventListener('keydown', (e) => { if (e.key === modKeyName) { modHeld = true; requestDraw(); } });
    window.addEventListener('keyup', (e) => { if (e.key === modKeyName) { modHeld = false; requestDraw(); } });

    WS.store.store.subscribe(requestDraw);
    WS.uiRows.onShapeChange(requestDraw);

    resize();
    requestDraw();

    return { requestDraw, setScroll(y) { scroll.y = y; requestDraw(); } };
  }

  WS.ui = WS.ui || {};
  WS.ui.waveform = { init };
})(window.WS = window.WS || {});
