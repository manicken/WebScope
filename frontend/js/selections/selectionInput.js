/**
 * selections/selectionInput.js — pointer interaction on the canvas.
 *
 *   Shift + drag in the plot   create a selection (starts on the row under the pointer;
 *                              drag up/down to extend it over more rows)
 *   drag left/right edge       resize in time
 *   drag top/bottom edge       change which rows are covered (multirow)
 *   drag body                  move in time, and up/down by whole rows
 *   click empty area / Esc     deselect (closes the popup)        Delete  remove selected
 *
 * waveformGui.js calls down/move/up/hover/clickEmpty from its own pointer handlers; each returns
 * true when it consumed the event, so pan/markers keep working untouched.
 */
(function (WS) {
  'use strict';
  const S = WS.selections;
  const { store } = WS;
  const { RULER_H } = WS.theme;
  const EDGE = 5, MIN_DRAG = 3;
  const CURSOR = { left: 'ew-resize', right: 'ew-resize', top: 'ns-resize', bottom: 'ns-resize', body: 'move', create: 'crosshair' };

  /** getEnv() -> { rows, scrollY, view, w, h, hasData, sampleCount } */
  function init({ canvas, plotWrap, getEnv }) {
    S.popup.init(plotWrap);
    let drag = null;

    const X = (E, s) => (s - E.view.start) / E.view.spp;
    const sampleAt = (E, px) => Math.max(0, Math.min(E.sampleCount, Math.round(E.view.start + px * E.view.spp)));
    const contentY = (E, py) => py - RULER_H + E.scrollY;
    function rowIdxAt(E, py, clamp) {
      const cy = contentY(E, py), rows = E.rows;
      let i = rows.findIndex((r) => cy >= r.y && cy < r.y + r.h);
      if (i < 0 && clamp && rows.length) i = cy < rows[0].y ? 0 : rows.length - 1;
      return i;
    }

    function hit(E, px, py) {
      const cy = contentY(E, py);
      const selected = store.get().selectedSelection ?? null;
      const order = [...S.list()].reverse().sort((a, b) => (b.id === selected) - (a.id === selected));
      for (const s of order) {
        const rs = S.runs(s, E.rows);
        if (!rs.length) continue;
        const x0 = X(E, s.start), x1 = X(E, s.end);
        const top = rs[0].y0, bot = rs[rs.length - 1].y1;
        const inX = px >= x0 && px <= x1;
        const inY = rs.some((r) => cy >= r.y0 && cy <= r.y1);
        const dl = Math.abs(px - x0), dr = Math.abs(px - x1);
        if (inY && Math.min(dl, dr) <= EDGE) return { sel: s, part: dl <= dr ? 'left' : 'right' };
        if (inX && Math.abs(cy - top) <= EDGE) return { sel: s, part: 'top' };
        if (inX && Math.abs(cy - bot) <= EDGE) return { sel: s, part: 'bottom' };
        if (inX && inY) return { sel: s, part: 'body' };
      }
      return null;
    }

    function down(e, px, py) {
      if (e.button !== 0) return;
      const E = getEnv();
      if (!E.hasData) return false;
      if (e.shiftKey) {
        const i = rowIdxAt(E, py, false);
        if (i < 0) return false;
        drag = { mode: 'create', x0: px, anchor: sampleAt(E, px), row0: i, id: null, moved: false };
        canvas.style.cursor = CURSOR.create;
        return true;
      }
      const h = hit(E, px, py);
      if (!h) return false;
      S.select(h.sel.id);
      const keys = new Set(h.sel.rows);
      const origIdx = [];
      E.rows.forEach((r, i) => { if (keys.has(S.rowKey(r))) origIdx.push(i); });
      drag = { mode: h.part, id: h.sel.id, x0: px, startSample: sampleAt(E, px), startRow: rowIdxAt(E, py, true), origIdx, orig: { start: h.sel.start, end: h.sel.end }, ir: S.indexRange(h.sel, E.rows), moved: false };
      canvas.style.cursor = CURSOR[h.part];
      return true;
    }

    function move(px, py) {
      if (!drag) return false;
      const E = getEnv();
      const s = sampleAt(E, px);
      if (Math.abs(px - drag.x0) > MIN_DRAG) drag.moved = true;
      switch (drag.mode) {
        case 'create': {
          if (!drag.id) {
            if (!drag.moved) return true;
            drag.id = S.create({ start: drag.anchor, end: drag.anchor, rows: [S.rowKey(E.rows[drag.row0])] }).id;
          }
          const i = rowIdxAt(E, py, true);
          S.update(drag.id, { start: Math.min(drag.anchor, s), end: Math.max(drag.anchor, s), rows: S.keysBetween(E.rows, drag.row0, i) });
          break;
        }
        case 'left':  S.update(drag.id, { start: Math.min(s, drag.orig.end),   end: Math.max(s, drag.orig.end) }); break;
        case 'right': S.update(drag.id, { start: Math.min(s, drag.orig.start), end: Math.max(s, drag.orig.start) }); break;
        case 'body': {
          // horizontal: move in time. vertical: move the whole selection up/down by whole rows
          const d = Math.max(-drag.orig.start, Math.min(E.sampleCount - drag.orig.end, s - drag.startSample));
          const patch = { start: drag.orig.start + d, end: drag.orig.end + d };
          if (drag.origIdx.length && E.rows.length) {
            const lo = drag.origIdx[0], hi = drag.origIdx[drag.origIdx.length - 1];
            const di = Math.max(-lo, Math.min(E.rows.length - 1 - hi, rowIdxAt(E, py, true) - drag.startRow));
            const rows = drag.origIdx.map((i) => E.rows[i + di]).filter(Boolean).map(S.rowKey);
            if (rows.length === drag.origIdx.length) patch.rows = rows;
          }
          S.update(drag.id, patch);
          break;
        }
        case 'top': case 'bottom': {
          if (!drag.ir) break;
          const fixed = drag.mode === 'top' ? drag.ir.hi : drag.ir.lo;
          const i = rowIdxAt(E, py, true);
          if (i >= 0) S.update(drag.id, { rows: S.keysBetween(E.rows, fixed, i) });
          break;
        }
      }
      return true;
    }

    function up() {
      if (!drag) return false;
      const d = drag; drag = null;
      if (d.id) {
        const s = S.find(d.id);
        if (s && d.mode === 'create' && s.end - s.start < 1) S.remove(d.id); else S.select(d.id);
      }
      canvas.style.cursor = '';
      return true;
    }

    function hover(px, py) {
      if (drag) return;
      const E = getEnv();
      const h = E.hasData && py >= RULER_H ? hit(E, px, py) : null;
      canvas.style.cursor = h ? CURSOR[h.part] : '';
    }

    window.addEventListener('keydown', (e) => {
      const t = e.target?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      const id = store.get().selectedSelection ?? null;
      if (id == null) return;
      if (e.key === 'Escape') S.select(null);
      else if (e.key === 'Delete') S.remove(id);
    });

    return {
      down, move, up, hover,
      clickEmpty: () => S.select(null),
      updatePopup: () => S.popup.update(getEnv()),
    };
  }

  S.init = init;
})(window.WS = window.WS || {});
