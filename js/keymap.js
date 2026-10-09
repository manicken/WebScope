/**
 * ui/keymap.js — global keyboard shortcuts, ported from edgewise's App.tsx onKey().
 * Requires WS.ui.topbar.toggleCapture to exist (see the one-line addition to topbar.js).
 */
(function (WS) {
  'use strict';

  const { store } = WS;

  const MOD = navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl';
  const HELP_HTML =
    `<kbd>Space</kbd> capture · <kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan · <kbd>F</kbd> fit · ` +
    `<kbd>${MOD}</kbd> click zoom to packet · <kbd>A</kbd>/<kbd>B</kbd> markers · <kbd>[</kbd><kbd>]</kbd> edges`;

  function jumpEdge(forward) {
    const { hover, channels, view, plotWidth } = store.get();
    const ch = hover?.channel ?? channels.find((c) => c.visible)?.index;
    if (ch === undefined) return;
    const from = hover?.sample ?? view.start + (view.spp * plotWidth) / 2;
    const edge = WS.capture.findEdge(ch, Math.round(from), forward);
    if (edge === null) return;
    WS.waveform.centerOn(edge);
    const v = store.get().view;
    store.set({ hover: { sample: edge, channel: ch, x: (edge - v.start) / v.spp, y: hover?.y ?? 0 } });
  }

  function onKey(e) {
    const t = e.target;
    if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
    const { plotWidth, hover, markers } = store.get();
    const mid = hover?.x ?? plotWidth / 2;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        WS.topbar.toggleCapture();
        break;
      case 'f':
        store.set({ follow: false });
        WS.waveform.fit();
        break;
      case '=':
      case '+':
        WS.waveform.zoomAt(0.5, mid);
        break;
      case '-':
        WS.waveform.zoomAt(2, mid);
        break;
      case 'ArrowLeft':
        WS.waveform.panBy(-plotWidth * 0.2);
        break;
      case 'ArrowRight':
        WS.waveform.panBy(plotWidth * 0.2);
        break;
      case 'a':
      case 'b':
        if (hover) store.set({ markers: { ...markers, [e.key]: hover.sample } });
        break;
      case 'Escape':
        store.set({ markers: { a: null, b: null } });
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

  WS.keymap = { init };
})(window.WS = window.WS || {});