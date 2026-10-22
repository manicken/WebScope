/**
 * dataTable.js — the "Decoded data" panel: a virtualized table of the selected decoder's annotations.
 */
(function (WS) {
  'use strict';
  const { store } = WS;
  const { fmtTime } = WS.format;

  //const ROW_H = 26;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  let ui = null;

  const ROW_H = 38;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showFull(a, idx) {
  const message =
    `<div class="mono" style="max-height:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text">${esc(a.text)}</div>`;
  InfoDialog.Show({ title: `Row ${idx + 1}`, message, states: { width: 500, height: 300 }, backdrop:false });
  console.log(AppWindows.GetWindows());
}

/** Page of raw (unmerged) annotations for the data table: { total, offset, items }. */
    function annotationPage(decId, rowId, offset, limit) {
        const allAtRow = WS.decoders.decodedResult(decId)?.[rowId] ?? [];
        return { total: allAtRow.length, offset, items: allAtRow.slice(offset, offset + limit) };
    }

  function build() {
    // plain panel section, no minimize card; 'grow' lets the table fill the panel height
    const root = el('section', 'section grow');
    const sectionHead = el('div', 'section-head');
    const tabs = el('div', 'tabs');
    sectionHead.append(el('span', null, 'Decoded data'), tabs);

    const hint = el('div', 'hint', 'Decoded frames appear here.');
    const head = el('div', 'table-head');
    const tableEl = el('div', 'table');
    const spacer = el('div'); spacer.style.position = 'relative';
    tableEl.appendChild(spacer);

    root.append(sectionHead, hint, head, tableEl);
    ui = { root, tabs, hint, head, tableEl, spacer, rowsById: new Map(), shownKey: null, lastFocus: null };

    // listeners are added once; renderVisible always reads the current store state
    tableEl.addEventListener('scroll', renderVisible);
    new ResizeObserver(renderVisible).observe(tableEl);
  }

  function currentDecoder() {
    const { decoders, table } = store.get();
    return decoders.find((d) => d.id === table.decoder) ?? decoders[0] ?? null;
  }

  function renderVisible() {
    if (!ui) return;
    const dec = currentDecoder();
    if (!dec) return;
    const { table, status } = store.get();
    const origin = status.trigger ?? 0;
    const { tableEl, spacer, rowsById } = ui;

    const total = annotationPage(dec.id, table.rowId, 0, 0).total;
    spacer.style.height = (total * ROW_H) + 'px';
    const scrollTop = tableEl.scrollTop, height = tableEl.clientHeight || 300;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
    const count = Math.ceil(height / ROW_H) + 20;
    const p = annotationPage(dec.id, table.rowId, first, count);

    const keep = new Set();
    p.items.forEach((a, i) => {
      const idx = p.offset + i;
      keep.add(idx);
      let node = rowsById.get(idx);
      if (!node) {
        /*node = el('div', 'table-row', `<span class="muted mono">${idx + 1}</span><span class="mono"></span><span class="mono value"></span>`);
        node.style.top = (idx * ROW_H) + 'px';
        node.style.height = ROW_H + 'px';*/
        node = el('div', 'table-row',
            `<span class="muted mono">${idx + 1}</span><span class="mono"></span><span class="mono value"></span><button class="icon-btn row-more" title="Show full value">⤢</button>`);
        node.style.top = (idx * ROW_H) + 'px';
        node.style.height = ROW_H + 'px';
        node.addEventListener('click', () => { /* oförändrat */ });
        node.children[3].addEventListener('click', (e) => {
        e.stopPropagation();            // don't also focus/center the row
        showFull(node._ann, idx);
        });

        node.addEventListener('click', () => {
          const an = node._ann; // always the latest annotation for this row
          store.set({ table: { ...store.get().table, decoder: currentDecoder().id, focus: idx } });
          WS.waveform.centerOn((an.start + an.end) / 2, an.end - an.start);
        });
        spacer.appendChild(node);
        rowsById.set(idx, node);
      }
      node._ann = a;
      node.children[1].textContent = fmtTime((a.start - origin) / status.samplerate, 6);
      node.children[2].textContent = a.text;
      node.className = 'table-row' + (idx === table.focus ? ' focus' : '') + ` cls-${a.class}`;
    });
    for (const [idx, node] of rowsById) {
      if (!keep.has(idx)) { node.remove(); rowsById.delete(idx); }
    }
  }

  function renderDataTable({container}) {
    if (!ui) build();
    const { decoders, table } = store.get();
    const dec = currentDecoder();

    if (ui.root.parentNode !== container) {
      container.innerHTML = '';
      container.appendChild(ui.root);
    }

    // header extras (decoder select + row tabs): cheap to rebuild, they hold no state
    ui.tabs.innerHTML = '';
    ui.hint.style.display = dec ? 'none' : '';
    ui.head.style.display = dec ? '' : 'none';
    ui.tableEl.style.display = dec ? '' : 'none';
    if (!dec) return;

    if (decoders.length > 1) {
      const sel = document.createElement('select');
      for (const d of decoders) sel.appendChild(new Option(d.name, String(d.id)));
      sel.value = String(dec.id);
      sel.addEventListener('change', () => store.set({ table: { decoder: Number(sel.value), focus: null } }));
      ui.tabs.appendChild(sel);
    }
    const rows = dec.rows();
    const keys = Object.keys(rows);
    const activeKey = table.rowId ?? keys[0];
    for (const key of keys) {
      const tab = el('button', 'tab' + (key === activeKey ? ' on' : ''), rows[key].label);
      tab.addEventListener('click', () => store.set({ table: { decoder: dec.id, rowId: key, focus: null } }));
      ui.tabs.appendChild(tab);
    }

    // another decoder / row selected -> drop the virtual rows and start from the top
    const key = dec.id + ':' + activeKey;
    if (key !== ui.shownKey) {
      ui.shownKey = key;
      for (const node of ui.rowsById.values()) node.remove();
      ui.rowsById.clear();
      ui.tableEl.scrollTop = 0;
    }

    const page = annotationPage(dec.id, table.rowId, 0, 1);
    ui.head.innerHTML = `<span>#</span><span>Time</span><span>Value</span><span class="muted">${page.total.toLocaleString()} rows</span>`;

    renderVisible();

    if (table.focus !== null && table.focus !== ui.lastFocus) {
      const y = table.focus * ROW_H;
      const { tableEl } = ui;
      if (y < tableEl.scrollTop || y > tableEl.scrollTop + tableEl.clientHeight - ROW_H) tableEl.scrollTop = y - tableEl.clientHeight / 2;
    }
    ui.lastFocus = table.focus;
  }

  WS.dataTable = Object.assign(WS.dataTable ?? {}, { renderDataTable });
})(window.WS = window.WS || {});