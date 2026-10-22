/**
 * markers/markerDraw.js — canvas drawing of the time markers.
 *   drawLines()  from drawFrame, in screen coordinates (below the ruler), replaces the old A/B lines
 *   drawFlags()  from drawRuler, the name tags on the ruler
 */
(function (WS) {
  'use strict';
  const T = WS.timeMarkers;
  const { RULER_H, hexA } = WS.theme;

  function drawLines(ctx, w, h, f, x) {
    const list = f.markers;
    if (!list || !list.length) return;
    const sr = WS.store.get().status.samplerate;
    ctx.save();
    ctx.font = '11px "SF Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const m of list) {
      const on = m.id === f.selectedMarker;
      if (m.kind === 'pair') {
        const xa = x(m.a), xb = x(m.b), l = Math.min(xa, xb), wd = Math.abs(xb - xa);
        ctx.fillStyle = hexA(m.color, 0.10);
        ctx.fillRect(l, RULER_H, wd, h - RULER_H);
        const label = WS.format.fmtTime(Math.abs(m.b - m.a) / sr, 4);
        const tw = ctx.measureText(label).width + 10;
        if (wd > tw + 8 && l + wd > 0 && l < w) {
          const cx = Math.min(Math.max(l + wd / 2, tw / 2 + 2), w - tw / 2 - 2);
          ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(cx - tw / 2, RULER_H + 6, tw, 16, 4); ctx.fill();
          ctx.fillStyle = m.color; ctx.fillText(label, cx, RULER_H + 14.5);
        }
      }
      ctx.strokeStyle = m.color; ctx.lineWidth = on ? 2 : 1;
      for (const p of T.positions(m)) {
        const px = Math.round(x(p.s)) + 0.5;
        if (px < 0 || px > w) continue;
        ctx.beginPath(); ctx.moveTo(px, RULER_H); ctx.lineTo(px, h); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawFlags(ctx, w, f, x) {
    const list = f.markers;
    if (!list || !list.length) return;
    ctx.save();
    ctx.font = 'bold 10px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const m of list) {
      const on = m.id === f.selectedMarker;
      for (const p of T.positions(m)) {
        const px = Math.round(x(p.s));
        if (px < -30 || px > w + 30) continue;
        const tw = Math.max(18, ctx.measureText(p.tag).width + 8);
        ctx.fillStyle = m.color; ctx.beginPath(); ctx.roundRect(px - tw / 2, RULER_H - 17, tw, 15, 4); ctx.fill();
        if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(px - tw / 2, RULER_H - 17, tw, 15, 4); ctx.stroke(); }
        ctx.fillStyle = '#0a0b0f'; ctx.fillText(p.tag, px, RULER_H - 9);
        if (m.comment) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px + tw / 2 - 3, RULER_H - 14, 2, 0, Math.PI * 2); ctx.fill(); } // has a comment
      }
    }
    ctx.restore();
  }

  Object.assign(T, { drawLines, drawFlags });
})(window.WS = window.WS || {});
