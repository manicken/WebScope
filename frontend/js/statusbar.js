(function (WS) {
  'use strict';
  const { fmtCount, fmtRate, fmtTime, fmtSampleResolution } = WS.format;

  function init(ids) {
    const samplesEl = document.getElementById(ids.samples);
    const rateEl = document.getElementById(ids.rate);
    const sampleResolutionEl = document.getElementById(ids.sampleResolution);
    const viewEl = document.getElementById(ids.view);
    function render() {
      const { status, view } = WS.store.get();
      samplesEl.textContent = fmtCount(status.samples);
      rateEl.textContent = fmtRate(status.samplerate);
      sampleResolutionEl.textContent = fmtSampleResolution(status.samplerate);
      viewEl.textContent = `${fmtTime(view.spp / status.samplerate)}/px`;
    }
    WS.store.store.subscribe(render);
    render();
  }

  WS.statusbar = { init };
})(window.WS = window.WS || {});
