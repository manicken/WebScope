(function (WS) {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {

    const gutterBody = document.getElementById('gutterBody');
    const waveform = WS.ui.waveform.init({
      canvas: document.getElementById('canvas'),
      plotWrap: document.getElementById('plotWrap'),
      hoverTipEl: document.getElementById('hoverTip'),
      emptyStateEl: document.getElementById('emptyState')
    });
    WS.ui.gutter.init(gutterBody, (y) => waveform.setScroll(y));
    WS.ui.rightpanel.init(document.getElementById('rightPanel'));
    WS.ui.topbar.init({
      sourceKind: 'sourceKind', wsUrl: 'wsUrl', samplerate: 'samplerateIn', duration: 'durationIn',
      captureBtn: 'captureBtn', fitBtn: 'fitBtn', statusPill: 'statusPill'
    });
    WS.ui.statusbar.init({ samples: 'stSamples', rate: 'stRate', view: 'stView' });

    WS.uiRows.recompute();
  });
})(window.WS = window.WS || {});
