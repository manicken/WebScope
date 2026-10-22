/**
 * selections/selectionPanel.js — contents of the "Measurements" right-panel tab:
 * title, "+" button, and the list of selections (caret expands the stats).
 * Click a row = select it (opens the popup), double-click = zoom to it.
 */
(function (WS) {
  'use strict';
  const S = WS.selections;
  const { store } = WS;

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  let ui = null, lastKey = '';
  const expanded = new Set();

  function build(container) {
    container.innerHTML = '';
    const head = el('div', 'sel-panel-head');
    const title = el('span', 'sel-panel-title', 'Measurements');
    const add = el('button', 'sel-add', '+'); add.title = 'Add measurement';
    add.addEventListener('click', () => S.addAtCenter());
    head.append(title, add);
    const listEl = el('div', 'sel-list');
    container.append(head, listEl);
    ui = { container, add, listEl };
    lastKey = '';
  }

  function statsBlock(sel) {
    const st = store.get();
    const chans = S.channelsOf(sel);
    const box = el('div', 'sel-detail');
    const FIELDS = [['nRising', 'N<sub>rising</sub>'], ['nFalling', 'N<sub>falling</sub>'], ['fmin', 'f<sub>min</sub>'], ['fmax', 'f<sub>max</sub>'], ['fmean', 'f<sub>mean</sub>'], ['tstd', 'T<sub>std</sub>']];
    const targets = chans.length ? chans : [null];
    for (const ch of targets) {
      if (chans.length > 1) box.appendChild(el('div', 'sel-detail-ch', `CH${ch + 1} ${st.channels[ch]?.name ?? ''}`));
      const f = S.stats.formatted(sel, ch);
      const g = el('div', 'sel-detail-grid');
      for (const [k, l] of FIELDS) g.append(el('span', 'sel-k', l), el('span', 'sel-v mono', f[k]));
      box.appendChild(g);
    }
    if (sel.comment) { const c = el('div', 'sel-detail-comment'); c.textContent = sel.comment; box.appendChild(c); }
    return box;
  }

  function rebuildList() {
    const st = store.get();
    const sels = st.selections ?? [];
    ui.listEl.innerHTML = '';
    if (!sels.length) {
      ui.listEl.appendChild(el('div', 'hint sel-empty', 'Shift + drag in the waveform, or press + to add a measurement.'));
      return;
    }
    for (const sel of sels) {
      const open = expanded.has(sel.id);
      const item = el('div', 'sel-item' + (st.selectedSelection === sel.id ? ' on' : ''));
      const caret = el('button', 'sel-caret', open ? '▾' : '▸');
      const sw = el('span', 'sel-swatch'); sw.style.background = sel.color;
      const name = el('span', 'sel-name'); name.textContent = sel.name;
      const dt = el('span', 'sel-dt mono', 'Δ' + S.stats.formatted(sel, null).dt);
      const del = el('button', 'sel-del', '✕'); del.title = 'Delete';
      item.append(caret, sw, name, dt, del);

      caret.addEventListener('click', (e) => { e.stopPropagation(); open ? expanded.delete(sel.id) : expanded.add(sel.id); lastKey = ''; renderNow(); });
      del.addEventListener('click', (e) => { e.stopPropagation(); expanded.delete(sel.id); S.remove(sel.id); });
      item.addEventListener('click', () => S.select(sel.id));
      item.addEventListener('dblclick', () => WS.waveform.frameSpan(sel.start, sel.end));
      ui.listEl.appendChild(item);
      if (open) ui.listEl.appendChild(statsBlock(sel));
    }
  }

  let current = null;
  function renderNow() { if (current) render({container:current}); }

  function render({container, keys=null}={}) {
    if (keys && keys.includes('selections') == false && keys.includes('view') == false) return;
    //console.log('render selection panel');
    current = container;
    if (!ui || ui.container !== container) build(container);
    const st = store.get();
    const sels = st.selections ?? [];
    // the list is only rebuilt when something it shows has changed (render() runs on every store update)
    const key = JSON.stringify([sels, st.selectedSelection ?? null, [...expanded], st.status.samplerate, st.status.sampleCount, st.status.captureId, st.channels.map((c) => c.name)]);
    if (key !== lastKey) { lastKey = key; rebuildList(); }
    ui.add.disabled = !st.status.sampleCount;
  }

  S.panel = { render };
})(window.WS = window.WS || {});
