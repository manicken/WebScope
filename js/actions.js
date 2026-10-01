/**
 * actions.js — view, channel, decoder and capture actions.
 * Ported from edgewise's actions.ts, with all FX2/sigrok/Electron device-management code
 * (refreshDevices, selectDevice, firmware dialogs, .sr/.vcd file I/O) removed — this talks to
 * WS.sources instead of a physical device list.
 */
(function (WS) {
  'use strict';
  const { get, set, makeChannels, toast } = WS.store;
  const { clampViewTo, frameRange } = WS.view;
  const { engine } = WS;

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

  /* ---- decoders ---- */
  function addDecoder(kind, config) {
    const cfg = { ...WS.decoderDefaults[kind], ...config };
    const id = get().decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    const n = get().decoders.length;
    const d = { id, kind, name: WS.decoderNames[kind], color: WS.theme.DECODER_COLORS[n % WS.theme.DECODER_COLORS.length], config: cfg, rows: WS.decoders[kind].rows(), visible: true };
    set({ decoders: [...get().decoders, d], table: { decoder: id, row: 0, focus: null } });
    engine.decode(id);
  }
  function removeDecoder(id) {
    const remaining = get().decoders.filter((d) => d.id !== id);
    const table = get().table;
    set({ decoders: remaining, table: table.decoder === id ? { decoder: remaining[0]?.id ?? null, row: 0, focus: null } : table });
  }
  function toggleDecoderVisible(id) {
    set({ decoders: get().decoders.map((d) => d.id === id ? { ...d, visible: !d.visible } : d) });
  }
  function updateDecoder(id, patch) {
    const d = get().decoders.find((x) => x.id === id);
    if (!d) return;
    const config = { ...d.config, ...patch };
    set({ decoders: get().decoders.map((x) => x.id === id ? { ...x, config } : x) });
    engine.decode(id);
  }

  /* ---- capture orchestration ---- */
  let activeSource = null;
  let growing = null; // Uint32Array being filled while a capture streams in

  function startCapture(source, {samplerate, duration, channels} = {}) {
    const total = Math.max(64, Math.round(samplerate * duration));
    growing = new Uint32Array(total);
    set({
      follow: true, markers: { a: null, b: null }, measurement: null,
      status: { ...get().status, state: 'running', samples: 0, samplerate, captureId: get().status.captureId + 1 }
    });
    activeSource = source;
    activeSource.start(
      { samplerate, duration, channels },
      /* onData */
      (chunk, offset) => {
        growing.set(chunk, offset);
        set((s) => ({ status: { ...s.status, samples: Math.min(total, offset + chunk.length) } }));
        if (get().follow) fit();
      },
      /* onDone */
      (info) => {
        engine.setBuffer(new WS.CaptureBuffer(growing.slice(0, info.samples), info.samplerate, info.channels));
        if (get().channels.length !== info.channels) set({ channels: makeChannels(info.channels) });
        set((s) => ({ status: { ...s.status, state: 'done', samples: info.samples, samplerate: info.samplerate, channels: info.channels, trigger: null } }));
        for (const d of get().decoders) engine.decode(d.id);
        if (get().follow) fit();
      },
      /* onError */
      (msg) => { set((s) => ({ status: { ...s.status, state: 'error', message: msg } })); toast(msg); }
    );
  }

  function stopCapture() {
    activeSource?.stop();
    if (growing && get().status.samples > 0) {
      const n = get().status.samples;
      engine.setBuffer(new WS.CaptureBuffer(growing.slice(0, n), get().status.samplerate, get().channels.length));
      for (const d of get().decoders) engine.decode(d.id);
    }
    set((s) => ({ status: { ...s.status, state: s.status.samples > 0 ? 'done' : 'idle' } }));
  }

  WS.actions = {
    fit, clampView, zoomAt, panBy, frameSpan, centerOn,
    cycleTrigger, updateChannel,
    addDecoder, removeDecoder, toggleDecoderVisible, updateDecoder,
    startCapture, stopCapture
  };
})(window.WS = window.WS || {});
