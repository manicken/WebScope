/**
 * ui/keymap.js — global keyboard shortcuts, ported from edgewise's App.tsx onKey().
 * Requires WS.ui.topbar.toggleCapture to exist (see the one-line addition to topbar.js).
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;
  const { engine, actions } = WS;

  const MOD = navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl';
  const HELP_HTML =
    `<kbd>Space</kbd> capture · <kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan · <kbd>F</kbd> fit · ` +
    `<kbd>${MOD}</kbd> click zoom to packet · <kbd>A</kbd>/<kbd>B</kbd> markers · <kbd>[</kbd><kbd>]</kbd> edges`;

  function jumpEdge(forward) {
    const { hover, channels, view, plotWidth } = get();
    const ch = hover?.channel ?? channels.find((c) => c.visible)?.index;
    if (ch === undefined) return;
    const from = hover?.sample ?? view.start + (view.spp * plotWidth) / 2;
    const edge = engine.findEdge(ch, Math.round(from), forward);
    if (edge === null) return;
    actions.centerOn(edge);
    const v = get().view;
    set({ hover: { sample: edge, channel: ch, x: (edge - v.start) / v.spp, y: hover?.y ?? 0 } });
  }

  function onKey(e) {
    const t = e.target;
    if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
    const { plotWidth, hover, markers } = get();
    const mid = hover?.x ?? plotWidth / 2;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        WS.ui.topbar.toggleCapture();
        break;
      case 'f':
        set({ follow: false });
        actions.fit();
        break;
      case '=':
      case '+':
        actions.zoomAt(0.5, mid);
        break;
      case '-':
        actions.zoomAt(2, mid);
        break;
      case 'ArrowLeft':
        actions.panBy(-plotWidth * 0.2);
        break;
      case 'ArrowRight':
        actions.panBy(plotWidth * 0.2);
        break;
      case 'a':
      case 'b':
        if (hover) set({ markers: { ...markers, [e.key]: hover.sample } });
        break;
      case 'Escape':
        set({ markers: { a: null, b: null } });
        break;
      case '[':
        jumpEdge(false);
        break;
      case ']':
        jumpEdge(true);
        break;
    }
  }

  function init(helpEl) {
    window.addEventListener('keydown', onKey);
    if (helpEl) helpEl.innerHTML = HELP_HTML;
  }

  WS.ui = WS.ui || {};
  WS.ui.keymap = { init };
})(window.WS = window.WS || {});