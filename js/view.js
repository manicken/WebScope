/**
 * view.js — pure view maths, free of store/engine dependencies.
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

  /** The annotation (or merged block) covering `sample`, within `tolerance` samples; nearest wins. */
  function annotationAt(anns, sample, tolerance) {
    let best = null, bestDist = Infinity;
    for (const a of anns) {
      const dist = sample < a.start ? a.start - sample : sample > a.end ? sample - a.end : 0;
      if (dist <= tolerance && dist < bestDist) {
        best = a; bestDist = dist;
        if (dist === 0) break;
      }
    }
    return best;
  }

  WS.view = { clampViewTo, frameRange, annotationAt };
})(window.WS = window.WS || {});
