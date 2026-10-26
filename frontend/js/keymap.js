/**
 * ui/keymap.js — global keyboard shortcuts, ported from edgewise's App.tsx onKey().
 * Requires WS.ui.topbar.toggleCapture to exist (see the one-line addition to topbar.js).
 */
(function (WS) {
  'use strict';

  const { appState } = WS;

  const MOD = navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl';
  const HELP_HTML =
    `<kbd>Space</kbd> capture · <kbd>scroll</kbd> zoom · <kbd>drag</kbd> pan · <kbd>F</kbd> fit · ` +
    `<kbd>${MOD}</kbd> click zoom to packet · <kbd>[</kbd><kbd>]</kbd> edges`;

  function jumpEdge(forward) {
    const { view, pointer } = appState;
    const hover = pointer.hover.value;
    const ch = hover?.channel ?? appState.channels.value.find((c) => c.visible.value)?.index;
    if (ch === undefined) return;
    const from = hover?.sample ?? view.start.value + (view.spp.value * view.plotWidth.value) / 2;
    const edge = WS.capture.findEdge(ch, Math.round(from), forward);
    if (edge === null) return;
    WS.waveform.centerOn(edge);
    pointer.hover.set({ sample: edge, channel: ch, x: (edge - view.start.value) / view.spp.value, y: hover?.y ?? 0 });
  }

  function onKey(e) {
    const t = e.target;
    if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
    const plotWidth = appState.view.plotWidth.value;
    const mid = appState.pointer.hover.value?.x ?? plotWidth / 2;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        WS.topbar.toggleCapture();
        break;
      case 'f':
        appState.view.follow.set(false);
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