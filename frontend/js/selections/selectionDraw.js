/**
 * selections/selectionDraw.js — canvas drawing.
 *   draw()      called from drawFrame INSIDE the translate/clip block, so rows are in content coordinates
 *   drawTags()  called after drawRuler(), the "M0" tag hanging in the ruler
 */
(function (WS) {
  'use strict';
  const S = WS.selections;

  function draw(ctx, w, f, x) {
    const sels = f.selections;
    if (!sels || !sels.length) return;
    const { hexA } = WS.theme;
    for (const sel of sels) {
      const x0 = x(sel.start), x1 = x(sel.end);
      if (x1 < -2 || x0 > w + 2) continue;
      const on = sel.id === f.selectedSelection;
      const rs = S.runs(sel, f.rows);
      const ax = Math.round(x0), bx = Math.max(Math.round(x1), ax + 1);
      for (const r of rs) {
        ctx.fillStyle = hexA(sel.color, 0.30);
        ctx.fillRect(ax, r.y0, bx - ax, r.y1 - r.y0);
        ctx.lineWidth = on ? 1.5 : 1;
        ctx.strokeStyle = on ? '#ffffff' : hexA(sel.color, 0.9);
        ctx.strokeRect(ax + 0.5, r.y0 + 0.5, bx - ax - 1, r.y1 - r.y0 - 1);
      }
      if (on && rs.length) {
        // grips: left/right on the first run, top/bottom at the horizontal centre
        const first = rs[0], last = rs[rs.length - 1], cx = (ax + bx) / 2, my = (first.y0 + first.y1) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.roundRect(ax - 2, my - 8, 5, 16, 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(bx - 3, my - 8, 5, 16, 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(cx - 8, first.y0 - 2, 16, 5, 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(cx - 8, last.y1 - 3, 16, 5, 2); ctx.fill();
      }
    }
  }

  function drawTags(ctx, w, f, x) {
    const sels = f.selections;
    if (!sels || !sels.length) return;
    ctx.save();
    ctx.font = 'bold 10px -apple-system, Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const sel of sels) {
      const x0 = x(sel.start), x1 = x(sel.end);
      if (x1 < 0 || x0 > w) continue;
      const on = sel.id === f.selectedSelection;
      const tw = Math.max(26, ctx.measureText(sel.name).width + 12);
      const cx = Math.min(Math.max((x0 + x1) / 2, tw / 2 + 2), w - tw / 2 - 2);
      const top = 3, h = 15;
      ctx.fillStyle = sel.color;
      ctx.beginPath(); ctx.roundRect(cx - tw / 2, top, tw, h, 4); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx - 4, top + h); ctx.lineTo(cx + 4, top + h); ctx.lineTo(cx, top + h + 4); ctx.closePath(); ctx.fill();
      if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(cx - tw / 2, top, tw, h, 4); ctx.stroke(); }
      ctx.fillStyle = '#fff';
      ctx.fillText(sel.name, cx, top + h / 2 + 0.5);
    }
    ctx.restore();
  }

  Object.assign(S, { draw, drawTags });
})(window.WS = window.WS || {});
