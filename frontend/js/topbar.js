(function (WS) {
  'use strict';
  const { store } = WS;

  function init(ids) {

    const rateIn = document.getElementById(ids.samplerate);
    const durIn = document.getElementById(ids.duration);
    const captureBtn = document.getElementById(ids.captureBtn);
    const fitBtn = document.getElementById(ids.fitBtn);
    const pill = document.getElementById(ids.statusPill);


    captureBtn.addEventListener('click', () => {
      if (store.get().status.state === 'running') { WS.capture.stopCapture(); captureBtn.textContent = 'Start'; }
      else {
        const samplerate = Number(rateIn.value) || 8_000_000;
        const duration = Number(durIn.value) || 0.02;
        const device = WS.sources.getSelectedInfo();
        WS.capture.startCapture(device.sourceKind, {samplerate, duration, channels:device.channels});
        captureBtn.textContent = 'Stop';
      }
    });
    fitBtn.addEventListener('click', () => {WS.waveform.fit(); });
    
    WS.store.store.subscribe((s) => {
      pill.textContent = s.status.state; pill.className = 'status-pill ' + s.status.state;
      if (s.status.state !== 'running' && captureBtn.textContent === 'Stop') captureBtn.textContent = 'Start';
    });
    WS.topbar.toggleCapture = () => captureBtn.click();
  }

  WS.topbar = { init };
})(window.WS = window.WS || {});
