/**
 * waveformActions.js — view actions: zoom / pan / fit / frame. They write appState.view.
 */
(function (WS) {
  'use strict';
  const { view } = WS.appState;
  const { clampViewTo, frameRange } = WS.view;

  /** Plain copy of appState.view: { start, spp, plotWidth, follow } */
  function getView() {
    return { start: view.start.value, spp: view.spp.value, plotWidth: view.plotWidth.value, follow: view.follow.value };
  }

  /** Sets the view; any user navigation stops following a streaming capture. */
  function setView({ start, spp }, follow = false) {
    view.follow.set(follow);
    view.spp.set(spp);
    view.start.set(start);
  }

  function fit() {
    const n = Math.max(WS.capture.length(), 1);
    view.spp.set(n / Math.max(view.plotWidth.value, 1));
    view.start.set(0);
  }
  function clampView(start, spp) {
    return clampViewTo(start, spp, WS.capture.length(), view.plotWidth.value);
  }
  function zoomAt(factor, x) {
    const sample = view.start.value + x * view.spp.value;
    const spp = view.spp.value * factor;
    setView(clampView(sample - x * spp, spp));
  }
  function panBy(px) {
    setView(clampView(view.start.value + px * view.spp.value, view.spp.value));
  }
  function frameSpan(start, end) {
    const v = frameRange(start, end, view.plotWidth.value);
    setView(clampView(v.start, v.spp));
  }
  /** Centers the view on `sample`; widens out if `width` wouldn't be legible at the current zoom. */
  function centerOn(sample, width) {
    const plotWidth = view.plotWidth.value;
    let spp = view.spp.value;
    if (width && width / spp < 24) spp = Math.max(width / (plotWidth / 8), 1 / 64);
    setView(clampView(sample - (plotWidth / 2) * spp, spp));
  }

  // new data is shown whole, unless the user has navigated since the capture started
  WS.capture.buffer.subscribe(() => { if (view.follow.value) fit(); });

  WS.waveform = WS.waveform ?? {};
  Object.assign(WS.waveform, { getView, fit, clampView, setView, zoomAt, panBy, frameSpan, centerOn });
})(window.WS = window.WS || {});
