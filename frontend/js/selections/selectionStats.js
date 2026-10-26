/**
 * selections/selectionStats.js — the numbers in the popup / panel.
 *
 * Per channel, over [start, end]:
 *   nRising / nFalling   edge counts
 *   periods              distances between consecutive RISING edges (T)
 *   fmin/fmax/fmean      min / max / mean of 1/T
 *   tstd                 standard deviation of T (population)
 * Results are cached per (capture, channel, range) so dragging only recomputes what changed.
 */
(function (WS) {
  'use strict';
  const cache = new Map(); // results for the current buffer
  WS.capture.buffer.subscribe(() => cache.clear());

  function compute(channel, start, end) {
    const buf = WS.capture.getBuffer();
    if (!buf || channel == null) return null;
    const key = `${channel}:${start}:${end}`;
    if (cache.has(key)) return cache.get(key);

    const sr = buf.samplerate;
    const { pos, rising } = buf.edges(channel, start, end);
    let nRising = 0, nFalling = 0;
    const rt = [];
    for (let k = 0; k < pos.length; k++) { if (rising[k]) { nRising++; rt.push(pos[k]); } else nFalling++; }

    const res = { nRising, nFalling, fmin: null, fmax: null, fmean: null, tstd: null };
    if (rt.length >= 2) {
      const T = [];
      for (let k = 1; k < rt.length; k++) T.push((rt[k] - rt[k - 1]) / sr);
      let fmin = Infinity, fmax = 0, fsum = 0, tsum = 0;
      for (const t of T) { const f = 1 / t; if (f < fmin) fmin = f; if (f > fmax) fmax = f; fsum += f; tsum += t; }
      const tmean = tsum / T.length;
      let v = 0; for (const t of T) v += (t - tmean) * (t - tmean);
      Object.assign(res, { fmin, fmax, fmean: fsum / T.length, tstd: Math.sqrt(v / T.length) });
    }
    if (cache.size > 300) cache.clear();
    cache.set(key, res);
    return res;
  }

  const deltaT = (sel) => { const b = WS.capture.getBuffer(); return b ? (sel.end - sel.start) / b.samplerate : 0; };

  /** Display strings. `channel` may be null (decoder-only selection): only ΔT is then available. */
  function formatted(sel, channel) {
    const { fmtTime, fmtFreq } = WS.format;
    const NA = 'N/A';
    const st = compute(channel, sel.start, sel.end);
    return {
      dt: fmtTime(deltaT(sel), 6),
      nRising: st ? String(st.nRising) : NA,
      nFalling: st ? String(st.nFalling) : NA,
      fmin: st && st.fmin != null ? fmtFreq(st.fmin) : NA,
      fmax: st && st.fmax != null ? fmtFreq(st.fmax) : NA,
      fmean: st && st.fmean != null ? fmtFreq(st.fmean) : NA,
      tstd: st && st.tstd != null ? fmtTime(st.tstd, 6) : NA,
    };
  }

  WS.selections.stats = { compute, deltaT, formatted };
})(window.WS = window.WS || {});
