(function (WS) {
  'use strict';
  const { store } = WS;

  function init(ids) {

    //const rateIn = document.getElementById(ids.samplerate);
   // const durIn = document.getElementById(ids.duration);
    const captureBtn = document.getElementById(ids.captureBtn);
    const fitBtn = document.getElementById(ids.fitBtn);
    const pill = document.getElementById(ids.statusPill);


    /*captureBtn.addEventListener('click', () => {
      if (store.get().status.state === 'running') { WS.capture.stopCapture(); captureBtn.textContent = 'Start'; }
      else {
        //const samplerate = Number(rateIn.value) || 8_000_000;
        //const duration = Number(durIn.value) || 0.02;
        const device = WS.sources.getSelectedInfo();
        const mode = WS.capturePanel.getConfig().mode;

        const cfg = {
          samplerate:WS.store.get().status.samplerate, 
          duration:(mode!=='looping')?WS.store.get().status.captureDuration:undefined, 
          channels:device.channels,
          triggerOn:mode === 'trigger'
        };
        console.log(cfg);
        WS.capture.startCapture(device.sourceKind, cfg);
        captureBtn.textContent = 'Stop';
      }
    });*/
    captureBtn.addEventListener('click', () => {
      const st = store.get().status.state;
      if (st === 'running' || st === 'waiting') { WS.capture.stopCapture(); captureBtn.textContent = 'Start'; return; }

      const panel  = WS.capturePanel.getConfig();
      const device = WS.sources.getSelectedInfo();
      const samplerate = panel.samplerate;
      const toSamples = (sec) => Math.round(sec * samplerate);

      const cfg = { samplerate, channels: device.channels };

      if (panel.mode === 'timer') {
        cfg.duration = panel.timer.seconds;
      } else if (panel.mode === 'trigger') {
        const t = panel.trigger, pulse = t.type === 'PulseH' || t.type === 'PulseL';
        const pre = toSamples(panel.preTrigger), post = toSamples(panel.postTrigger);
        cfg.triggerOn = { channel: t.channel, type: t.type, ...(pulse && { pulseLength: Math.max(1, toSamples(t.pulseWidth)) }) };
        cfg.preTrigger = pre;
        cfg.postTrigger = post;
        cfg.duration = (pre + 1 + post) / samplerate;     // frontend allocates its buffer from this
      } else {
        //return WS.store.toast('Looping is not supported yet');
      }

      WS.capture.startCapture(device.sourceKind, cfg);
      captureBtn.textContent = 'Stop';
    });
    fitBtn.addEventListener('click', () => {WS.waveform.fit(); });
    
    WS.store.store.subscribe(({state}) => {
      pill.textContent = state.status.state; pill.className = 'status-pill ' + state.status.state;
      if (state.status.state !== 'running' && captureBtn.textContent === 'Stop') captureBtn.textContent = 'Start';
    });
    WS.topbar.toggleCapture = () => captureBtn.click();
  }

  WS.topbar = { init };
})(window.WS = window.WS || {});
