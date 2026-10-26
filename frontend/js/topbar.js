(function (WS) {
  'use strict';
  const { appState } = WS;
  const { acquisition } = appState;

  /** The source's start config, from the Capture panel's settings. */
  function captureConfig(device) {
    const s = appState.captureSettings;
    const samplerate = s.samplerate.value;
    const toSamples = (sec) => Math.round(sec * samplerate);

    // the memory size limits Looping and One shot
    const cfg = { mode: s.mode.value, samplerate, channels: device.channels, memoryBytes: s.memoryMB.value * 1024 * 1024 };

    if (s.mode.value === 'timer') {
      cfg.duration = s.timerSeconds.value;
    } else if (s.mode.value === 'trigger') {
      const t = s.trigger.value, pulse = t.type === 'PulseH' || t.type === 'PulseL';
      const pre = toSamples(s.preTrigger.value), post = toSamples(s.postTrigger.value);
      cfg.triggerOn = { channel: t.channel, type: t.type, ...(pulse && { pulseLength: Math.max(1, toSamples(t.pulseWidth)) }) };
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
      WS.capture.startCapture(device.sourceKind, captureConfig(device));
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
