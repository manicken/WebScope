/**
 * ui/rightpanel.js — Analyzers / Timing / Decoded data, ported from
 * edgewise's src/renderer/src/components/RightPanel.tsx.
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;
  const { fmtTime, fmtFreq } = WS.format;
  const { engine } = WS;
  const A = WS.actions;

  const ROW_H = 26;

  const FORMAT_FIELD = { key: 'format', label: 'Display', type: 'select', options: [['hex', 'Hex'], ['dec', 'Decimal'], ['bin', 'Binary'], ['ascii', 'ASCII']] };
  const FIELDS = {
    uart: [
      { key: 'channel', label: 'Channel', type: 'channel' },
      { key: 'baud', label: 'Baud', type: 'number' },
      { key: 'dataBits', label: 'Data bits', type: 'select', options: [5, 6, 7, 8, 9].map((n) => [n, String(n)]) },
      { key: 'parity', label: 'Parity', type: 'select', options: [['none', 'None'], ['even', 'Even'], ['odd', 'Odd']] },
      { key: 'stopBits', label: 'Stop bits', type: 'select', options: [[1, '1'], [2, '2']] },
      { key: 'msbFirst', label: 'MSB first', type: 'bool' },
      { key: 'invert', label: 'Inverted', type: 'bool' },
      FORMAT_FIELD
    ],
    i2c: [
      { key: 'scl', label: 'SCL', type: 'channel' },
      { key: 'sda', label: 'SDA', type: 'channel' },
      FORMAT_FIELD
    ],
    spi: [
      { key: 'clk', label: 'Clock', type: 'channel' },
      { key: 'mosi', label: 'MOSI', type: 'channel?' },
      { key: 'miso', label: 'MISO', type: 'channel?' },
      { key: 'cs', label: 'Enable', type: 'channel?' },
      { key: 'csActiveLow', label: 'Enable active low', type: 'bool' },
      { key: 'cpol', label: 'CPOL', type: 'select', options: [[0, '0 · idle low'], [1, '1 · idle high']] },
      { key: 'cpha', label: 'CPHA', type: 'select', options: [[0, '0 · leading edge'], [1, '1 · trailing edge']] },
      { key: 'wordBits', label: 'Bits/word', type: 'number' },
      { key: 'msbFirst', label: 'MSB first', type: 'bool' },
      FORMAT_FIELD
    ]
  };

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  function section(title, extraEl, grow) {
    const s = el('section', 'section' + (grow ? ' grow' : ''));
    const head = el('div', 'section-head', `<span>${title}</span>`);
    if (extraEl) head.appendChild(extraEl);
    s.appendChild(head);
    return s;
  }

  /* ============================== Analyzers ============================== */
  function renderAnalyzers(container) {
    container.innerHTML = '';
    const extra = el('div', 'add-row');
    for (const kind of ['uart', 'i2c', 'spi']) {
      const btn = el('button', 'pill', `+ ${WS.decoderNames[kind]}`);
      btn.addEventListener('click', () => A.addDecoder(kind));
      extra.appendChild(btn);
    }
    const sec = section('Analyzers', extra);
    const decoders = get().decoders;
    if (decoders.length === 0) sec.appendChild(el('div', 'hint', 'Add a protocol analyzer to decode UART, I²C or SPI traffic.'));
    const cards = el('div', 'cards');
    for (const d of decoders) cards.appendChild(analyzerCard(d));
    sec.appendChild(cards);
    container.appendChild(sec);
  }

  function analyzerCard(d) {
    const channels = get().channels;
    const name = (i) => typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : '—';
    const c = d.config;
    const summary = c.kind === 'uart' ? `${name(c.channel)} · ${c.baud} baud`
      : c.kind === 'i2c' ? `${name(c.scl)} / ${name(c.sda)}`
      : `CLK ${name(c.clk)} · mode ${Number(c.cpol) * 2 + Number(c.cpha)}`;

    const card = el('div', 'card');
    const head = el('div', 'card-head');
    const toggleBtn = el('button', 'icon-btn', '▾');
    const body = el('div', 'card-body');
    let open = true;
    toggleBtn.addEventListener('click', () => { open = !open; toggleBtn.textContent = open ? '▾' : '▸'; body.style.display = open ? 'grid' : 'none'; });
    head.appendChild(toggleBtn);
    head.appendChild(el('span', 'dot', '')); head.lastChild.style.background = d.color;
    head.appendChild(el('span', 'card-title', d.name));
    head.appendChild(el('span', 'card-sub', summary));
    const eyeBtn = el('button', 'icon-btn', d.visible ? '👁' : '🚫');
    eyeBtn.title = d.visible ? 'Hide rows' : 'Show rows';
    eyeBtn.addEventListener('click', () => A.toggleDecoderVisible(d.id));
    head.appendChild(eyeBtn);
    const delBtn = el('button', 'icon-btn danger', '✕');
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', () => A.removeDecoder(d.id));
    head.appendChild(delBtn);
    card.appendChild(head);

    for (const f of FIELDS[d.config.kind]) {
      const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
      row.appendChild(el('span', null, f.label));
      const v = d.config[f.key];
      const update = (val) => A.updateDecoder(d.id, { [f.key]: val });
      let input;
      if (f.type === 'channel' || f.type === 'channel?') {
        input = document.createElement('select');
        if (f.type === 'channel?') input.appendChild(new Option('None', ''));
        for (const ch of channels) input.appendChild(new Option(ch.name, String(ch.index)));
        input.value = v === null || v === undefined ? '' : String(v);
        input.addEventListener('change', () => update(input.value === '' ? null : Number(input.value)));
      } else if (f.type === 'select') {
        input = document.createElement('select');
        for (const [k, label] of f.options) input.appendChild(new Option(label, String(k)));
        input.value = String(v);
        input.addEventListener('change', () => { const opt = f.options.find(([k]) => String(k) === input.value); update(opt[0]); });
      } else if (f.type === 'bool') {
        input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(v);
        input.addEventListener('change', () => update(input.checked));
      } else {
        input = document.createElement('input'); input.className = 'mono'; input.value = String(v);
        const commit = () => { const n = Number(input.value); if (isFinite(n) && n > 0 && n !== v) update(n); else input.value = String(v); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      }
      row.appendChild(input);
      body.appendChild(row);
    }
    card.appendChild(body);
    return card;
  }

  /* ============================== Timing ============================== */
  function renderMeasurements(container) {
    container.innerHTML = '';
    const { markers, status, hover } = get();
    const origin = status.trigger ?? 0;
    const t = (s) => fmtTime((s - origin) / status.samplerate, 6);
    const dt = markers.a !== null && markers.b !== null ? Math.abs(markers.b - markers.a) / status.samplerate : null;

    let extra = null;
    if (markers.a !== null || markers.b !== null) {
      extra = el('button', 'link', 'Clear');
      extra.addEventListener('click', () => set({ markers: { a: null, b: null } }));
    }
    const sec = section('Timing', extra);
    const metrics = el('div', 'metrics');
    const metric = (label, value, color, strong) => {
      const m = el('div', 'metric' + (strong ? ' strong' : ''));
      const l = el('span', 'metric-label', label); if (color) l.style.color = color;
      m.appendChild(l);
      m.appendChild(el('span', 'metric-value mono', value));
      return m;
    };
    metrics.appendChild(metric('Cursor', hover ? t(hover.sample) : '—'));
    metrics.appendChild(metric('A', markers.a !== null ? t(markers.a) : '—', 'var(--marker-a)'));
    metrics.appendChild(metric('B', markers.b !== null ? t(markers.b) : '—', 'var(--marker-b)'));
    metrics.appendChild(metric('Δ A→B', dt !== null ? fmtTime(dt, 6) : '—', null, true));
    metrics.appendChild(metric('1 / Δ', dt ? fmtFreq(1 / dt) : '—'));
    sec.appendChild(metrics);
    if (markers.a === null) sec.appendChild(el('div', 'hint', 'Click the time ruler to drop markers A and B. Drag to move, double-click to clear.'));
    container.appendChild(sec);
  }

  /* ============================== Decoded data table ============================== */
  function renderDataTable(container) {
    container.innerHTML = '';
    const { decoders, table, status } = get();
    const dec = decoders.find((d) => d.id === table.decoder) ?? decoders[0];

    let extra = null;
    if (dec) {
      extra = el('div', 'tabs');
      if (decoders.length > 1) {
        const sel = document.createElement('select');
        for (const d of decoders) sel.appendChild(new Option(d.name, String(d.id)));
        sel.value = String(dec.id);
        sel.addEventListener('change', () => set({ table: { decoder: Number(sel.value), row: 0, focus: null } }));
        extra.appendChild(sel);
      }
      dec.rows.forEach((r, i) => {
        const tab = el('button', 'tab' + (i === table.row ? ' on' : ''), r);
        tab.addEventListener('click', () => set({ table: { decoder: dec.id, row: i, focus: null } }));
        extra.appendChild(tab);
      });
    }
    const sec = section('Decoded data', extra, true);

    if (!dec) {
      sec.appendChild(el('div', 'hint', 'Decoded frames appear here.'));
      container.appendChild(sec);
      return;
    }

    const page = engine.annotationPage(dec.id, table.row, 0, 1); // just for total, cheap
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
      const total = engine.annotationPage(dec.id, table.row, 0, 0).total;
      spacer.style.height = (total * ROW_H) + 'px';
      const scrollTop = tableEl.scrollTop, height = tableEl.clientHeight || 300;
      const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
      const count = Math.ceil(height / ROW_H) + 20;
      const p = engine.annotationPage(dec.id, table.row, first, count);
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
            set({ table: { ...get().table, decoder: dec.id, focus: idx } });
            A.centerOn((a.start + a.end) / 2, a.end - a.start);
          });
          spacer.appendChild(node);
          rowsById.set(idx, node);
        }
        node.children[1].textContent = fmtTime((a.start - origin) / status.samplerate, 6);
        node.children[2].textContent = a.text;
        node.className = 'table-row' + (idx === table.focus ? ' focus' : '') + ` cls-${a.class}`;
      });
      for (const [idx, node] of rowsById) if (!keep.has(idx)) { node.remove(); rowsById.delete(idx); }
    }

    tableEl.addEventListener('scroll', renderVisible);
    new ResizeObserver(renderVisible).observe(tableEl);
    renderVisible();

    if (table.focus !== null) {
      const y = table.focus * ROW_H;
      if (y < tableEl.scrollTop || y > tableEl.scrollTop + tableEl.clientHeight - ROW_H) tableEl.scrollTop = y - tableEl.clientHeight / 2;
    }
  }

  /* ============================== boot ============================== */
  function init(rightPanelEl) {
    const analyzers = el('div'); const measurements = el('div'); const dataTable = el('div');
    dataTable.style.display = 'flex'; dataTable.style.flex = '1'; dataTable.style.minHeight = '0'; dataTable.style.flexDirection = 'column';
    rightPanelEl.appendChild(analyzers); rightPanelEl.appendChild(measurements); rightPanelEl.appendChild(dataTable);

    function renderAll() {
      renderAnalyzers(analyzers);
      renderMeasurements(measurements);
      renderDataTable(dataTable);
    }
    WS.store.store.subscribe(renderAll);
    renderAll();
  }

  WS.ui = WS.ui || {};
  WS.ui.rightpanel = { init };
})(window.WS = window.WS || {});
