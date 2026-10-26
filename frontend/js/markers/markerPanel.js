/**
 * markers/markerPanel.js — the "Markers" right-panel tab: title, "+" with a small menu
 * (Add Marker Pair / Add Single Marker) and the list of markers.
 *   click row        select the marker            ⌖ button   bring it into view
 *   double-click     edit box: name, comment, color (applied live; Enter / Esc / click outside closes)
 *   caret            expand details               ✕          delete
 * Times are relative to the trigger. The comment is shown when hovering the marker's flag on the ruler.
 */
(function (WS) {
  'use strict';
  const T = WS.timeMarkers;
  const { appState } = WS;
  const { fmtTime, fmtFreq } = WS.format;

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  let ui = null, current = null;
  const expanded = new Set();

  /* ---------------- edit box (double-click a row) ---------------- */
  let ed = null; // { root, nameIn, tags, ta, swatches, id }

  function buildEditor() {
    const root = el('div', 'popover mk-edit'); root.hidden = true;
    const nameIn = el('input', 'mk-edit-name'); nameIn.type = 'text'; nameIn.maxLength = 32; nameIn.spellcheck = false; nameIn.placeholder = 'Name';
    const tags = el('div', 'hint');
    const ta = el('textarea', 'mk-edit-comment'); ta.rows = 3; ta.placeholder = 'Comment (shown when hovering the marker flag)';
    const sw = el('div', 'mk-edit-colors');
    const swatches = T.COLORS.map((c) => {
      const b = el('button', 'sel-swatch-btn'); b.style.background = c; b.dataset.color = c; b.title = c;
      b.addEventListener('click', () => { if (ed.id) T.update(ed.id, { color: c }); });
      sw.appendChild(b); return b;
    });
    root.append(nameIn, tags, ta, sw);
    document.body.appendChild(root);
    ed = { root, nameIn, tags, ta, swatches, id: null };

    nameIn.addEventListener('input', () => { const v = nameIn.value.trim(); if (ed.id && v) T.update(ed.id, { name: v }); });
    nameIn.addEventListener('blur', () => { const m = T.find(ed.id); if (m && !nameIn.value.trim()) nameIn.value = m.name; });
    ta.addEventListener('input', () => { if (ed.id) T.update(ed.id, { comment: ta.value }); });
    // keep typing away from the global shortcuts
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.target === nameIn)) closeEditor();
    });
    document.addEventListener('pointerdown', (e) => { if (!root.hidden && !root.contains(e.target)) closeEditor(); });
  }

  function closeEditor() { if (ed) { ed.root.hidden = true; ed.id = null; } }

  function syncEditor() {
    if (!ed || ed.root.hidden) return;
    const m = T.find(ed.id);
    if (!m) return closeEditor();
    ed.tags.textContent = m.kind === 'pair' ? `Pair: ${m.name}1 / ${m.name}2` : 'Single marker';
    for (const b of ed.swatches) b.classList.toggle('on', b.dataset.color === m.color);
  }

  function openEditor(id, anchor) {
    const m = T.find(id);
    if (!m) return;
    if (!ed) buildEditor();
    ed.id = id;
    ed.nameIn.value = m.name; ed.ta.value = m.comment ?? '';
    ed.root.hidden = false;
    syncEditor();
    const r = anchor.getBoundingClientRect(), w = ed.root.offsetWidth, h = ed.root.offsetHeight;
    ed.root.style.left = Math.max(8, r.left - w - 8) + 'px';                                  // to the left of the panel
    ed.root.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 8)) + 'px';
    ed.nameIn.focus(); ed.nameIn.select();
  }

  /* ---------------- panel ---------------- */
  function build(container) {
    container.innerHTML = '';
    const head = el('div', 'sel-panel-head mk-head');
    const title = el('span', 'sel-panel-title', 'Markers');
    const add = el('button', 'sel-add', '+'); add.title = 'Add marker';
    const menu = el('div', 'mk-menu'); menu.hidden = true;
    const item = (label, kind) => {
      const b = el('button', 'mk-menu-item'); b.textContent = label;
      b.addEventListener('click', () => { menu.hidden = true; T.add(kind); });
      menu.appendChild(b);
    };
    item('Add Marker Pair', 'pair');
    item('Add Single Marker', 'single');
    add.addEventListener('click', () => { menu.hidden = !menu.hidden; });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== add) menu.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });
    head.append(title, add, menu);

    const listEl = el('div', 'sel-list');
    // delegated, because rows are rebuilt whenever the markers change (the first click of a double-click selects)
    listEl.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.sel-item');
      if (row && !e.target.closest('button')) openEditor(row.dataset.id, row);
    });
    container.append(head, listEl);
    ui = { container, add, menu, listEl };
  }

  function details(m, origin, sr) {
    const t = (s) => fmtTime((s - origin) / sr, 6);
    const box = el('div', 'sel-detail');
    const g = el('div', 'sel-detail-grid');
    const row = (k, v) => g.append(el('span', 'sel-k', k), el('span', 'sel-v mono', v));
    if (m.kind === 'pair') {
      const dt = Math.abs(m.b - m.a) / sr;
      row(m.name + '1', t(m.a)); row(m.name + '2', t(m.b));
      row('Δ', fmtTime(dt, 6)); row('1 / Δ', dt ? fmtFreq(1 / dt) : '—');
    } else row('Position', t(m.at));
    box.appendChild(g);
    if (m.comment) { const c = el('div', 'sel-detail-comment'); c.textContent = m.comment; box.appendChild(c); }
    return box;
  }

  function rebuildList() {
    const markers = T.list();
    const selected = T.selected();
    const buf = WS.capture.getBuffer();
    const sr = buf?.samplerate ?? 1, origin = buf?.timeOrigin ?? 0;
    ui.listEl.innerHTML = '';
    if (!markers.length) {
      ui.listEl.appendChild(el('div', 'hint sel-empty', 'Press + to add a marker pair or a single marker. Drag the flags on the ruler to move them. Double-click a row to rename it or add a comment.'));
      return;
    }
    for (const m of markers) {
      const open = expanded.has(m.id);
      const item = el('div', 'sel-item' + (selected === m.id ? ' on' : ''));
      item.dataset.id = m.id; item.title = 'Double-click to edit';
      const caret = el('button', 'sel-caret', open ? '▾' : '▸');
      const sw = el('span', 'sel-swatch'); sw.style.background = m.color;
      const name = el('span', 'sel-name'); name.textContent = m.kind === 'pair' ? `${m.name}1 → ${m.name}2` : m.name;
      const val = el('span', 'sel-dt mono');
      val.textContent = m.kind === 'pair' ? 'Δ' + fmtTime(Math.abs(m.b - m.a) / sr, 6) : fmtTime((m.at - origin) / sr, 6);
      const go = el('button', 'sel-del mk-goto', '⌖'); go.title = 'Bring into view';
      const del = el('button', 'sel-del', '✕'); del.title = 'Delete';
      item.append(caret, sw, name, val, go, del);

      caret.addEventListener('click', (e) => { e.stopPropagation(); open ? expanded.delete(m.id) : expanded.add(m.id); if (current) render({ container: current }); });
      go.addEventListener('click', (e) => { e.stopPropagation(); T.goTo(m); });
      del.addEventListener('click', (e) => { e.stopPropagation(); expanded.delete(m.id); T.remove(m.id); });
      item.addEventListener('click', () => T.select(m.id));
      ui.listEl.appendChild(item);
      if (open) ui.listEl.appendChild(details(m, origin, sr));
    }
  }

  /** Called by the rightpanel when the panel is opened and when the markers or the capture data changed. */
  function render({ container }) {
    current = container;
    if (!ui || ui.container !== container) build(container);
    rebuildList();
    ui.add.disabled = !WS.capture.hasData();
    syncEditor();
  }

  T.panel = { render };
})(window.WS = window.WS || {});
