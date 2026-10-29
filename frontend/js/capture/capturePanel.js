/**
 * capturepanel/capturePanel.js — "Capture" right-panel tab, modelled on Logic 2's device panel:
 * the device picker (#devicePicker from index.html, run by sources.js), channel chips (All / Clear), samplerate, mode tabs (Looping / One shot / Timer / Trigger), trigger pattern +
 * channel, capture duration after / before the trigger, memory buffer size.
 *
 * Shows and edits appState.captureSettings (see appState.js). The channel chips are the device's
 * channels (appState.deviceChannels): a chip is the channel's `visible`, so it also shows / hides the
 * channel's waveform row, and the visible ones are captured (captureSettings.activeChannels follows them).
 * What the device cannot do with the current settings is grayed out, with why (see captureLimits.js).
 * Times are always SECONDS.
 * The rightpanel calls render() when one of the values in watch() changes.
 */
(function (WS) {
  'use strict';
  const { appState } = WS;
  const { fmtTime, fmtRate } = WS.format;

  const PALETTE = ['#e8e8e8', '#b08968', '#ff6b81', '#ffa94d', '#f2e03c', '#51cf66', '#4dabf7', '#b197fc'];
  const MODES = [['looping', 'Looping'], ['oneshot', 'One shot'], ['timer', 'Timer'], ['trigger', 'Trigger']];
  const ico = (d) => `<svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const TYPES = [
    { id: 'L2H',    label: 'Rising edge',  icon: ico('M2 11h6V3h8') },
    { id: 'H2L',    label: 'Falling edge', icon: ico('M2 3h6v8h8') },
    { id: 'PulseH', label: 'Pulse high',   icon: ico('M2 11h4V3h6v8h4') },
    { id: 'PulseL', label: 'Pulse low',    icon: ico('M2 3h4v8h6V3h4') },
  ];
  const DEVICE_ICON = '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M24 8 42 17 24 26 6 17Z"/><path d="M6 17v10l18 9 18-9V17"/><path d="M24 26v10"/><circle cx="24" cy="17" r="2.5"/></svg>';
  const DEFAULT_PULSE_WIDTH = 1e-5;
  const CHANNEL_PRESETS = [1, 2, 4, 8, 16, 24, 32];
  const MEMORY_STEPS_MB = [128, 256, 512, 1024, 2048, 3072, 4096, 6144, 8192];
  const settings = appState.captureSettings;

  // plain copies, set at the start of every rebuild(): the state the panel is drawn from
  let cfg = null;         // { samplerate, mode, trigger, ... }
  let lim = null;         // what the device can do with these settings, see captureLimits.js
  let noteEl = null;      // shows lim.note
  let channels = [];      // the device's channels: [{ index, name, color, active }]
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

  function readSettings() {
    const out = {};
    for (const [key, v] of Object.entries(settings)) out[key] = v.value;
    return out;
  }
  const readChannels = () => {
    const active = new Set(settings.activeChannels.value);
    return appState.deviceChannels.value.map((ch) =>
      ({ index: ch.index, name: ch.name.value, color: ch.color.value, active: active.has(ch.index) }));
  };

  const deviceSettings = () => WS.sources?.getSelectedInfo()?.settings;
  const keyOf = () => JSON.stringify([readSettings(), readChannels(), patternMenuOpen, conditionsOpen, !!deviceInfoHandler, !!deviceSettings()]);

  const setSetting = (key, value) => settings[key].set(value);
  const setTrigger = (patch) => settings.trigger.set({ ...settings.trigger.value, ...patch });
  // a chip is the device channel's `visible` (shared with its waveform row, so hiding the row turns
  // the chip off too); activeChannels follows it, see watch()
  function setChannelActive(index, active) {
    appState.deviceChannels.value.find((ch) => ch.index === index)?.visible.set(active);
  }
  const syncActiveChannels = () =>
    settings.activeChannels.set(appState.deviceChannels.value.filter((ch) => ch.visible.value).map((ch) => ch.index));

  /** For text fields: they already show the new value, so the panel is not rebuilt under the user's
   *  pointer (a replaced element would swallow the next click). `write` changes the setting. */
  function setQuietly(write) {
    write();
    lastKey = keyOf();
    lim = WS.currentLimits();
    showNote();
  }

  function showNote() {
    noteEl.textContent = lim.note ?? '';
    noteEl.className = 'cp-note' + (lim.bad ? ' bad' : '');
    noteEl.hidden = !lim.note;
  }

  function setAllChannelsActive(active) {
    appState.deviceChannels.value.forEach((ch) => ch.visible.set(active));
  }

  /** Preset: only the first `count` channels of the device (from its first channel on). */
  function setFirstChannelsActive(count) {
    appState.deviceChannels.value.forEach((ch, k) => ch.visible.set(k < count));
  }

  /** Called once by the rightpanel: `changed` is called when anything the panel shows changes. */
  function watch(changed) {
    ReactiveValue.subscribeItems(appState.deviceChannels, (ch) => [ch.visible], syncActiveChannels);
    ReactiveValue.subscribeAll(Object.values(settings), changed);
    ReactiveValue.subscribeItems(appState.deviceChannels, (ch) => [ch.name, ch.color], changed);
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
    // the same element every time, so its options and handlers (sources.js) stay
    txt.append(document.getElementById('devicePicker'));
    if (deviceInfoHandler || deviceSettings()) {
      const row = el('div', 'cp-pills');
      if (deviceInfoHandler) row.append(pill('Device Information', () => deviceInfoHandler()));
      // the device's own settings (device.settings, see backend/deviceSettings.js)
      if (deviceSettings()) row.append(pill('Device Settings', () => DeviceSettingsDialog.Show({ device: WS.sources.getSelectedInfo() })));
      txt.append(row);
    }
    s.append(txt);
    return s;
  }

  /** Channel count presets (the ones the device has); shows the preset the chips match, else "Custom". */
  function presetSelect() {
    const sel = el('select', 'cp-preset'); sel.title = 'Capture the first channels';
    const counts = CHANNEL_PRESETS.filter((n) => n <= channels.length);
    const activeCount = channels.filter((c) => c.active).length;
    const matches = channels.every((c, k) => c.active === (k < activeCount));
    const current = matches && counts.includes(activeCount) ? activeCount : null;
    if (current === null) { const o = el('option'); o.value = ''; o.textContent = 'Custom'; o.disabled = true; sel.appendChild(o); }
    for (const n of counts) { const o = el('option'); o.value = n; o.textContent = `${n} ch`; sel.appendChild(o); }
    sel.value = current === null ? '' : String(current);
    sel.addEventListener('change', () => setFirstChannelsActive(Number(sel.value)));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    return sel;
  }

  function digitalSection() {
    const s = el('div', 'cp-block');
    const tools = el('div', 'cp-pills');
    tools.append(
      presetSelect(),
      pill('All', () => setAllChannelsActive(true), 'Capture all channels'),
      pill('Clear', () => setAllChannelsActive(false), 'Capture no channels'),
    );
    s.appendChild(label('Digital', tools));
    const chips = el('div', 'cp-chips');
    for (const ch of channels) {
      const b = el('button', 'cp-chip' + (ch.active ? ' on' : '')); b.textContent = String(ch.index);
      b.style.setProperty('--c', colorOf(ch)); b.title = (ch.name ?? '') + (ch.active ? ' (captured)' : ' (not captured)');
      b.addEventListener('click', () => setChannelActive(ch.index, !ch.active));
      chips.appendChild(b);
    }
    s.appendChild(chips);

    const sel = el('select', 'cp-select cp-samplerate');
    const rates = cfg.samplerates.includes(cfg.samplerate) || cfg.samplerate == null ? cfg.samplerates : [...cfg.samplerates, cfg.samplerate];
    for (const r of rates) { const o = el('option'); o.value = r; o.textContent = fmtRate(r); sel.appendChild(o); }
    if (cfg.samplerate != null) sel.value = String(cfg.samplerate);
    sel.addEventListener('change', () => setSetting('samplerate', Number(sel.value)));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    s.appendChild(sel);
    return s;
  }

  function modeTabs() {
    const seg = el('div', 'cp-seg');
    for (const [id, text] of MODES) {
      const why = lim.modes[id];
      const b = el('button', 'cp-seg-btn' + (cfg.mode === id ? ' on' : '') + (why ? ' dis' : ''));
      b.textContent = text;
      if (why) b.title = why;
      b.addEventListener('click', () => { if (!why) setSetting('mode', id); });
      seg.appendChild(b);
    }
    return seg;
  }

  function timerSection() {
    const s = el('div', 'cp-sec');
    s.append(label('Stop recording after'), timeField(cfg.timerSeconds, (v) => setQuietly(() => setSetting('timerSeconds', v)), { positive: true }));
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
        const why = lim.triggerTypes[t.id];
        const it = el('button', 'cp-dd-item' + (t.id === cur.id ? ' on' : '') + (why ? ' dis' : ''), `${t.icon}<span>${t.label}</span>`);
        if (why) it.title = why;
        it.addEventListener('click', (e) => { e.stopPropagation(); if (why) return; patternMenuOpen = false; setTrigger({ type: t.id }); rebuild(true); });
        menu.appendChild(it);
      }
      wrap.appendChild(menu);
    }
    return wrap;
  }

  function triggerSection() {
    const s = el('div', 'cp-sec');
    s.append(label('Capture duration before trigger'), timeField(cfg.preTrigger, (v) => setQuietly(() => setSetting('preTrigger', v))));
    
    s.append(label('Capture duration after trigger'), timeField(cfg.postTrigger, (v) => setQuietly(() => setSetting('postTrigger', v))));
    
    const reset = pill('reset', () => {
      const first = channels.find((x) => x.active);
      setSetting('trigger', { channel: first?.index ?? 0, type: 'L2H', pulseWidth: DEFAULT_PULSE_WIDTH, conditions: {} });
    }, 'Reset the trigger pattern');
    s.appendChild(label('Pattern and Channel', reset));

    const row = el('div', 'cp-row');
    row.appendChild(patternDropdown());
    const sel = el('select', 'cp-select');
    const list = channels.filter((c) => c.active);
    if (!list.some((c) => c.index === cfg.trigger.channel)) { const miss = channels.find((c) => c.index === cfg.trigger.channel); if (miss) list.push(miss); }
    for (const c of list) { const o = el('option'); o.value = c.index; o.textContent = `${String(c.index).padStart(2, '0')}. ${c.name ?? 'Channel ' + c.index}` + (c.active ? '' : ' (not captured)'); sel.appendChild(o); }
    sel.value = String(cfg.trigger.channel);
    sel.addEventListener('change', () => setTrigger({ channel: Number(sel.value) }));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    row.appendChild(sel);
    s.appendChild(row);

    if (cfg.trigger.type === 'PulseH' || cfg.trigger.type === 'PulseL') {
      s.append(label('Pulse length'), timeField(cfg.trigger.pulseWidth ?? DEFAULT_PULSE_WIDTH, (v) => setQuietly(() => setTrigger({ pulseWidth: v })), { positive: true }));
    }

    

    s.appendChild(conditionsBlock());

    return s;
  }

  function conditionsBlock() {
    const box = el('div', 'cp-cond');
    const head = el('button', 'cp-cond-head'); head.innerHTML = `<span class="cp-caret">${conditionsOpen ? '▾' : '▸'}</span><span>Other channel conditions</span>`;
    head.addEventListener('click', () => { conditionsOpen = !conditionsOpen; rebuild(true); });
    box.appendChild(head);
    if (!conditionsOpen) return box;
    if (lim.conditions) { box.appendChild(el('div', 'cp-note', '')).textContent = lim.conditions; return box; }
    const conditions = cfg.trigger.conditions ?? {};
    for (const ch of channels.filter((c) => c.active && c.index !== cfg.trigger.channel)) {
      const row = el('div', 'cp-cond-row');
      const nm = el('span', 'cp-cond-name');
      nm.innerHTML = `<i style="color:${colorOf(ch)}"></i>`;
      nm.firstChild.textContent = String(ch.index).padStart(2, '0') + '.';
      nm.append(document.createTextNode(' ' + (ch.name ?? 'Channel ' + ch.index)));
      row.appendChild(nm);
      for (const [v, text] of [['lo', 'Lo'], ['hi', 'Hi']]) {
        const b = el('button', 'cp-cond-btn' + (conditions[ch.index] === v ? ' on' : ''));
        b.textContent = text;
        b.addEventListener('click', () => {
          const next = { ...conditions };
          if (next[ch.index] === v) delete next[ch.index];
          else next[ch.index] = v;
          setTrigger({ conditions: next });
        });
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    return box;
  }

  function memorySection() {
    const steps = [...MEMORY_STEPS_MB].sort((a, b) => a - b);
    const cur = cfg.memoryMB;
    const prev = [...steps].reverse().find((v) => v < cur), next = steps.find((v) => v > cur);
    const fmt = (mb) => (mb >= 1024 ? [String(+(mb / 1024).toFixed(2)), 'GB'] : [String(mb), 'MB']);
    const row = el('div', 'cp-mem');
    row.appendChild(el('span', 'cp-mem-label', 'Memory buffer size'));
    const ctl = el('div', 'cp-stepper');
    const minus = el('button', 'cp-step', '−'); minus.disabled = prev === undefined; minus.title = 'Smaller';
    const plus = el('button', 'cp-step', '+'); plus.disabled = next === undefined; plus.title = 'Larger';
    minus.addEventListener('click', () => setSetting('memoryMB', prev));
    plus.addEventListener('click', () => setSetting('memoryMB', next));
    const [num, unit] = fmt(cur);
    const val = el('div', 'cp-step-val'); val.innerHTML = '<b></b><span></span>'; val.firstChild.textContent = num; val.lastChild.textContent = unit;
    ctl.append(minus, val, plus);
    row.appendChild(ctl);
    return withSampleNote(row, cur);
  }

  /** How many samples the memory holds: a sample takes 1, 2 or 4 bytes by the highest captured channel
   *  (bit n = channel n, see backend/channels.js), also when the channels below it are not captured. */
  function withSampleNote(row, memoryMB) {
    const active = channels.filter((c) => c.active);
    if (!active.length) return row;
    const highest = active.at(-1);
    const bytes = CaptureBuffer.sampleType(highest.index + 1).BYTES_PER_ELEMENT;
    const samples = Math.floor((memoryMB * 1024 * 1024) / bytes);
    const note = el('div', 'cp-note', '');
    note.textContent = `${samples.toLocaleString()} samples: ${bytes} byte${bytes > 1 ? 's' : ''} per sample up to ${highest.name ?? 'channel ' + highest.index}. ` +
      'A sample is 1, 2 or 4 bytes by the highest captured channel (up to the 8th / 16th / 32nd), also when the ones below it are not captured: ' +
      'connect signals to the lowest channels to fit the most samples.';
    const box = el('div', 'cp-sec');
    box.append(row, note);
    return box;
  }

  /* ---------------- assembly ---------------- */
  function rebuild(force) {
    if (!host) return;
    const key = keyOf();
    if (!force && key === lastKey) return;
    lastKey = key;
    cfg = readSettings();
    channels = readChannels();
    lim = WS.currentLimits();
    const kids = [headerSection(), divider(), digitalSection(), divider()];
    const body = el('div', 'cp-block cp-modes');
    body.appendChild(modeTabs());
    noteEl = body.appendChild(el('div'));
    showNote();
    if (cfg.mode === 'timer') body.appendChild(timerSection());
    if (cfg.mode === 'trigger') body.appendChild(triggerSection());
    // Looping keeps the newest samples that fit, One shot stops when the memory is full
    if (cfg.mode === 'looping' || cfg.mode === 'oneshot') body.appendChild(memorySection());
    kids.push(body);
    host.replaceChildren(...kids);
  }

  // keep typing in the device picker away from global shortcuts, like the panel's other selects
  document.getElementById('deviceSelect')?.addEventListener('keydown', (e) => e.stopPropagation());

  document.addEventListener('pointerdown', (e) => {
    if (patternMenuOpen && !e.target.closest?.('.cp-dd')) { patternMenuOpen = false; rebuild(true); }
  });

  WS.capturePanel = {
    render({ container }) {
      if (host !== container) { host = container; lastKey = ''; }
      rebuild(false);
    },
    watch,
    onDeviceInfo(fn) { deviceInfoHandler = fn; rebuild(false); },
  };
})(window.WS = window.WS || {});
