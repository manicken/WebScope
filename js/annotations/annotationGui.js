/**
 * annotationGui.js — how annotations are shown: boxes on the waveform canvas (drawAnnotations)
 * and the "Decoded data" table in the right panel (renderDataTable).
 */
(function (WS) {
  'use strict';
  const { THEME, ANN, CLASS_COLORS, hexA } = WS.theme;
  const { store } = WS;
  const { fmtTime } = WS.format;
  const { annotationPage } = WS.annotations;
  const ROW_H = 26;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  /* ============================== Waveform boxes ============================== */
  const fitCache = new Map();
  function fitText(ctx, s, max) {
    let wd = fitCache.get(s);
    if (wd === undefined) { wd = ctx.measureText(s).width; if (fitCache.size > 5000) fitCache.clear(); fitCache.set(s, wd); }
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
      const c = CLASS_COLORS[a.class] ?? color;
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

  /* ============================== Decoded data table ============================== */
  function renderDataTable(container) {
    container.innerHTML = '';
    const { decoders, table, status } = store.get();
    //console.log(table);
    const dec = decoders.find((d) => d.id === table.decoder) ?? decoders[0];

    let extra = null;
    if (dec) {
      extra = el('div', 'tabs');
      if (decoders.length > 1) {
        const sel = document.createElement('select');
        for (const d of decoders) sel.appendChild(new Option(d.name, String(d.id)));
        sel.value = String(dec.id);
        sel.addEventListener('change', () => store.set({ table: { decoder: Number(sel.value), rowId: r.id, focus: null } }));
        extra.appendChild(sel);
      }
      dec.rows.forEach((r, i) => {
        const tab = el('button', 'tab' + (i === table.row ? ' on' : ''), r);
        console.log(r);
        tab.addEventListener('click', () => store.set({ table: { decoder: dec.id, rowId: r.id, focus: null } }));
        extra.appendChild(tab);
      });
    }
    const sec = WS.ui.rightpanel.section('Decoded data', extra, true);

    if (!dec) {
      sec.appendChild(el('div', 'hint', 'Decoded frames appear here.'));
      container.appendChild(sec);
      return;
    }
    console.log(table);
    const page = annotationPage(dec.id, table.rowId, 0, 1); // just for total, cheap
    const head = el('div', 'table-head', `<span>#</span><span>Time</span><span>Value</span><span class="muted">${page.total.toLocaleString()} rows</span>`);
    sec.appendChild(head);

    const tableEl = el('div', 'table');
    const spacer = el('div', null); spacer.style.position = 'relative';
    tableEl.appendChild(spacer);
    sec.appendChild(tableEl);
    container.appendChild(sec);

    const origin = status.trigger ?? 0;
    let rowsById = new Map();

    function renderVisible() {
      const total = annotationPage(dec.id, table.row, 0, 0).total;
      spacer.style.height = (total * ROW_H) + 'px';
      const scrollTop = tableEl.scrollTop, height = tableEl.clientHeight || 300;
      const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
      const count = Math.ceil(height / ROW_H) + 20;
      const p = annotationPage(dec.id, table.row, first, count);
      // Diff against what's currently rendered rather than rebuilding every scroll tick.
      const keep = new Set();
      p.items.forEach((a, i) => {
        const idx = p.offset + i;
        keep.add(idx);
        let node = rowsById.get(idx);
        if (!node) {
          node = el('div', 'table-row', `<span class="muted mono">${idx + 1}</span><span class="mono"></span><span class="mono value"></span>`);
          node.style.top = (idx * ROW_H) + 'px';
          node.style.height = ROW_H + 'px';
          node.addEventListener('click', () => {
            store.set({ table: { ...store.get().table, decoder: dec.id, focus: idx } });
            WS.actions.centerOn((a.start + a.end) / 2, a.end - a.start);
          });
          spacer.appendChild(node);
          rowsById.set(idx, node);
        }
        node.children[1].textContent = fmtTime((a.start - origin) / status.samplerate, 6);
        node.children[2].textContent = a.text;
        node.className = 'table-row' + (idx === table.focus ? ' focus' : '') + ` cls-${a.class}`;
      });
      for (const [idx, node] of rowsById) { 
        if (!keep.has(idx)) {
          node.remove();
          rowsById.delete(idx);
        }
      }
    }

    tableEl.addEventListener('scroll', renderVisible);
    new ResizeObserver(renderVisible).observe(tableEl);
    renderVisible();

    if (table.focus !== null) {
      const y = table.focus * ROW_H;
      if (y < tableEl.scrollTop || y > tableEl.scrollTop + tableEl.clientHeight - ROW_H) tableEl.scrollTop = y - tableEl.clientHeight / 2;
    }
  }

  WS.annotations = Object.assign(WS.annotations || {}, { drawAnnotations, renderDataTable });
})(window.WS = window.WS || {});
