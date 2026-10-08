/**
 * decoderGui.js — the "Analyzers" section of the right panel: add buttons and one config card
 * per decoder instance. (The "Decoded data" table is annotations/annotationGui.js.)
 */
(function (WS) {
  'use strict';
  const { store } = WS;
  const { addNewDecoder, updateDecoder, toggleDecoderVisible, removeDecoder } = WS.decoders;

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
      { key: 'rowLayout', label: 'Group mode', type: 'select', options: [['grouped', 'Grouped'],['bySignal', 'By Signal']]},
      { key: 'csActiveLow', label: 'Enable active low', type: 'bool' },
      { key: 'cpol', label: 'CPOL', type: 'select', options: [[0, '0 · idle low'], [1, '1 · idle high']] },
      { key: 'cpha', label: 'CPHA', type: 'select', options: [[0, '0 · leading edge'], [1, '1 · trailing edge']] },
      { key: 'wordBits', label: 'Bits/word', type: 'number' },
      { key: 'msbFirst', label: 'MSB first', type: 'bool' },
      FORMAT_FIELD
    ]
  };

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  let addDecoderMenu = null;

  function init() {
    addDecoderMenu = new AddNewDecoderContextMenu({itemClickedCb: (item) => {addNewDecoder(item.class)}});
    console.log(WS.decoderregistry);
    addDecoderMenu.setItems(WS.decoderregistry);
  }
/* ============================== Analyzers ============================== */
  function renderAnalyzers(container) {
    //console.trace();
    container.innerHTML = '';
    const extra = el('div', 'add-row');

    const btn = el('button', '', '➕');
    btn.addEventListener('click', (e) => {
      const rect  = e.currentTarget.getBoundingClientRect();
      addDecoderMenu.toggleContextMenu(e, {x:rect.left, y:(rect.top+rect.height)});
    });
    extra.appendChild(btn);

    const sec = WS.ui.rightpanel.section('Analyzers', extra);
    const decoders = store.get().decoders;
    if (decoders.length === 0) sec.appendChild(el('div', 'hint', 'Add a protocol analyzer to decode UART, I²C or SPI traffic.'));
    const cards = el('div', 'cards');
    for (const d of decoders) cards.appendChild(analyzerCard(d));
    sec.appendChild(cards);
    container.appendChild(sec);
  }

  function analyzerCard(d) {
    //console.log(d);
    const channels = store.get().channels;
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    const toggleBtn = el('button', 'icon-btn', '▾');
    const body = el('div', 'card-body');
    let open = true;
    toggleBtn.addEventListener('click', () => { open = !open; toggleBtn.textContent = open ? '▾' : '▸'; body.style.display = open ? 'grid' : 'none'; });
    head.appendChild(toggleBtn);
    head.appendChild(el('span', 'dot', '')); head.lastChild.style.background = d.color;
    head.appendChild(el('span', 'card-title', d.name));
    head.appendChild(el('span', 'card-sub', d.summary(channels)));
    const eyeBtn = el('button', 'icon-btn', d.visible ? '👁' : '🚫');
    eyeBtn.title = d.visible ? 'Hide rows' : 'Show rows';
    eyeBtn.addEventListener('click', () => toggleDecoderVisible(d.id));
    head.appendChild(eyeBtn);
    const delBtn = el('button', 'icon-btn danger', '✕');
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', () => removeDecoder(d.id));
    head.appendChild(delBtn);
    card.appendChild(head);

    for (const [key, f] of Object.entries(d.getCfgGui())) {
      const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
      row.appendChild(el('span', null, f.label));
      const v = d.cfg[key];
      const update = (val) => updateDecoder(d.id, { [key]: val });
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

  WS.decoders = WS.decoders || {};
  WS.decoders.ui = WS.decoders.ui || {};
  Object.assign(WS.decoders.ui, { init, renderAnalyzers });

})(window.WS = window.WS || {});
