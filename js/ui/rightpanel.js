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

  

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  function section(title, extraEl, grow) {
    const s = el('section', 'section' + (grow ? ' grow' : ''));
    const head = el('div', 'section-head', `<span>${title}</span>`);
    if (extraEl) head.appendChild(extraEl);
    s.appendChild(head);
    return s;
  }

  /* ============================== boot ============================== */
  function init(rightPanelEl) {
    const analyzers = el('div'); const measurements = el('div'); const dataTable = el('div');
    dataTable.style.display = 'flex'; dataTable.style.flex = '1'; dataTable.style.minHeight = '0'; dataTable.style.flexDirection = 'column';
    rightPanelEl.appendChild(analyzers); rightPanelEl.appendChild(measurements); rightPanelEl.appendChild(dataTable);

    function renderAll() {
      WS.ui.decoders.renderAnalyzers(analyzers);
      WS.ui.measurements.render(measurements);
      WS.ui.decoders.renderDataTable(dataTable);
    }
    WS.store.store.subscribe(renderAll);
    renderAll();
  }

  WS.ui = WS.ui || {};
  WS.ui.rightpanel = { init, section };
})(window.WS = window.WS || {});
