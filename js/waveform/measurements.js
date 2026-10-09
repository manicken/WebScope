(function (WS) {
  'use strict';

  const { fmtTime, fmtFreq } = WS.format;
  const { store } = WS;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  /* ============================== Timing ============================== */
  function render(container) {
    container.innerHTML = '';
    const { markers, status, hover } = store.get();
    const origin = status.trigger ?? 0;
    const t = (s) => fmtTime((s - origin) / status.samplerate, 6);
    const dt = markers.a !== null && markers.b !== null ? Math.abs(markers.b - markers.a) / status.samplerate : null;

    let extra = null;
    if (markers.a !== null || markers.b !== null) {
      extra = el('button', 'link', 'Clear');
      extra.addEventListener('click', () => store.set({ markers: { a: null, b: null } }));
    }
    const sec = WS.rightpanel.section('Timing', extra);
    const metrics = el('div', 'metrics');
    const metric = (label, value, color, strong) => {
      const m = el('div', 'metric' + (strong ? ' strong' : ''));
      const l = el('span', 'metric-label', label); if (color) l.style.color = color;
      m.appendChild(l);
      m.appendChild(el('span', 'metric-value mono', value));
      return m;
    };
    metrics.appendChild(metric('Cursor', hover ? t(hover.sample) : '—'));
    metrics.appendChild(metric('A', markers.a !== null ? t(markers.a) : '—', 'var(--marker-a)'));
    metrics.appendChild(metric('B', markers.b !== null ? t(markers.b) : '—', 'var(--marker-b)'));
    metrics.appendChild(metric('Δ A→B', dt !== null ? fmtTime(dt, 6) : '—', null, true));
    metrics.appendChild(metric('1 / Δ', dt ? fmtFreq(1 / dt) : '—'));
    sec.appendChild(metrics);
    if (markers.a === null) sec.appendChild(el('div', 'hint', 'Click the time ruler to drop markers A and B. Drag to move, double-click to clear.'));
    container.appendChild(sec);
  }

  WS.measurements = { render };
})(window.WS = window.WS || {});