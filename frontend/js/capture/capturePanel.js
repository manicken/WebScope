/**
 * capturepanel/capturePanel.js — "Capture" right-panel tab, modelled on Logic 2's device panel:
 * channel chips (All / Clear), samplerate, mode tabs (Looping / Timer / Trigger), trigger pattern +
 * channel, capture duration after / before the trigger, memory buffer size.
 *
 * This file is only the GUI. It does not touch the store or any capture code:
 *   you push the current configuration in            WS.capturePanel.setConfig(cfg)    (partial is fine)
 *   it tells you when the user changes something     WS.capturePanel.onChange((cfg, key) => …)
 * The panel updates itself immediately on user input and then calls the handler; call setConfig() again
 * if you want to correct/veto the change (e.g. clamp a value). Times are always SECONDS in the config.
 *
 *   cfg = {
 *     deviceName: 'Logic',
 *     channels:   [{ index:0, name:'Channel 0', color:'#e8e8e8', enabled:true }, …],
 *     samplerates:[4e6, 8e6, …],  samplerate: 24e6,                       // Hz
 *     mode: 'trigger',                                                    // 'looping' | 'timer' | 'trigger'
 *     timer:   { seconds: 1 },                                            // "Stop recording after"
 *     trigger: { channel: 0, type: 'L2H',                                 // 'L2H' | 'H2L' | 'PulseH' | 'PulseL'
 *                pulseWidth: 1e-5,                                        // s, PulseH / PulseL only
 *                conditions: { 1:'lo', 2:'hi' } },                        // optional: shows "Other channel conditions"
 *     preTrigger: 1, postTrigger: 1,                                      // s before / after the trigger
 *     memoryMB: 3072, memoryStepsMB: [128, 256, …],                       // buffer size stepper
 *   }
 *   key (2nd arg of the handler) = 'channels' | 'samplerate' | 'mode' | 'timer' | 'trigger' | 'preTrigger' | 'postTrigger' | 'memoryMB'
 *
 * Register it like the other panels: WS.rightpanel.register({ id:'capture', title:'Capture', icon, render: (c) => WS.capturePanel.render(c) })
 */
