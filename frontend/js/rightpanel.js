/**
 * ui/rightpanel.js — Saleae-style right sidebar: icon tab bar + one panel at a time.
 * Panels are registered with WS.rightpanel.register({ id, title, icon, render, watch, fill }).
 *   render({ container })  draws the panel; called when it is opened and when watched values change
 *   watch(changed)         called once: subscribes `changed` to the values the panel shows, e.g.
 *                            (changed) => ReactiveValue.subscribeAll([appState.markers.list, WS.capture.buffer], changed)
 *                          Changes are ignored while the panel is closed (it renders again when opened).
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const LS_KEY = 'ws.rightpanel.width';
  const MIN_W = 240;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  function section(title, extraEl, grow) {
    const s = el('section', 'section' + (grow ? ' grow' : ''));
    const head = el('div', 'section-head', `<span>${title}</span>`);
    if (extraEl) head.appendChild(extraEl);
    s.appendChild(head);
    return s;
  }

  /* ---------------- panel registry ---------------- */
  const defs = [];          // registered panel definitions, in tab order
  const views = new Map();  // id -> { def, tab, view }
  let ui = null;            // set by init()
  let activeId = null;      // no panel open at startup

  function register(def) {
    defs.push(def);
    if (ui) mountPanel(def);
  }

  function mountPanel(def) {
    const tab = el('button', 'rp-tab', def.icon);
    tab.title = def.title;
    tab.setAttribute('aria-label', def.title);
    tab.addEventListener('click', () => toggle(def.id));
    const view = el('div', 'rp-view' + (def.fill ? ' fill' : ''));
    ui.tabs.appendChild(tab);
    ui.body.appendChild(view);
    views.set(def.id, { def, tab, view });
    def.watch?.(() => { if (activeId === def.id) scheduleRender(); });
  }

  function renderActive() {
    const p = views.get(activeId);
    if (p) p.def.render({ container: p.view });
  }

  // several watched values can change in one go: render once, after the current change is done
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => { renderPending = false; renderActive(); });
  }

  function setActive(id) {
    if (id && !views.has(id)) return;
    activeId = id;
    const open = !!id;
    ui.content.hidden = !open;
    ui.resizer.hidden = !open;
    //ui.title.textContent = open ? views.get(id).def.title : '';
    views.forEach((p, pid) => {
      p.tab.classList.toggle('on', pid === id);
      p.view.classList.toggle('on', pid === id);
    });
    renderActive();
    // let canvases re-measure after the plot area changes size
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  const open   = (id) => setActive(id);
  const close  = () => setActive(null);
  const toggle = (id) => setActive(activeId === id ? null : id);

  /* ---------------- resizing ---------------- */
  function setWidth(w) {
    const max = Math.max(MIN_W, Math.floor(window.innerWidth * 0.6));
    w = Math.min(max, Math.max(MIN_W, w));
    ui.root.style.setProperty('--rp-width', w + 'px');
    return w;
  }

  function initResize() {
    let startX = 0, startW = 0, w = 0;
    ui.resizer.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startW = ui.content.getBoundingClientRect().width; w = startW;
      ui.resizer.setPointerCapture(e.pointerId);
      ui.resizer.classList.add('dragging');
      document.body.classList.add('rp-dragging');
    });
    ui.resizer.addEventListener('pointermove', (e) => {
      if (!ui.resizer.hasPointerCapture(e.pointerId)) return;
      w = setWidth(startW + (startX - e.clientX)); // dragging left widens the panel
      window.dispatchEvent(new Event('resize'));
    });
    const end = (e) => {
      if (!ui.resizer.hasPointerCapture(e.pointerId)) return;
      ui.resizer.releasePointerCapture(e.pointerId);
      ui.resizer.classList.remove('dragging');
      document.body.classList.remove('rp-dragging');
      try { localStorage.setItem(LS_KEY, String(Math.round(w))); } catch (_) {}
    };
    ui.resizer.addEventListener('pointerup', end);
    ui.resizer.addEventListener('pointercancel', end);

    let saved = NaN;
    try { saved = parseInt(localStorage.getItem(LS_KEY), 10); } catch (_) {}
    if (saved) setWidth(saved);
  }

  /* ============================== boot ============================== */
  function init(rightPanelEl) {
    rightPanelEl.innerHTML = '';
    const resizer = el('div', 'rp-resizer');
    const content = el('div', 'rp-content');
   // const header  = el('div', 'rp-header');
    //const title   = el('span');
    const closeBtn = el('button', 'icon-btn', '✕');
    closeBtn.title = 'Close panel';
    closeBtn.addEventListener('click', close);
    
    //header.append(title, closeBtn);
    const body = el('div', 'rp-body');
    content.append(/*header, */body);
    const tabs = el('nav', 'rp-tabs');
    content.hidden = true; resizer.hidden = true;
    rightPanelEl.append(resizer, content, tabs);

    ui = { root: rightPanelEl, resizer, content, body, tabs };
    defs.forEach(mountPanel);
    initResize();
  }

  /* ---------------- built-in panels ---------------- */
  const svg = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;

  register({
    id: 'capture', title: 'Capture Config',
    icon: svg('<path d="M12 3 21 8l-9 5-9-5z M3 13l9 5 9-5"/>'),
    watch: (changed) => WS.capturePanel.watch(changed),
    render: (c) => WS.capturePanel.render(c),
  });

  register({
    id: 'analyzers', title: 'Analyzers',
    icon: svg('<path d="M3 12h3l2-6 4 12 3-9 2 3h4"/>'),
    watch: (changed) => WS.decoders.list.subscribe(changed),
    render: (c) => WS.decoders.ui.renderAnalyzers({ ...c, panelRoot:true }),
  });
  register({
    id: 'measurements', title: 'Measurements',
    icon: svg('<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>'),
    watch: (changed) => {
      const { selections } = appState;
      ReactiveValue.subscribeAll([selections.list, selections.selected, WS.capture.buffer], changed);
      ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.name], changed);
    },
    render: (c) => WS.selections.panel.render(c),
  });
  register({
    id: 'markers', title: 'Markers',
    icon: svg('<path d="M6 4v16M18 4v16M6 12h12M9 9l-3 3 3 3M15 9l3 3-3 3"/>'),
    watch: (changed) => ReactiveValue.subscribeAll([appState.markers.list, appState.markers.selected, WS.capture.buffer], changed),
    render: (c) => WS.timeMarkers.panel.render(c),
  });
  register({
    id: 'decoded', title: 'Decoded data', fill: true,
    icon: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 9v11"/>'),
    watch: (changed) => {
      const { table } = appState;
      ReactiveValue.subscribeAll([WS.decoders.list, WS.decoders.revision, table.decoder, table.rowId, table.focus, WS.capture.buffer], changed);
    },
    render: (c) => WS.dataTable.renderDataTable(c),
  });

  WS.rightpanel = { init, section, register, open, close, toggle };
})(window.WS = window.WS || {});
