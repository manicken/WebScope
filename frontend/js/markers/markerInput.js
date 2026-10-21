/**
 * markers/markerInput.js — dragging markers + the comment tooltip.
 * Grab a flag on the ruler or the marker's line in the plot. Hovering a flag on the ruler shows the
 * marker's comment (if it has one). waveformGui calls down/move/up/hover/leave; down/move/up return
 * true when they consumed the event. Markers are created from the Markers panel.
 *   Esc  deselect      Delete  remove the selected marker
 */
(function (WS) {
  'use strict';
  const T = WS.timeMarkers;
  const { store } = WS;
  const { RULER_H } = WS.theme;
  const FLAG_PX = 9, LINE_PX = 4;

  /** getEnv() -> { view, hasData, sampleCount } */
  function init({ canvas, plotWrap, getEnv }) {
    let drag = null;

    const tip = document.createElement('div');
    tip.className = 'mk-tip'; tip.style.display = 'none';
    plotWrap.appendChild(tip);
    const hideTip = () => { tip.style.display = 'none'; };
    function showTip(tag, comment, px) {
      tip.innerHTML = '';
      const b = document.createElement('b'); b.textContent = tag;
      const c = document.createElement('div'); c.className = 'mk-tip-text'; c.textContent = comment;
      tip.append(b, c);
      tip.style.display = 'block';
      const left = Math.max(4, Math.min(plotWrap.clientWidth - tip.offsetWidth - 4, px + 12));
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = (RULER_H + 4) + 'px';
    }

    function hit(E, px, py) {
      const tol = py < RULER_H ? FLAG_PX : LINE_PX;
      const selected = store.get().selectedMarker ?? null;
      let best = null;
      for (const m of T.list()) {
        for (const p of T.positions(m)) {
          const d = Math.abs((p.s - E.view.start) / E.view.spp - px);
          if (d > tol) continue;
          if (!best || d < best.d - 0.01 || (Math.abs(d - best.d) <= 0.01 && m.id === selected)) best = { d, id: m.id, key: p.key, tag: p.tag };
        }
      }
      return best;
    }

    function down(e, px, py) {
      const E = getEnv();
      if (e.button !== 0 || !E.hasData) return false;
      const h = hit(E, px, py);
      if (!h) return false;
      hideTip();
      T.select(h.id);
      drag = { id: h.id, key: h.key };
      canvas.style.cursor = 'ew-resize';
      return true;
    }

    function move(px) {
      if (!drag) return false;
      const E = getEnv();
      const s = Math.max(0, Math.min(E.sampleCount, Math.round(E.view.start + px * E.view.spp)));
      T.update(drag.id, { [drag.key]: s });
      return true;
    }

    function up() {
      if (!drag) return false;
      drag = null; canvas.style.cursor = '';
      return true;
    }

    /** Sets the cursor only when over a marker, so call it AFTER the selection hover. */
    function hover(px, py) {
      if (drag) return;
      const E = getEnv();
      const h = E.hasData ? hit(E, px, py) : null;
      if (h) canvas.style.cursor = 'ew-resize';
      const m = h && py < RULER_H ? T.find(h.id) : null;
      if (m && m.comment) showTip(h.tag, m.comment, px); else hideTip();
    }

    window.addEventListener('keydown', (e) => {
      const t = e.target?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      const id = store.get().selectedMarker ?? null;
      if (id == null) return;
      if (e.key === 'Escape') T.select(null);
      else if (e.key === 'Delete') T.remove(id);
    });

    return { down, move, up, hover, leave: hideTip };
  }

  T.init = init;
})(window.WS = window.WS || {});
