/**
 * statusbar.js — facts about the data on screen (WS.capture.buffer), "—" when there is none.
 * The settings for the next capture are shown in the Capture panel, not here.
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const { fmtCount, fmtRate, fmtTime, fmtSampleResolution } = WS.format;

  function init(ids) {
    const samplesEl = document.getElementById(ids.samples);
    const rateEl = document.getElementById(ids.rate);
    const sampleResolutionEl = document.getElementById(ids.sampleResolution);
    const viewEl = document.getElementById(ids.view);

    function showBuffer() {
      const buf = WS.capture.buffer.value;
      samplesEl.textContent = buf ? fmtCount(buf.length) : '—';
      rateEl.textContent = buf ? fmtRate(buf.samplerate) : '—';
      sampleResolutionEl.textContent = buf ? fmtSampleResolution(buf.samplerate) : '—';
      showView();
    }
    function showView() {
      const buf = WS.capture.buffer.value;
      viewEl.textContent = buf ? `${fmtTime(appState.view.spp.value / buf.samplerate)}/px` : '—';
    }

    WS.capture.buffer.subscribe(showBuffer);
    appState.view.spp.subscribe(showView);
    showBuffer();
  }

  WS.statusbar = { init };
})(window.WS = window.WS || {});
