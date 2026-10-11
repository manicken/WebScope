/**
 * waveformActions.js — view (zoom/pan/fit/frame) and channel (trigger, name, visibility)
 */
(function (WS) {
  'use strict';
  const { store } = WS;
  const { clampViewTo, frameRange } = WS.view;

  /* ---- view ---- */
  function fit() {
    const { status, plotWidth } = store.get();
    const n = Math.max(status.samples, 1);
    store.set({ view: { start: 0, spp: n / Math.max(plotWidth, 1) } });
  }
  function clampView(start, spp) {
    const { status, plotWidth } = store.get();
    return clampViewTo(start, spp, status.samples, plotWidth);
  }
  function zoomAt(factor, x) {
    const { view } = store.get();
    const sample = view.start + x * view.spp;
    const spp = view.spp * factor;
    store.set({ view: clampView(sample - x * spp, spp), follow: false });
  }
  function panBy(px) {
    const { view } = store.get();
    store.set({ view: clampView(view.start + px * view.spp, view.spp), follow: false });
  }
  function frameSpan(start, end) {
    const v = frameRange(start, end, store.get().plotWidth);
    store.set({ view: clampView(v.start, v.spp), follow: false });
  }
  /** Centers the view on `sample`; widens out if `width` wouldn't be legible at the current zoom. */
  function centerOn(sample, width) {
    const { view, plotWidth } = store.get();
    let spp = view.spp;
    if (width && width / spp < 24) spp = Math.max(width / (plotWidth / 8), 1 / 64);
    store.set({ view: clampView(sample - (plotWidth / 2) * spp, spp), follow: false });
  }

  /* ---- channels ---- */
  const TRIGGER_CYCLE = [null, 'rising', 'falling', 'edge', 'high', 'low'];
  function cycleTrigger(index) {
    store.set({ channels: store.get().channels.map((c) => c.index === index ? { ...c, trigger: TRIGGER_CYCLE[(TRIGGER_CYCLE.indexOf(c.trigger) + 1) % TRIGGER_CYCLE.length] } : c) });
  }
  function updateChannel(index, patch) {
    store.set({ channels: store.get().channels.map((c) => c.index === index ? { ...c, ...patch } : c) });
  }

  WS.waveform = WS.waveform ?? {};
  Object.assign(WS.waveform, { fit, clampView, zoomAt, panBy, frameSpan, centerOn, cycleTrigger, updateChannel });
})(window.WS = window.WS || {});
