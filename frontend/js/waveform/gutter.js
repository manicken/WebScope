/**
 * ui/gutter.js — channel labels (color, name, hide) and decoder row labels,
 * ported from Waveform.tsx's ChannelLabel + the gutter body in edgewise's Waveform.tsx.
 *
 * The gutter is re-assembled when the row layout changes shape (WS.uiRows.onShapeChange).
 * A channel's row element is created once per channel and reused; it keeps its color and name
 * up to date by subscribing to the channel's values.
 */
(function (WS) {
  'use strict';
  const { appState } = WS;

  const channelRows = new WeakMap(); // channel -> row element, gone together with the channel

  let _render = null;
  function init(gutterBodyEl, onScroll) {

    function render(rows) {
      const kids = rows.map((r) => (r.kind === 'channel' ? channelRow(r.ch) : decoderRow(r)));
      const hidden = appState.channels.value.filter((c) => !c.visible.value);
      if (hidden.length) {
        const btn = document.createElement('button');
        btn.textContent = `Show ${hidden.length} hidden`;
        btn.style.margin = '6px 8px';
        btn.addEventListener('click', () => hidden.forEach((c) => c.visible.set(true)));
        kids.push(btn);
      }
      gutterBodyEl.replaceChildren(...kids);
    }

    function channelRow(ch) {
      let row = channelRows.get(ch);
      if (row) return row;

      row = document.createElement('div');
      row.className = 'ch-row';
      row.innerHTML = `
        <span class="ch-bar"></span>
        <span class="ch-index">CH${ch.index+1}</span>
        <span class="ch-name"></span>
        <span class="ch-tag" hidden>not captured</span>
        <span class="ch-actions">
          <button class="icon-btn hide" title="Hide channel">✕</button>
        </span>`;
      const barEl = row.querySelector('.ch-bar');
      const nameEl = row.querySelector('.ch-name');

      const showColor = () => { barEl.style.background = ch.color.value ?? ''; };
      const showName = () => { nameEl.textContent = ch.name.value ?? ''; };
      // a capture that does not hold this channel (chosen after the capture): say so; no capture, no tag
      const tagEl = row.querySelector('.ch-tag');
      const showTag = () => { const b = WS.capture.buffer.value; tagEl.hidden = !b || b.has(ch.index); };
      showColor();
      showName();
      showTag();
      ch.color.subscribe(showColor);
      ch.name.subscribe(showName);
      WS.capture.buffer.subscribe(showTag);

      row.querySelector('.hide').addEventListener('click', () => ch.visible.set(false));

      nameEl.addEventListener('dblclick', () => {
        const input = document.createElement('input');
        input.value = ch.name.value;
        nameEl.replaceChildren(input);
        input.focus(); input.select();
        const commit = () => {
          ch.name.set(input.value.trim() || `D${ch.index}`);
          showName(); // also when the name did not change, to remove the input
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
      });

      channelRows.set(ch, row);
      return row;
    }

    function decoderRow(r) {
      const row = document.createElement('div');
      row.className = 'dec-row';
      row.innerHTML = `<span class="dec-dot" style="background:${r.dec.color}"></span><span class="dec-name">${r.dec.name}</span><span class="dec-sub">${r.gutter.label}</span>`;
      if (r === WS.uiRows.get().find((x) => x.dec === r.dec)) {
        // only show the close button on the decoder's first row
        const btn = document.createElement('button');
        btn.textContent = '✕'; btn.title = 'Remove decoder';
        btn.addEventListener('click', () => WS.decoders.removeDecoder(r.dec.id));
        row.appendChild(btn);
      }
      return row;
    }

    gutterBodyEl.parentElement.addEventListener('scroll', (e) => onScroll(e.currentTarget.scrollTop));
    WS.uiRows.onShapeChange(render);
    render(WS.uiRows.get());
    _render = render;
  }

  WS.gutter = WS.gutter || {};
  WS.gutter.ui = { init, render() {_render(WS.uiRows.get());} };
})(window.WS = window.WS || {});
