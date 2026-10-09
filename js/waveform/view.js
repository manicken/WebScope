/**
 * view.js — pure view maths,
 * Ported 1:1 from edgewise's src/renderer/src/view.ts.
 */
(function (WS) {
  'use strict';

  const FRAME_SPAN = 0.9;

  /** Clamps zoom to 1/64..4x the capture and keeps at least half the view on the capture. */
  function clampViewTo(start, spp, samples, plotWidth) {
    const n = Math.max(samples, 1);
    spp = Math.min(Math.max(spp, 1 / 64), (n / plotWidth) * 4);
    const visible = spp * plotWidth;
    start = Math.min(Math.max(start, -visible * 0.5), n - visible * 0.5);
    return { start, spp };
  }

  /** View that centres [start, end] and spans FRAME_SPAN of the plot width (before clamping). */
  function frameRange(start, end, plotWidth) {
    const spp = Math.max(end - start, 0) / (plotWidth * FRAME_SPAN);
    const clamped = Math.max(spp, 1 / 64);
    return { start: (start + end) / 2 - (plotWidth / 2) * clamped, spp: clamped };
  }

  WS.view = { clampViewTo, frameRange };
})(window.WS = window.WS || {});
