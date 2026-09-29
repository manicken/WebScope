(function (WS) {
  'use strict';
  const { fmtCount, fmtRate, fmtTime } = WS.format;

  function init(ids) {
    const samplesEl = document.getElementById(ids.samples);
    const rateEl = document.getElementById(ids.rate);
    const viewEl = document.getElementById(ids.view);
    function render() {
      const { status, view } = WS.store.get();
      samplesEl.textContent = fmtCount(status.samples);
      rateEl.textContent = fmtRate(status.samplerate);
      viewEl.textContent = `${fmtTime(view.spp / status.samplerate)}/px`;
    }
    WS.store.store.subscribe(render);
    render();
  }

  WS.ui = WS.ui || {};
  WS.ui.statusbar = { init };
})(window.WS = window.WS || {});
