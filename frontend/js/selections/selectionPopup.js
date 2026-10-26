/**
 * selections/selectionPopup.js — the HTML popup under the selected selection.
 * Built once; update() only changes text / position, so the comment textarea keeps focus while
 * the canvas redraws every frame. Lives inside #plotWrap (like #hoverTip), i.e. it is clipped by the
 * plot area and sits behind the gutter and the right panel.
 */
(function (WS) {
  'use strict';
  const S = WS.selections;
  const { appState } = WS;
  const { RULER_H } = WS.theme;

  const FIELDS = [
    ['dt', 'ΔT'], ['nRising', 'N<sub>rising</sub>'], ['nFalling', 'N<sub>falling</sub>'],
    ['fmin', 'f<sub>min</sub>'], ['fmax', 'f<sub>max</sub>'], ['fmean', 'f<sub>mean</sub>'], ['tstd', 'T<sub>std</sub>'],
  ];

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  let root, nameIn, chSel, ta, vals = {}, swatches = [], shownId = null, chSig = '', last = null;

  function init(plotWrap) {
    root = el('div', 'sel-pop'); root.style.display = 'none';

    const top = el('div', 'sel-pop-top');
    nameIn = el('input', 'sel-pop-name'); nameIn.type = 'text'; nameIn.maxLength = 32; nameIn.title = 'Rename measurement'; nameIn.spellcheck = false;
    chSel = el('select', 'sel-pop-ch');
    const zoom = el('button', 'sel-pop-icon', '⤢'); zoom.title = 'Zoom to selection';
    const copy = el('button', 'sel-pop-icon', '⧉'); copy.title = 'Copy values';
    top.append(nameIn, chSel, el('span', 'spacer'), zoom, copy);

    const grid = el('div', 'sel-pop-grid');
    for (const [k, label] of FIELDS) {
      const v = el('span', 'sel-v mono', '—'); vals[k] = v;
      grid.append(el('span', 'sel-k', label), v);
    }

    ta = el('textarea', 'sel-pop-comment'); ta.placeholder = 'Comment here'; ta.rows = 2;

    const foot = el('div', 'sel-pop-foot');
    for (const c of S.COLORS) {
      const b = el('button', 'sel-swatch-btn'); b.style.background = c; b.dataset.color = c; b.title = c;
      b.addEventListener('click', () => { if (shownId) S.update(shownId, { color: c }); });
      swatches.push(b); foot.appendChild(b);
    }
    const trash = el('button', 'sel-pop-icon', '🗑'); trash.title = 'Delete measurement';
    foot.append(el('span', 'spacer'), trash);

    root.append(top, grid, ta, foot);
    plotWrap.appendChild(root);

    // keep typing away from global shortcuts (keymap etc.)
    for (const t of ['keydown', 'keyup']) for (const n of [ta, chSel, nameIn]) {
      n.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'keydown' && (e.key === 'Escape' || (e.key === 'Enter' && n !== ta))) n.blur(); });
    }
    ta.addEventListener('input', () => { if (shownId) S.update(shownId, { comment: ta.value }); });
    // rename: applied live (the ruler tag and the panel follow); an empty name is not accepted
    nameIn.addEventListener('input', () => { const v = nameIn.value.trim(); if (shownId && v) S.update(shownId, { name: v }); });
    nameIn.addEventListener('blur', () => { const s = S.find(shownId); if (s && !nameIn.value.trim()) nameIn.value = s.name; });
    chSel.addEventListener('change', () => {
      const statChannel = appState.selections.statChannel;
      statChannel.set({ ...statChannel.value, [shownId]: parseInt(chSel.value, 10) });
    });
    zoom.addEventListener('click', () => { const s = S.find(shownId); if (s) WS.waveform.frameSpan(s.start, s.end); });
    trash.addEventListener('click', () => { if (shownId) S.remove(shownId); });
    copy.addEventListener('click', () => {
      if (!last) return;
      const txt = FIELDS.map(([k, l]) => `${l.replace(/<\/?sub>/g, '')}\t${last[k]}`).join('\n');
      navigator.clipboard?.writeText(txt);
    });
  }

  function hide() { if (root) root.style.display = 'none'; }

  /** The channel the stats are shown for (user's pick in the dropdown, else the first channel). */
  function statChannel(sel) {
    const chans = S.channelsOf(sel);
    const want = appState.selections.statChannel.value[sel.id];
    return chans.includes(want) ? want : (chans[0] ?? null);
  }

  function update(E) {
    if (!root) return;
    const channels = appState.channels.value;
    const sel = S.find(S.selected());
    if (!sel || !E.hasData) return hide();

    const rs = S.runs(sel, E.rows);
    const X = (s) => (s - E.view.start) / E.view.spp;
    const x0 = X(sel.start), x1 = X(sel.end);
    if (!rs.length || x1 < 0 || x0 > E.w) return hide();

    root.style.display = 'block';
    if (shownId !== sel.id) { shownId = sel.id; ta.value = sel.comment ?? ''; nameIn.value = sel.name; }
    else if (document.activeElement !== ta && ta.value !== (sel.comment ?? '')) ta.value = sel.comment ?? '';
    if (document.activeElement !== nameIn && nameIn.value !== sel.name) nameIn.value = sel.name;
    for (const b of swatches) b.classList.toggle('on', b.dataset.color === sel.color);

    // channel dropdown (only when more than one channel row is selected)
    const chans = S.channelsOf(sel);
    const sig = chans.map((c) => c + ':' + (channels[c]?.name.value ?? '')).join('|');
    if (sig !== chSig) {
      chSig = sig;
      chSel.innerHTML = '';
      for (const c of chans) { const o = el('option'); o.value = c; o.textContent = `CH${c + 1} ${channels[c]?.name.value ?? ''}`; chSel.appendChild(o); }
    }
    chSel.style.display = chans.length > 1 ? '' : 'none';
    const ch = statChannel(sel);
    if (ch != null) chSel.value = String(ch);

    last = S.stats.formatted(sel, ch);
    for (const [k] of FIELDS) { if (vals[k].textContent !== last[k]) vals[k].textContent = last[k]; }

    // position: centred under the selection, flipped above it when there is no room
    const pw = root.offsetWidth, ph = root.offsetHeight;
    const yTop = RULER_H - E.scrollY + rs[0].y0, yBot = RULER_H - E.scrollY + rs[rs.length - 1].y1;
    let left = (x0 + x1) / 2 - pw / 2;
    left = Math.max(6, Math.min(E.w - pw - 6, left));
    let top = yBot + 8;
    if (top + ph > E.h - 4) top = yTop - ph - 8;
    if (top < RULER_H + 4) top = Math.max(RULER_H + 4, E.h - ph - 4);
    root.style.left = Math.round(left) + 'px';
    root.style.top = Math.round(top) + 'px';
  }

  S.popup = { init, update, statChannel };
})(window.WS = window.WS || {});
