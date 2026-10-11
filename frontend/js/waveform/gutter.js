/**
 * ui/gutter.js — channel labels (color, name, trigger, hide) and decoder row labels,
 * ported from Waveform.tsx's ChannelLabel + the gutter body in edgewise's Waveform.tsx.
 */
(function (WS) {
  'use strict';
  const { store } = WS;
  const TRIGGER_LABEL = { rising: '↗', falling: '↘', edge: '↕', high: '⬆', low: '⬇' };

  function init(gutterBodyEl, onScroll) {
    function render(rows) {
      console.log(rows);
      gutterBodyEl.innerHTML = '';
      for (const r of rows) {
        if (r.kind === 'channel') {
          gutterBodyEl.appendChild(channelRow(r));
        } else {
          gutterBodyEl.appendChild(decoderRow(r));
        }
      }
      const hidden = store.get().channels.filter((c) => !c.visible);
      if (hidden.length) {
        const btn = document.createElement('button');
        btn.textContent = `Show ${hidden.length} hidden`;
        btn.style.margin = '6px 8px';
        btn.addEventListener('click', () => hidden.forEach((c) => WS.waveform.updateChannel(c.index, { visible: true })));
        gutterBodyEl.appendChild(btn);
      }
    }

    function channelRow(r) {
      //console.trace();
      let ch = r.ch;
      const row = document.createElement('div');
      row.className = 'ch-row';
      row.innerHTML = `
        <span class="ch-bar" style="background:${ch.color}"></span>
        <span class="ch-index">CH${ch.index+1}</span>
        <span class="ch-name">${ch.name}</span>
        <span class="ch-actions">
          <button class="icon-btn trig ${ch.trigger ? 'on' : ''}" title="Cycle trigger">${ch.trigger ? TRIGGER_LABEL[ch.trigger] : '⚡'}</button>
          <button class="icon-btn hide" title="Hide channel">✕</button>
        </span>`;
      row.querySelector('.trig').addEventListener('click', () => WS.waveform.cycleTrigger(ch.index));
      row.querySelector('.hide').addEventListener('click', () => WS.waveform.updateChannel(ch.index, { visible: false }));
      const nameEl = row.querySelector('.ch-name');
      nameEl.addEventListener('dblclick', () => {
        nameEl.innerHTML = `<input value="${ch.name}">`;
        const input = nameEl.querySelector('input');
        input.focus(); input.select();
        const commit = () => WS.waveform.updateChannel(ch.index, { name: input.value.trim() || `D${ch.index}` });
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
      });
      return row;
    }

    function decoderRow(r) {
      const row = document.createElement('div');
      row.className = 'dec-row';
      row.innerHTML = `<span class="dec-dot" style="background:${r.dec.color}"></span><span class="dec-name">${r.dec.name}</span><span class="dec-sub">${r.gutter.label}</span>`;
      if (r.row == 0) { 
        // only show the close button on the first decoder row
        const btn = document.createElement('button');
        btn.textContent = '✕'; btn.title = 'Remove decoder';
        btn.addEventListener('click', () => WS.waveform.removeDecoder(r.dec.id));
        row.appendChild(btn);
      }
      return row;
    }

    gutterBodyEl.parentElement.addEventListener('scroll', (e) => onScroll(e.currentTarget.scrollTop));
    WS.uiRows.onShapeChange(render);
    render(WS.uiRows.get());
  }

  WS.gutter = WS.gutter || {};
  WS.gutter.ui = { init };
})(window.WS = window.WS || {});
