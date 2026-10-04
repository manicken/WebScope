/**
 * ui/overview.js — whole-capture activity strip with the visible window highlighted.
 * Click/drag jumps the main view. Ported from edgewise's components/Overview.tsx; the
 * engine.render() call is synchronous here (it was an IPC round-trip in the original).
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;

  function init(canvas) {
    const cache = { key: '', cols: null };

    function paint() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { status, view, plotWidth, channels } = get();
      const n = status.samples;
      const cols = cache.cols;
      if (n > 0 && cols) {
        const mask = channels.filter((c) => c.visible).reduce((m, c) => m | (1 << c.index), 0);
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
        const x0 = (view.start / n) * w;
        const x1 = ((view.start + view.spp * plotWidth) / n) * w;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.roundRect(Math.max(0, x0) + 0.5, 1.5, Math.max(3, Math.min(w, x1) - Math.max(0, x0)) - 1, h - 3, 4);
        ctx.fill(); ctx.stroke();
      }
    }

    function refresh() {
      const { status } = get();
      //const key = `${status.captureId}:${status.samples}:${canvas.width}`;
      const key = `${status.captureId}:${status.samples}:${canvas.width}:${WS.engine.hasData()}`;
      if (key !== cache.key && status.samples > 0) {
        cache.key = key;
        cache.cols = WS.engine.render(0, status.samples / Math.max(canvas.width, 1), Math.max(canvas.width, 1));
      }
      paint();
    }

    function jump(e) {
      if (e.buttons !== 1) return;
      const r = canvas.getBoundingClientRect();
      const { status, view, plotWidth } = get();
      if (status.samples === 0) return;
      const center = ((e.clientX - r.left) / r.width) * status.samples;
      set({ view: WS.actions.clampView(center - (view.spp * plotWidth) / 2, view.spp), follow: false });
    }
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); jump(e); });
    canvas.addEventListener('pointermove', jump);

    new ResizeObserver(refresh).observe(canvas);
    WS.store.store.subscribe(refresh);
    refresh();
  }

  WS.ui = WS.ui || {};
  WS.ui.overview = { init };
})(window.WS = window.WS || {});
