/**
 * draw.js — canvas frame rendering.
 * Ported 1:1 from edgewise's src/renderer/src/draw.ts. Takes a plain `Frame` object (see
 * drawFrame's f argument below) and a 2D context; no store/engine dependency.
 *
 * f.wave is either:
 *   { kind:'lod', data: Uint32Array, spp }        — 2 words/column: [first, toggleMask]
 *   { kind:'raw', data: Uint32Array, first }       — 1 word/sample
 */
(function (WS) {
  'use strict';
  const { THEME, RULER_H, hexA } = WS.theme;
  const { annKey, drawAnnotations } = WS.annotations;
  const { fmtTick, niceStep } = WS.format;

  function drawFrame(ctx, w, h, dpr, f) {
    const view = f.view;
    const x = (s) => (s - view.start) / view.spp;
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, w, h);

    const origin = f.trigger ?? 0;
    const secPerPx = view.spp / f.samplerate;
    const step = niceStep(secPerPx * 120);
    const t0 = (view.start - origin) / f.samplerate;
    const t1 = t0 + w * secPerPx;
    const ticks = [];
    for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) ticks.push(t);
    const tx = (t) => x(t * f.samplerate + origin);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, w, h - RULER_H);
    ctx.clip();
    ctx.translate(0, RULER_H - f.scrollY);

    f.rows.forEach((r, i) => { if (i % 2 === 1) { ctx.fillStyle = THEME.rowAlt; ctx.fillRect(0, r.y, w, r.h); } });
    const last = f.rows[f.rows.length - 1];
    const contentH = Math.max(h, (last ? last.y + last.h : 0) + RULER_H);
    ctx.lineWidth = 1;
    for (const t of ticks) {
      for (let m = 0; m < 5; m++) {
        const px = Math.round(tx(t + (m * step) / 5)) + 0.5;
        ctx.strokeStyle = m === 0 ? THEME.gridMajor : THEME.grid;
        ctx.beginPath(); ctx.moveTo(px, f.scrollY); ctx.lineTo(px, contentH); ctx.stroke();
      }
    }

    const endX = x(f.samples);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (x(0) > 0) ctx.fillRect(0, f.scrollY, x(0), contentH);
    if (endX < w) ctx.fillRect(endX, f.scrollY, w - endX, contentH);

    if (f.measurement && f.hoverChannel !== null) {
      const r = f.rows.find((r) => r.kind === 'channel' && r.ch.index === f.hoverChannel);
      if (r) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        const a = x(f.measurement.start);
        ctx.fillRect(a, r.y + 2, x(f.measurement.end) - a, r.h - 4);
      }
    }

    const burstRow = f.burst && f.rows.find((r) => r.kind === 'channel' && r.ch.index === f.burst.channel);
    if (f.burst && burstRow) {
      const x0 = Math.max(x(f.burst.start), -10), x1 = Math.min(x(f.burst.end), w + 10);
      const bw = Math.max(x1 - x0, 1);
      ctx.fillStyle = hexA(burstRow.ch.color, 0.18);
      ctx.fillRect(x0, burstRow.y + 2, bw, burstRow.h - 4);
      ctx.strokeStyle = burstRow.ch.color; ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, burstRow.y + 2.75, Math.max(bw - 1.5, 0), burstRow.h - 5.5);
    }

    for (const r of f.rows) {
      if (r.y + r.h < f.scrollY || r.y > f.scrollY + h) continue;
      if (r.kind === 'channel') drawChannel(ctx, w, dpr, r.ch.index, r.ch.color, r.y, r.h, f);
      else {
        const hl = f.highlight && f.highlight.decoder === r.dec.id && f.highlight.row === r.row ? f.highlight : null;
        drawAnnotations(ctx, w, r.y, r.h, f.annotations.get(annKey(r.dec.id, r.row)) || [], r.dec.color, x, hl);
      }
    }
    ctx.restore();

    const vline = (s, color, dash = []) => {
      const px = Math.round(x(s)) + 0.5;
      if (px < 0 || px > w) return;
      ctx.strokeStyle = color; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(px, RULER_H); ctx.lineTo(px, h); ctx.stroke();
      ctx.setLineDash([]);
    };
    if (f.trigger !== null) vline(f.trigger, THEME.trigger, [4, 3]);
    if (f.markers.a !== null && f.markers.b !== null) {
      const a = x(f.markers.a);
      ctx.fillStyle = 'rgba(124,108,255,0.08)';
      ctx.fillRect(a, RULER_H, x(f.markers.b) - a, h - RULER_H);
    }
    if (f.markers.a !== null) vline(f.markers.a, THEME.markerA);
    if (f.markers.b !== null) vline(f.markers.b, THEME.markerB);
    if (f.hover) vline(f.hover.sample, THEME.cursor, [2, 3]);

    drawRuler(ctx, w, ticks, step, tx, f, x);
  }

  function drawRuler(ctx, w, ticks, step, tx, f, x) {
    ctx.fillStyle = THEME.ruler; ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = THEME.border; ctx.fillRect(0, RULER_H - 1, w, 1);
    ctx.font = THEME.font; ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const px = Math.round(tx(t)) + 0.5;
      for (let m = 1; m < 5; m++) {
        const mx = Math.round(tx(t + (m * step) / 5)) + 0.5;
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(mx - 0.5, RULER_H - 5, 1, 4);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(px - 0.5, RULER_H - 9, 1, 8);
      ctx.fillStyle = THEME.rulerText; ctx.fillText(fmtTick(t, step), px + 5, 12);
    }
    const flag = (s, label, color) => {
      if (s === null) return;
      const px = Math.round(x(s));
      if (px < -20 || px > w + 20) return;
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(px - 9, RULER_H - 17, 18, 15, 4); ctx.fill();
      ctx.fillStyle = '#0a0b0f'; ctx.font = 'bold 10px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, px, RULER_H - 9); ctx.textAlign = 'left'; ctx.font = THEME.font;
    };
    flag(f.trigger, 'T', THEME.trigger); flag(f.markers.a, 'A', THEME.markerA); flag(f.markers.b, 'B', THEME.markerB);
  }

  function drawChannel(ctx, w, dpr, ch, color, y, h, f) {
    const wave = f.wave;
    if (!wave) return;
    const hi = y + 9, lo = y + h - 9, bit = 1 << ch;
    ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.lineJoin = 'miter';

    if (wave.kind === 'raw') {
      const { data, first } = wave;
      ctx.beginPath();
      let prevY = -1;
      for (let i = 0; i < data.length; i++) {
        const x0 = (first + i - f.view.start) / f.view.spp;
        const x1 = x0 + 1 / f.view.spp;
        const yy = data[i] & bit ? hi : lo;
        if (i === 0) ctx.moveTo(x0, yy); else if (yy !== prevY) ctx.lineTo(x0, yy);
        ctx.lineTo(x1, yy); prevY = yy;
      }
      ctx.stroke();
      ctx.fillStyle = hexA(color, 0.09);
      for (let i = 0; i < data.length; i++) {
        if (data[i] & bit) { const x0 = (first + i - f.view.start) / f.view.spp; ctx.fillRect(x0, hi, 1 / f.view.spp, lo - hi); }
      }
      return;
    }

    const { data } = wave;
    const cols = data.length / 2;
    const colW = 1 / dpr;
    const firstCol = Math.max(0, Math.floor((-f.view.start / f.view.spp) * dpr));
    const lastCol = Math.min(cols, Math.ceil(((f.samples - f.view.start) / f.view.spp) * dpr));
    if (lastCol <= firstCol) return;

    ctx.fillStyle = hexA(color, 0.09);
    let runStart = -1;
    for (let c = firstCol; c <= lastCol; c++) {
      const high = c < lastCol && (data[2 * c] & bit);
      if (high && runStart < 0) runStart = c;
      if (!high && runStart >= 0) { ctx.fillRect(runStart * colW, hi, (c - runStart) * colW, lo - hi); runStart = -1; }
    }

    ctx.beginPath();
    let prevY = data[2 * firstCol] & bit ? hi : lo;
    ctx.moveTo(firstCol * colW, prevY);
    const busy = [];
    for (let c = firstCol; c < lastCol; c++) {
      const yy = data[2 * c] & bit ? hi : lo;
      if (yy !== prevY) { ctx.lineTo(c * colW, prevY); ctx.lineTo(c * colW, yy); prevY = yy; }
      if (data[2 * c + 1] & bit) busy.push(c);
    }
    ctx.lineTo(lastCol * colW, prevY);
    ctx.stroke();
    if (busy.length) { ctx.fillStyle = color; for (const c of busy) ctx.fillRect(c * colW, hi, Math.max(colW, 1 / dpr), lo - hi); }
  }

  WS.draw = { drawFrame };
})(window.WS = window.WS || {});
