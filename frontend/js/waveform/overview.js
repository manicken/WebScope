/**
 * ui/overview.js — whole-capture activity strip with the visible window highlighted.
 * Click/drag jumps the main view. Ported from edgewise's components/Overview.tsx;
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const { view } = appState;

  function init(canvas) {
    const cache = { buffer: null, width: 0, cols: null };

    function paint() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const v = WS.waveform.getView();
      const n = WS.capture.length();
      const cols = cache.cols;
      if (n > 0 && cols) {
        const mask = appState.channels.value.filter((c) => c.visible.value).reduce((m, c) => m | (1 << c.index), 0);
        const count = cols.length / 2;
        for (let i = 0; i < count; i++) {
          const toggles = cols[2 * i + 1] & mask;
          let bits = 0;
          for (let t = toggles; t; t &= t - 1) bits++;
          if (!bits) continue;
          const bh = 3 + (bits / 8) * (h - 8);
          ctx.fillStyle = `rgba(124,108,255,${0.35 + 0.08 * bits})`;
          ctx.fillRect(i / dpr, (h - bh) / 2, 1 / dpr, bh);
        }
        const x0 = (v.start / n) * w;
        const x1 = ((v.start + v.spp * v.plotWidth) / n) * w;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.roundRect(Math.max(0, x0) + 0.5, 1.5, Math.max(3, Math.min(w, x1) - Math.max(0, x0)) - 1, h - 3, 4);
        ctx.fill(); ctx.stroke();
      }
    }

    /** Re-reads the activity columns when the data or the canvas size changed, then paints. */
    function refresh() {
      const buf = WS.capture.buffer.value;
      if (buf && (cache.buffer !== buf || cache.width !== canvas.width)) {
        cache.buffer = buf;
        cache.width = canvas.width;
        cache.cols = WS.capture.render(0, buf.length / Math.max(canvas.width, 1), Math.max(canvas.width, 1));
      }
      if (!buf) cache.cols = null;
      paint();
    }

    function jump(e) {
      if (e.buttons !== 1) return;
      const r = canvas.getBoundingClientRect();
      const n = WS.capture.length();
      if (n === 0) return;
      const center = ((e.clientX - r.left) / r.width) * n;
      const spp = view.spp.value;
      WS.waveform.setView(WS.waveform.clampView(center - (spp * view.plotWidth.value) / 2, spp));
    }
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); jump(e); });
    canvas.addEventListener('pointermove', jump);

    new ResizeObserver(refresh).observe(canvas);
    // paint at most once per frame: a zoom changes both view.start and view.spp
    let paintPending = false;
    const requestPaint = () => {
      if (!paintPending) { paintPending = true; requestAnimationFrame(() => { paintPending = false; paint(); }); }
    };
    WS.capture.buffer.subscribe(refresh);
    ReactiveValue.subscribeAll([view.start, view.spp, view.plotWidth], requestPaint);
    ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.visible], requestPaint);
    refresh();
  }

  WS.overview = { init };
})(window.WS = window.WS || {});
