/**
 * ui/waveform.js — the canvas render loop (coalesced to one frame, like the original
 * draw.current.pending/busy/again pattern) and all pointer interaction: pan, zoom, A/B
 * markers, hover measurement, Cmd/Ctrl+click to frame an annotation or burst, and plain
 * click on a decoder row to focus that row in the data table.
 * Ported from edgewise's src/renderer/src/components/Waveform.tsx.
 */
(function (WS) {
  'use strict';
 

  const { appState, waveform, capture } = WS;
  const { pointer: pointerState, table } = appState;
  const { annKey, annotationAt, annotationsAtRowInRange, annotationIndex } = WS.annotations;
  const { RULER_H } = WS.theme;
  const { fmtTime, fmtFreq } = WS.format;

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
      appState.view.plotWidth.set(r.width);
    }
    new ResizeObserver(resize).observe(plotWrap);

    let drawPending = false;
    function requestDraw() { 
      if (!drawPending) { drawPending = true; requestAnimationFrame(render); }
    }

    function rowAt(y) { return WS.uiRows.rowAt(y, scroll.y, RULER_H); }

    function hitTestAnnotation() {
      if (!modHeld || !pointer || pointer.y < RULER_H) return null;
      const row = rowAt(pointer.y);
      if (!row || row.kind !== 'decoder') return null;
      const view = waveform.getView();
      const anns = annotationsAtRowInRange(row.dec.id, row.rowId, view.start, view.start + size.w * view.spp, view.spp * 3, 4000);
      const a = annotationAt(anns, view.start + pointer.x * view.spp, 2 * view.spp);
      return a ? { decoder: row.dec.id, row: row.rowId, start: a.start, end: a.end } : null;
    }

    function burstTarget() {
      if (!modHeld || !pointer || pointer.y < RULER_H) return null;
      const row = rowAt(pointer.y);
      if (!row || row.kind !== 'channel') return null;
      const view = waveform.getView();
      const sample = view.start + pointer.x * view.spp;
      return sample < 0 ? null : { channel: row.ch.index, sample, spp: view.spp };
    }
    function updateBurst() {
      const t = burstTarget();
      const next = t ? (() => { const b = capture.burstAt(t.channel, t.sample, 8 * t.spp, 2 * t.spp); return b ? { channel: t.channel, ...b } : null; })() : null;
      if (next && lastBurst && next.channel === lastBurst.channel && next.start === lastBurst.start && next.end === lastBurst.end) return;
      if (!next && !lastBurst) return;
      lastBurst = next;
    }

    function local(e) { const r = plotWrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    // time markers (js/markers/*): drag the flags / lines of the markers added in the Markers panel
    const tmInput = WS.timeMarkers.init({
      canvas, plotWrap,
      getEnv: () => ({ view: waveform.getView(), hasData: capture.hasData(), sampleCount: capture.length() }),
    });

    // measurement selections (js/selections/*): canvas interaction + HTML popup
    const selInput = WS.selections.init({
      canvas, plotWrap,
      getEnv: () => ({
        rows: WS.uiRows.get(), scrollY: scroll.y, view: waveform.getView(), w: size.w, h: size.h,
        hasData: capture.hasData(), sampleCount: capture.length()
      }),
    });

    function render() {
      drawPending = false;
      const { w, h, dpr } = size;
      if (w === 0) return;
      const view = waveform.getView();
      const buf = capture.buffer.value;
      const hover = pointerState.hover.value, measurement = pointerState.measurement.value;
      const { markers, selections } = appState;
      emptyStateEl.style.display = buf || appState.acquisition.state.value === 'running' ? 'none' : 'flex';
      const cols = Math.ceil(w * dpr);
      let wave = null;
      if (buf) {
        if (view.spp >= 1) wave = { kind: 'lod', data: WS.capture.render(view.start, view.spp / dpr, cols), spp: view.spp };
        else {
          const first = Math.max(0, Math.floor(view.start));
          const { first: f0, data } = capture.samples(first, Math.ceil(w * view.spp) + 2);
          wave = { kind: 'raw', data, first: f0 };
        }
      }
      const rows = WS.uiRows.get();
      const decRows = rows.filter((r) => r.kind === 'decoder');
      const end = view.start + w * view.spp;
      const annotationsMap = new Map();
      for (const r of decRows) annotationsMap.set(annKey(r), annotationsAtRowInRange(r.dec.id, r.rowId, view.start, end, view.spp * 3, 4000));
      const hl = hitTestAnnotation();
      updateBurst();

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      WS.waveform.drawFrame(ctx, w, h, dpr, {
        // without data the ruler is in samples (samplerate 1)
        view, samplerate: buf?.samplerate ?? 1, sampleCount: buf?.length ?? 0, trigger: buf?.trigger ?? null, timeOrigin: buf?.timeOrigin ?? 0,
        rows, scrollY: scroll.y, wave, annotations:annotationsMap, hover, measurement,
        hoverChannel: hover ? hover.channel : null, highlight: hl, burst: lastBurst,
        selections: selections.list.value, selectedSelection: selections.selected.value,
        markers: markers.list.value, selectedMarker: markers.selected.value
      });
      selInput.updatePopup();
      renderHoverTip();
    }

    function renderHoverTip() {
      const hover = pointerState.hover.value, measurement = pointerState.measurement.value;
      if (!hover || !measurement || hover.channel === null || !capture.hasData()) { hoverTipEl.style.display = 'none'; return; }
      const samplerate = capture.getBuffer().samplerate;
      const width = (measurement.end - measurement.start) / samplerate;
      const period = measurement.period ? measurement.period / samplerate : null;
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
      pointer = { x, y }; modHeld = e[MOD_KEY];
      const row = y >= RULER_H ? rowAt(y) : undefined;
      if (modHeld && row?.kind === 'decoder') { const hit = hitTestAnnotation(); if (hit) waveform.frameSpan(hit.start, hit.end); return; }
      if (modHeld && row?.kind === 'channel') { const t = burstTarget(); if (t) { const b = capture.burstAt(t.channel, t.sample, 8 * t.spp, 2 * t.spp); if (b) waveform.frameSpan(b.start, b.end); } return; }
      canvas.setPointerCapture(e.pointerId);
      if (tmInput.down(e, x, y)) return;
      if (y >= RULER_H && selInput.down(e, x, y)) return;
      drag = { kind: 'pan', x0: x, lastX: x, y0:y, lastY:y, moved: false };
    });

    canvas.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      const view = waveform.getView();
      const sample = view.start + x * view.spp;
      if (tmInput.move(x) || selInput.move(x, y)) { pointer = { x, y }; return; }
      pointer = { x, y }; modHeld = e[MOD_KEY];
      if (drag) {
        if (Math.abs(x - drag.x0) > 3 || Math.abs(y - drag.y0) > 3) drag.moved = true;
        if (drag.kind === 'pan') {
          scrollBy(drag.lastY - y)
          waveform.panBy(drag.lastX - x);
        }
        drag.lastY = y;
        drag.lastX = x;
        return;
      }
      const row = y >= RULER_H ? rowAt(y) : undefined;
      const channel = row?.kind === 'channel' ? row.ch.index : null;
      selInput.hover(x, y);
      tmInput.hover(x, y);
      const measurement = channel !== null && WS.capture.hasData() ? WS.capture.measure(channel, Math.floor(sample)) : null;
      pointerState.measurement.set(measurement);
      pointerState.hover.set({ sample, channel, x, y });
    });

    window.addEventListener('pointerup', (e) => {
      if (tmInput.up() || selInput.up()) return;
      const dr = drag;
      drag = null;
      if (dr && dr.kind === 'pan' && !dr.moved && local(e).y >= RULER_H) selInput.clickEmpty();
      if (!dr || dr.moved || dr.kind !== 'pan') return;
      // Plain click on a decoder row: focus that annotation in the data table.
      const { x, y } = local(e);
      const row = y >= RULER_H ? rowAt(y) : undefined;
      if (row?.kind === 'decoder' && capture.hasData()) {
        const view = waveform.getView();
        const sample = view.start + x * view.spp; // spp = samples per pixel
        const index = annotationIndex(row.dec.id, row.rowId, sample);
        table.decoder.set(row.dec.id);
        table.rowId.set(row.rowId);
        table.focus.set(index);
      }
    });

    canvas.addEventListener('pointerleave', () => { pointer = null; if (!drag) { pointerState.hover.set(null); pointerState.measurement.set(null); } requestDraw(); });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = local(e);
      pointerState.measurement.set(null);
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal || e.shiftKey) waveform.panBy(horizontal ? e.deltaX : e.deltaY);
      else { const k = e.ctrlKey ? 0.012 : 0.0025; waveform.zoomAt(Math.exp(e.deltaY * k), x); }
    }, { passive: false });

    const modKeyName = MOD_KEY === 'metaKey' ? 'Meta' : 'Control';
    window.addEventListener('keydown', (e) => { if (e.key === modKeyName) { modHeld = true; requestDraw(); } });
    window.addEventListener('keyup', (e) => { if (e.key === modKeyName) { modHeld = false; requestDraw(); } });

    // everything the canvas shows (the table and the capture settings are not drawn)
    const { view, markers, selections } = appState;
    ReactiveValue.subscribeAll([
      view.start, view.spp, capture.buffer, appState.acquisition.state, WS.decoders.revision,
      pointerState.hover, pointerState.measurement,
      markers.list, markers.selected, selections.list, selections.selected, selections.statChannel,
    ], requestDraw);
    ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.color], requestDraw);
    WS.uiRows.onShapeChange(requestDraw); // channels / decoders shown or hidden

    resize();
    requestDraw();

    const gutterEl = document.getElementById('gutter');
    function scrollBy(dy) {
      gutterEl.scrollTop += dy;
    }

    return { requestDraw, setScroll(y) { scroll.y = y; requestDraw(); }, getDrawPending() { return drawPending; }  };
  }
  WS.waveform.ui = { init };

})(window.WS = window.WS || {});