(function (WS) {
  'use strict';
  const { fmtTime, fmtRate } = WS.format;

  const PALETTE = ['#e8e8e8', '#b08968', '#ff6b81', '#ffa94d', '#f2e03c', '#51cf66', '#4dabf7', '#b197fc'];
  const MODES = [['looping', 'Looping'], ['timer', 'Timer'], ['trigger', 'Trigger']];
  const ico = (d) => `<svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const TYPES = [
    { id: 'L2H',    label: 'Rising edge',  icon: ico('M2 11h6V3h8') },
    { id: 'H2L',    label: 'Falling edge', icon: ico('M2 3h6v8h8') },
    { id: 'PulseH', label: 'Pulse high',   icon: ico('M2 11h4V3h6v8h4') },
    { id: 'PulseL', label: 'Pulse low',    icon: ico('M2 3h4v8h6V3h4') },
  ];
  const DEVICE_ICON = '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M24 8 42 17 24 26 6 17Z"/><path d="M6 17v10l18 9 18-9V17"/><path d="M24 26v10"/><circle cx="24" cy="17" r="2.5"/></svg>';

  const DEFAULTS = {
    deviceName: '', channels: [], samplerates: [], samplerate: null,
    mode: 'timer',
    timer: { seconds: 1 },
    trigger: { channel: 0, type: 'L2H', pulseWidth: 1e-5 },
    preTrigger: 1, postTrigger: 1,
    memoryMB: 1024, memoryStepsMB: [128, 256, 512, 1024, 2048, 3072, 4096, 6144, 8192],
  };

  let cfg = structuredClone(DEFAULTS);
  const handlers = [];
  let deviceInfoHandler = null;
  let host = null, lastKey = '';
  let patternMenuOpen = true, conditionsOpen = true;

  /* ---------------- tiny helpers ---------------- */
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  const colorOf = (ch) => ch.color ?? PALETTE[ch.index % PALETTE.length];

  function parseTime(str) {
    const m = String(str).trim().replace(',', '.').match(/^(\d*\.?\d+(?:e[+-]?\d+)?)\s*(s|ms|us|µs|μs|ns)?$/i);
    if (!m) return null;
    const mult = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ns: 1e-9 }[(m[2] ?? 's').toLowerCase()];
    return parseFloat(m[1]) * mult;
  }

  const keyOf = () => JSON.stringify([cfg, patternMenuOpen, conditionsOpen, !!deviceInfoHandler]);

  /** Apply a user change and notify. `redraw:false` for text fields: they update themselves, so the DOM
   *  is not replaced under the user's pointer (a replaced element would swallow the next click). */
  function change(key, mutate, redraw = true) {
    mutate(cfg);
    if (redraw) rebuild(true); else lastKey = keyOf();
    for (const h of handlers) h(structuredClone(cfg), key);
  }

  /* ---------------- building blocks ---------------- */
  function label(text, extra) {
    const r = el('div', 'cp-label'); r.append(el('span', '', text));
    if (extra) r.appendChild(extra);
    return r;
  }
  function pill(text, onClick, title) {
    const b = el('button', 'cp-pill'); b.textContent = text; if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  function divider() { return el('div', 'cp-divider'); }

  /** Text field showing "1 s"; accepts "250us", "2.5 ms", "0.5" (= seconds). Commits on Enter / blur, Esc reverts. */
  function timeField(value, onCommit, { positive = false } = {}) {
    const inp = el('input', 'cp-field'); inp.type = 'text'; inp.spellcheck = false;
    let current = value;
    inp.value = fmtTime(current, 4);
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('blur', () => {
      const v = parseTime(inp.value);
      if (v !== null && v >= 0 && !(positive && v === 0) && v !== current) { current = v; onCommit(v); }
      inp.value = fmtTime(current, 4);
    });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();                                   // keep typing away from global shortcuts
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'Escape') { inp.value = fmtTime(current, 4); inp.blur(); }
    });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
    return inp;
  }

  /* ---------------- sections ---------------- */
  function headerSection() {
    const s = el('div', 'cp-header');
    s.append(el('div', 'cp-device-icon', DEVICE_ICON));
    const txt = el('div', 'cp-header-text');
    txt.append(el('div', 'cp-device-name', ''));
    txt.firstChild.textContent = cfg.deviceName || 'Capture';
    if (deviceInfoHandler) { const row = el('div', 'cp-pills'); row.append(pill('Device Information', () => deviceInfoHandler())); txt.append(row); }
    s.append(txt);
    return s;
  }

  function digitalSection() {
    const s = el('div', 'cp-block');
    const tools = el('div', 'cp-pills');
    tools.append(
      pill('All', () => change('channels', (c) => c.channels.forEach((ch) => { ch.enabled = true; }))),
      pill('Clear', () => change('channels', (c) => c.channels.forEach((ch) => { ch.enabled = false; }))),
    );
    s.appendChild(label('Digital', tools));
    const chips = el('div', 'cp-chips');
    for (const ch of cfg.channels) {
      const on = ch.enabled !== false;
      const b = el('button', 'cp-chip' + (on ? ' on' : '')); b.textContent = String(ch.index);
      b.style.setProperty('--c', colorOf(ch)); b.title = ch.name ?? '';
      b.addEventListener('click', () => change('channels', (c) => { const t = c.channels.find((x) => x.index === ch.index); t.enabled = !(t.enabled !== false); }));
      chips.appendChild(b);
    }
    s.appendChild(chips);

    const sel = el('select', 'cp-select cp-samplerate');
    const rates = cfg.samplerates.includes(cfg.samplerate) || cfg.samplerate == null ? cfg.samplerates : [...cfg.samplerates, cfg.samplerate];
    for (const r of rates) { const o = el('option'); o.value = r; o.textContent = fmtRate(r); sel.appendChild(o); }
    if (cfg.samplerate != null) sel.value = String(cfg.samplerate);
    sel.addEventListener('change', () => change('samplerate', (c) => { c.samplerate = Number(sel.value); }));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    s.appendChild(sel);
    return s;
  }

  function modeTabs() {
    const seg = el('div', 'cp-seg');
    for (const [id, text] of MODES) {
      const b = el('button', 'cp-seg-btn' + (cfg.mode === id ? ' on' : ''));
      b.textContent = text;
      b.addEventListener('click', () => { if (cfg.mode !== id) change('mode', (c) => { c.mode = id; }); });
      seg.appendChild(b);
    }
    return seg;
  }

  function timerSection() {
    const s = el('div', 'cp-sec');
    s.append(label('Stop recording after'), timeField(cfg.timer.seconds, (v) => change('timer', (c) => { c.timer.seconds = v; }, false), { positive: true }));
    return s;
  }

  function patternDropdown() {
    const cur = TYPES.find((t) => t.id === cfg.trigger.type) ?? TYPES[0];
    const wrap = el('div', 'cp-dd');
    const btn = el('button', 'cp-dd-btn', `${cur.icon}<span class="cp-caret">▾</span>`);
    btn.title = cur.label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); patternMenuOpen = !patternMenuOpen; rebuild(true); });
    wrap.appendChild(btn);
    if (patternMenuOpen) {
      const menu = el('div', 'cp-dd-menu');
      for (const t of TYPES) {
        const it = el('button', 'cp-dd-item' + (t.id === cur.id ? ' on' : ''), `${t.icon}<span>${t.label}</span>`);
        it.addEventListener('click', (e) => { e.stopPropagation(); patternMenuOpen = false; change('trigger', (c) => { c.trigger.type = t.id; }); });
        menu.appendChild(it);
      }
      wrap.appendChild(menu);
    }
    return wrap;
  }

  function triggerSection() {
    const s = el('div', 'cp-sec');
    const reset = pill('reset', () => change('trigger', (c) => {
      const first = c.channels.find((x) => x.enabled !== false);
      c.trigger = { channel: first?.index ?? 0, type: 'L2H', pulseWidth: DEFAULTS.trigger.pulseWidth, ...(c.trigger.conditions ? { conditions: {} } : {}) };
    }), 'Reset the trigger pattern');
    s.appendChild(label('Pattern and Channel', reset));

    const row = el('div', 'cp-row');
    row.appendChild(patternDropdown());
    const sel = el('select', 'cp-select');
    const list = cfg.channels.filter((c) => c.enabled !== false);
    if (!list.some((c) => c.index === cfg.trigger.channel)) { const miss = cfg.channels.find((c) => c.index === cfg.trigger.channel); if (miss) list.push(miss); }
    for (const c of list) { const o = el('option'); o.value = c.index; o.textContent = `${String(c.index).padStart(2, '0')}. ${c.name ?? 'Channel ' + c.index}` + (c.enabled === false ? ' (off)' : ''); sel.appendChild(o); }
    sel.value = String(cfg.trigger.channel);
    sel.addEventListener('change', () => change('trigger', (c) => { c.trigger.channel = Number(sel.value); }));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    row.appendChild(sel);
    s.appendChild(row);

    if (cfg.trigger.type === 'PulseH' || cfg.trigger.type === 'PulseL') {
      s.append(label('Pulse length'), timeField(cfg.trigger.pulseWidth ?? DEFAULTS.trigger.pulseWidth, (v) => change('trigger', (c) => { c.trigger.pulseWidth = v; }, false), { positive: true }));
    }

    s.appendChild(conditionsBlock());

    s.append(label('Capture duration after trigger'), timeField(cfg.postTrigger, (v) => change('postTrigger', (c) => { c.postTrigger = v; }, false)));
    s.append(label('Capture duration before trigger'), timeField(cfg.preTrigger, (v) => change('preTrigger', (c) => { c.preTrigger = v; }, false)));
    return s;
  }

  function conditionsBlock() {
    const box = el('div', 'cp-cond');
    const head = el('button', 'cp-cond-head'); head.innerHTML = `<span class="cp-caret">${conditionsOpen ? '▾' : '▸'}</span><span>Other channel conditions</span>`;
    head.addEventListener('click', () => { conditionsOpen = !conditionsOpen; rebuild(true); });
    box.appendChild(head);
    if (!conditionsOpen) return box;
    cfg.trigger.conditions = cfg.trigger.conditions ?? [];
    for (const ch of cfg.channels.filter((c) => c.enabled !== false && c.index !== cfg.trigger.channel)) {
      const row = el('div', 'cp-cond-row');
      const nm = el('span', 'cp-cond-name');
      nm.innerHTML = `<i style="color:${colorOf(ch)}"></i>`;
      nm.firstChild.textContent = String(ch.index).padStart(2, '0') + '.';
      nm.append(document.createTextNode(' ' + (ch.name ?? 'Channel ' + ch.index)));
      row.appendChild(nm);
      for (const [v, text] of [['lo', 'Lo'], ['hi', 'Hi']]) {
        const b = el('button', 'cp-cond-btn' + (cfg.trigger.conditions?.[ch.index] === v ? ' on' : ''));
        b.textContent = text;
        b.addEventListener('click', () => change('trigger', (c) => {
          if (c.trigger.conditions[ch.index] === v)
            delete c.trigger.conditions[ch.index];
          else c.trigger.conditions[ch.index] = v;
        }));
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    return box;
  }

  function memorySection() {
    const steps = [...cfg.memoryStepsMB].sort((a, b) => a - b);
    const cur = cfg.memoryMB;
    const prev = [...steps].reverse().find((v) => v < cur), next = steps.find((v) => v > cur);
    const fmt = (mb) => (mb >= 1024 ? [String(+(mb / 1024).toFixed(2)), 'GB'] : [String(mb), 'MB']);
    const row = el('div', 'cp-mem');
    row.appendChild(el('span', 'cp-mem-label', 'Memory buffer size'));
    const ctl = el('div', 'cp-stepper');
    const minus = el('button', 'cp-step', '−'); minus.disabled = prev === undefined; minus.title = 'Smaller';
    const plus = el('button', 'cp-step', '+'); plus.disabled = next === undefined; plus.title = 'Larger';
    minus.addEventListener('click', () => change('memoryMB', (c) => { c.memoryMB = prev; }));
    plus.addEventListener('click', () => change('memoryMB', (c) => { c.memoryMB = next; }));
    const [num, unit] = fmt(cur);
    const val = el('div', 'cp-step-val'); val.innerHTML = '<b></b><span></span>'; val.firstChild.textContent = num; val.lastChild.textContent = unit;
    ctl.append(minus, val, plus);
    row.appendChild(ctl);
    return row;
  }

  /* ---------------- assembly ---------------- */
  function rebuild(force) {
    if (!host) return;
    const key = keyOf();
    if (!force && key === lastKey) return;
    lastKey = key;
    const kids = [headerSection(), divider(), digitalSection(), divider()];
    const body = el('div', 'cp-block cp-modes');
    body.appendChild(modeTabs());
    if (cfg.mode === 'timer') body.appendChild(timerSection());
    if (cfg.mode === 'trigger') body.appendChild(triggerSection());
    body.appendChild(memorySection());
    kids.push(body);
    host.replaceChildren(...kids);
  }

  document.addEventListener('pointerdown', (e) => {
    if (patternMenuOpen && !e.target.closest?.('.cp-dd')) { patternMenuOpen = false; rebuild(true); }
  });

  function merge(base, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if ((k === 'timer' || k === 'trigger') && v && typeof v === 'object') base[k] = { ...base[k], ...structuredClone(v) };
      else base[k] = structuredClone(v);
    }
    return base;
  }

  WS.capturePanel = {
    render({container, state, keys, subkey}) { 
        if (keys) return;
        //if (keys?.includes('hover') || keys?.includes('mesurements')) return;

        if (host !== container) { host = container; lastKey = ''; } 
        rebuild(false);
    },
    setConfig(patch) { merge(cfg, patch); rebuild(false); },
    getConfig() { return structuredClone(cfg); },
    onChange(fn) { handlers.push(fn); return () => handlers.splice(handlers.indexOf(fn), 1); },
    onDeviceInfo(fn) { deviceInfoHandler = fn; rebuild(false); },
  };
})(window.WS = window.WS || {});
