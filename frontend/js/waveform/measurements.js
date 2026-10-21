(function (WS) {
  'use strict';

  const { fmtTime, fmtFreq } = WS.format;
  const { store } = WS;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  let ui = null;

  function build() {
    const clearBtn = el('button', 'link', 'Clear');
    clearBtn.addEventListener('click', () => store.set({ markers: { a: null, b: null } }));

    // plain panel section, no minimize card (the panel itself is toggled by its tab icon)
    const root = el('section', 'section');
    const head = el('div', 'section-head');
    head.append(el('span', null, 'Measurementst'), clearBtn);

    const metrics = el('div', 'metrics');
    const metric = (label, color, strong) => {
      const m = el('div', 'metric' + (strong ? ' strong' : ''));
      const l = el('span', 'metric-label', label); if (color) l.style.color = color;
      const v = el('span', 'metric-value mono', '—');
      m.append(l, v);
      metrics.appendChild(m);
      return v;
    };

    const values = {
      cursor: metric('Cursor'),
      a: metric('A', 'var(--marker-a)'),
      b: metric('B', 'var(--marker-b)'),
      dt: metric('Δ A→B', null, true),
      freq: metric('1 / Δ'),
    };
    const hint = el('div', 'hint', 'Click the time ruler to drop markers A and B. Drag to move, double-click to clear.');

    root.append(head, metrics, hint);
    ui = { root, clearBtn, values, hint };
  }

  /* ============================== Timing ============================== */
  function render(container) {
    if (!ui) build();

    const { markers, status, hover } = store.get();
    const origin = status.trigger ?? 0;
    const t = (s) => fmtTime((s - origin) / status.samplerate, 6);
    const dt = markers.a !== null && markers.b !== null ? Math.abs(markers.b - markers.a) / status.samplerate : null;

    ui.clearBtn.style.display = (markers.a !== null || markers.b !== null) ? '' : 'none';
    ui.values.cursor.textContent = hover ? t(hover.sample) : '—';
    ui.values.a.textContent = markers.a !== null ? t(markers.a) : '—';
    ui.values.b.textContent = markers.b !== null ? t(markers.b) : '—';
    ui.values.dt.textContent = dt !== null ? fmtTime(dt, 6) : '—';
    ui.values.freq.textContent = dt ? fmtFreq(1 / dt) : '—';
    ui.hint.style.display = markers.a === null ? '' : 'none';

    if (ui.root.parentNode !== container) {
      container.innerHTML = '';
      container.appendChild(ui.root);
    }
  }

  WS.measurements = { render };
})(window.WS = window.WS || {});