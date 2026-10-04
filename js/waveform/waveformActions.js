/**
 * waveformActions.js — view (zoom/pan/fit/frame) and channel (trigger, name, visibility) actions.
 */
(function (WS) {
  'use strict';
  const { get, set } = WS.store;
  const { clampViewTo, frameRange } = WS.view;
  const A = (WS.actions = WS.actions || {});

  /* ---- view ---- */
  function fit() {
    const { status, plotWidth } = get();
    const n = Math.max(status.samples, 1);
    set({ view: { start: 0, spp: n / Math.max(plotWidth, 1) } });
  }
  function clampView(start, spp) {
    const { status, plotWidth } = get();
    return clampViewTo(start, spp, status.samples, plotWidth);
  }
  function zoomAt(factor, x) {
    const { view } = get();
    const sample = view.start + x * view.spp;
    const spp = view.spp * factor;
    set({ view: clampView(sample - x * spp, spp), follow: false });
  }
  function panBy(px) {
    const { view } = get();
    set({ view: clampView(view.start + px * view.spp, view.spp), follow: false });
  }
  function frameSpan(start, end) {
    const v = frameRange(start, end, get().plotWidth);
    set({ view: clampView(v.start, v.spp), follow: false });
  }
  /** Centers the view on `sample`; widens out if `width` wouldn't be legible at the current zoom. */
  function centerOn(sample, width) {
    const { view, plotWidth } = get();
    let spp = view.spp;
    if (width && width / spp < 24) spp = Math.max(width / (plotWidth / 8), 1 / 64);
    set({ view: clampView(sample - (plotWidth / 2) * spp, spp), follow: false });
  }

  /* ---- channels ---- */
  const TRIGGER_CYCLE = [null, 'rising', 'falling', 'edge', 'high', 'low'];
  function cycleTrigger(index) {
    set({ channels: get().channels.map((c) => c.index === index ? { ...c, trigger: TRIGGER_CYCLE[(TRIGGER_CYCLE.indexOf(c.trigger) + 1) % TRIGGER_CYCLE.length] } : c) });
  }
  function updateChannel(index, patch) {
    set({ channels: get().channels.map((c) => c.index === index ? { ...c, ...patch } : c) });
  }

  Object.assign(A, { fit, clampView, zoomAt, panBy, frameSpan, centerOn, cycleTrigger, updateChannel });
})(window.WS = window.WS || {});
