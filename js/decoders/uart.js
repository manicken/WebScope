/**
 * decoders/uart.js — asynchronous serial decoder.
 * Frame: idle high (or low if inverted) -> start bit -> dataBits (LSB or MSB first) ->
 * optional parity -> stopBits. Samples the middle of each bit period.
 */
(function (WS) {
  'use strict';
  const { ANN } = WS.theme;

  WS.decoders.uart = {
    rows: () => [{id:'data', label:'DATA'}],
    run(buf, cfg) {
      console.trace();
      
      const ch = cfg.channel;
      const spb = buf.samplerate / cfg.baud; // samples per bit
      const invert = !!cfg.invert;
      const get = (n) => {
        const idx = Math.max(0, Math.min(buf.length - 1, Math.round(n)));
        const v = (buf.samples[idx] >> ch) & 1;
        return invert ? 1 - v : v;
      };
      const anns = [];
      let i = 0;
      while (i < buf.length) {
        while (i < buf.length && get(i) !== 0) i++;
        if (i >= buf.length) break;
        if (i > 0 && get(i - 1) !== 1) { i++; continue; }
        const startSample = i;
        const mid = (n) => startSample + (n + 0.5) * spb;
        if (get(mid(0)) !== 0) { i = Math.max(i + 1, Math.round(startSample + spb)); continue; }
        let byte = 0;
        for (let b = 0; b < cfg.dataBits; b++) {
          const v = get(mid(1 + b));
          if (cfg.msbFirst) byte = (byte << 1) | v; else byte |= v << b;
        }
        let bitIdx = 1 + cfg.dataBits, parityOk = true;
        if (cfg.parity !== 'none') {
          const p = get(mid(bitIdx)); bitIdx++;
          let ones = 0; for (let b = 0; b < cfg.dataBits; b++) if ((byte >> b) & 1) ones++;
          parityOk = p === (cfg.parity === 'even' ? ones % 2 : 1 - (ones % 2));
        }
        let stopOk = true;
        for (let s = 0; s < cfg.stopBits; s++) if (get(mid(bitIdx + s)) !== 1) stopOk = false;
        const endSample = startSample + (bitIdx + cfg.stopBits) * spb;
        const text = cfg.format === 'hex'
          ? byte.toString(16).padStart(2, '0').toUpperCase()
          : (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : '\\x' + byte.toString(16).padStart(2, '0');
        anns.push({
          start: startSample, end: endSample,// row:0,
          class: (!parityOk || !stopOk) ? ANN.ERROR : ANN.DATA,
          text: (!parityOk ? 'PERR ' : '') + (!stopOk ? 'FERR ' : '') + text
        });
        i = Math.max(i + 1, Math.round(endSample));
      }
      return {'data':anns};
    }
  };

  WS.decoderDefaults.uart = { kind: 'uart', channel: 0, baud: 115200, dataBits: 8, parity: 'none', stopBits: 1, invert: false, msbFirst: false, format: 'ascii', signals:['channel'] };
  WS.decoderNames.uart = 'UART';
})(window.WS = window.WS || {});
