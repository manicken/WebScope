/**
 * annotationGui.js — how annotations are drawn as boxes on the waveform canvas.
 * (The "Decoded data" table lives in annotations/dataTable.js.)
 */
(function (WS) {
  'use strict';
  const { THEME, ANN, CLASS_COLORS, hexA } = WS.theme;

  const fitCache = new Map();
  function textWidth(ctx, s) {
    let wd = fitCache.get(s);
    if (wd === undefined) { wd = ctx.measureText(s).width; if (fitCache.size > 5000) fitCache.clear(); fitCache.set(s, wd); }
    return wd;
  }

  /** The text to draw in `max` px: a string is shortened with '…'; a list (longest to shortest, as in
   *  sigrok) gives the longest that fits, else its shortest shortened. */
  function fitText(ctx, t, max) {
    if (Array.isArray(t)) {
      for (const s of t) if (textWidth(ctx, String(s)) <= max) return String(s);
      t = String(t.at(-1) ?? '');
    }
    const s = String(t ?? ''), wd = textWidth(ctx, s);
    if (wd <= max) return s;
    const n = Math.floor((max / wd) * s.length) - 1;
    return n > 0 ? s.slice(0, n) + '…' : '';
  }

  function drawAnnotations(ctx, w, y, h, anns, color, x, highlight) {
    const top = y + 4, bh = h - 8;
    ctx.font = THEME.mono; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (const a of anns) {
      const x0 = Math.max(x(a.start), -10), x1 = Math.min(x(a.end), w + 10);
      const bw = Math.max(x1 - x0, 1);
      const lit = !!highlight && a.start === highlight.start && a.end === highlight.end;
      if (a.class === ANN.DENSE) {
        ctx.fillStyle = hexA(color, lit ? 0.5 : 0.28);
        ctx.fillRect(x0, top + 3, bw, bh - 6);
        if (lit) { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, top + 3.75, Math.max(bw - 1.5, 0), bh - 7.5); }
        continue;
      }
      // a decoder's own color for this annotation (e.g. WS281x: the LED's color), else its class's, else the decoder's
      const c = a.color ?? CLASS_COLORS[a.class] ?? color;
      ctx.fillStyle = hexA(c, lit ? 0.42 : 0.22);
      ctx.strokeStyle = lit ? c : hexA(c, 0.85);
      ctx.lineWidth = lit ? 1.5 : 1;
      ctx.beginPath(); ctx.roundRect(x0 + 0.5, top + 0.5, bw - 1, bh - 1, Math.min(5, bw / 2));
      ctx.fill();
      if (bw > 3 || lit) ctx.stroke();
      if (bw > 14) { ctx.fillStyle = '#eef0f6'; ctx.fillText(fitText(ctx, a.text, bw - 8), x0 + bw / 2, top + bh / 2 + 0.5); }
    }
    ctx.textAlign = 'left';
  }

  WS.annotations = Object.assign(WS.annotations ?? {}, { drawAnnotations });
})(window.WS = window.WS || {});