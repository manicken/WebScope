/**
 * ui/gutter.js — channel labels (color, name, trigger, hide) and decoder row labels,
 * ported from Waveform.tsx's ChannelLabel + the gutter body in edgewise's Waveform.tsx.
 */
(function (WS) {
  'use strict';
  const { get } = WS.store;
  const { cycleTrigger, updateChannel, removeDecoder } = WS.actions;
  const TRIGGER_LABEL = { rising: '↗', falling: '↘', edge: '↕', high: '⬆', low: '⬇' };

  function init(gutterBodyEl, onScroll) {
    function render(rows) {
      gutterBodyEl.innerHTML = '';
      for (const r of rows) {
        if (r.kind === 'channel') gutterBodyEl.appendChild(channelRow(r.ch));
        else gutterBodyEl.appendChild(decoderRow(r));
      }
      const hidden = get().channels.filter((c) => !c.visible);
      if (hidden.length) {
        const btn = document.createElement('button');
        btn.textContent = `Show ${hidden.length} hidden`;
        btn.style.margin = '6px 8px';
        btn.addEventListener('click', () => hidden.forEach((c) => updateChannel(c.index, { visible: true })));
        gutterBodyEl.appendChild(btn);
      }
    }

    function channelRow(c) {
      const row = document.createElement('div');
      row.className = 'ch-row';
      row.innerHTML = `
        <span class="ch-bar" style="background:${c.color}"></span>
        <span class="ch-index">D${c.index}</span>
        <span class="ch-name">${c.name}</span>
        <span class="ch-actions">
          <button class="icon-btn trig ${c.trigger ? 'on' : ''}" title="Cycle trigger">${c.trigger ? TRIGGER_LABEL[c.trigger] : '⚡'}</button>
          <button class="icon-btn hide" title="Hide channel">✕</button>
        </span>`;
      row.querySelector('.trig').addEventListener('click', () => cycleTrigger(c.index));
      row.querySelector('.hide').addEventListener('click', () => updateChannel(c.index, { visible: false }));
      const nameEl = row.querySelector('.ch-name');
      nameEl.addEventListener('dblclick', () => {
        nameEl.innerHTML = `<input value="${c.name}">`;
        const input = nameEl.querySelector('input');
        input.focus(); input.select();
        const commit = () => updateChannel(c.index, { name: input.value.trim() || `D${c.index}` });
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
      });
      return row;
    }

    function decoderRow(r) {
      const row = document.createElement('div');
      row.className = 'dec-row';
      row.innerHTML = `<span class="dec-dot" style="background:${r.dec.color}"></span><span class="dec-name">${r.dec.name}</span><span class="dec-sub">${r.label}</span>`;
      const btn = document.createElement('button');
      btn.textContent = '✕'; btn.title = 'Remove decoder';
      btn.addEventListener('click', () => removeDecoder(r.dec.id));
      row.appendChild(btn);
      return row;
    }

    gutterBodyEl.parentElement.addEventListener('scroll', (e) => onScroll(e.currentTarget.scrollTop));
    WS.uiRows.onShapeChange(render);
    render(WS.uiRows.get());
  }

  WS.ui = WS.ui || {};
  WS.ui.gutter = { init };
})(window.WS = window.WS || {});
