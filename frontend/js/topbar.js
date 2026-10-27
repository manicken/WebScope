(function (WS) {
  'use strict';
  const { appState } = WS;
  const { acquisition } = appState;

  /** The source's start config, from the Capture panel's settings. Throws Error(message) when it cannot start.
   *  channels: the captured channels (device Channel objects, in bit order); activeChannels: their device
   *  indexes, left out when all channels are captured. The trigger names device channels too. */
  function captureConfig() {
    const s = appState.captureSettings;
    const samplerate = s.samplerate.value;
    const toSamples = (sec) => Math.round(sec * samplerate);

    const deviceChannels = appState.deviceChannels.value;
    const active = new Set(s.activeChannels.value);
    const channels = deviceChannels.filter((ch) => active.has(ch.index));
    if (channels.length === 0) throw new Error('No channels are active: choose the channels to capture in the Capture panel');

    // the memory size limits Looping and One shot
    const cfg = { mode: s.mode.value, samplerate, channels, memoryBytes: s.memoryMB.value * 1024 * 1024 };
    if (channels.length < deviceChannels.length) cfg.activeChannels = channels.map((ch) => ch.index);

    if (s.mode.value === 'timer') {
      cfg.duration = s.timerSeconds.value;
    } else if (s.mode.value === 'trigger') {
      const t = s.trigger.value, pulse = t.type === 'PulseH' || t.type === 'PulseL';
      const pre = toSamples(s.preTrigger.value), post = toSamples(s.postTrigger.value);
      if (!active.has(t.channel)) {
        const name = deviceChannels.find((ch) => ch.index === t.channel)?.name.value ?? `channel ${t.channel}`;
        throw new Error(`The trigger channel ${name} is not captured: make it active or choose another trigger channel`);
      }
      // only the conditions the Capture panel shows: captured channels other than the trigger channel
      const conditions = Object.fromEntries(Object.entries(t.conditions ?? {})
        .filter(([ch]) => Number(ch) !== t.channel && active.has(Number(ch))));
      cfg.triggerOn = { channel: t.channel, type: t.type, conditions, ...(pulse && { pulseLength: Math.max(1, toSamples(t.pulseWidth)) }) };
      cfg.preTrigger = pre;
      cfg.postTrigger = post;
      cfg.duration = (pre + 1 + post) / samplerate;     // frontend allocates its buffer from this
    }
    return cfg;
  }

  function init(ids) {
    const captureBtn = document.getElementById(ids.captureBtn);
    const fitBtn = document.getElementById(ids.fitBtn);
    const pill = document.getElementById(ids.statusPill);

    captureBtn.addEventListener('click', () => {
      const st = acquisition.state.value;
      if (st === 'running' || st === 'waiting') { WS.capture.stopCapture(); return; }
      const device = WS.sources.getSelectedInfo();
      let cfg;
      try { cfg = captureConfig(); } catch (e) { WS.toast(e.message); return; }
      WS.capture.startCapture(device.sourceKind, cfg);
    });
    fitBtn.addEventListener('click', () => {WS.waveform.fit(); });

    function showState() {
      const st = acquisition.state.value;
      pill.textContent = st; pill.className = 'status-pill ' + st;
      captureBtn.textContent = st === 'running' || st === 'waiting' ? 'Stop' : 'Start';
    }
    acquisition.state.subscribe(showState);
    showState();

    WS.topbar.toggleCapture = () => captureBtn.click();
  }

  WS.topbar = { init };
})(window.WS = window.WS || {});
