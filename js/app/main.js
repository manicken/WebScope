(function (WS) {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {

    WS.sources.setRefreshCallback(() => {
      WebSocketSource.refreshdevices();
    });
    WS.sources.refresh(); // do not call the function above
    WebSocketSource.connect();

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
    WS.ui.statusbar.init({ samples: 'stSamples', rate: 'stRate', view: 'stView', sampleResolution:'stSampleResolution' });
    WS.ui.overview.init(document.getElementById('overviewCanvas'));
    WS.ui.keymap.init(document.getElementById('keyHints'));
    WS.uiRows.recompute();
  });
})(window.WS = window.WS || {});
