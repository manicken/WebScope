/**
 * decoders/spi.js — basic SPI decoder. Simplified reference implementation: samples MOSI/MISO
 * on the clock edge selected by CPOL/CPHA, groups them into `wordBits`-wide words while CS is
 * active (or continuously if no CS channel is set), and emits one merged "data" annotation per
 * word. Replace with your own decoder for multi-word bursts, duplex framing, etc.
 */
(function (WS) {
  'use strict';
  const { ANN } = WS.theme;

  WS.decoders.spi = {
    rows: () => ['data'],
    run(engine, cfg) {
      const buf = engine.getRootSource();
      const clkBit = 1 << cfg.clk;
      const mosiBit = cfg.mosi != null ? 1 << cfg.mosi : null;
      const misoBit = cfg.miso != null ? 1 << cfg.miso : null;
      const csBit = cfg.cs != null ? 1 << cfg.cs : null;

      const leadingRising = cfg.cpol === 0;
      const sampleOnLeading = cfg.cpha === 0;
      const sampleRising = sampleOnLeading ? leadingRising : !leadingRising;
      const csActive = (word) => csBit === null ? true : (cfg.csActiveLow ? !(word & csBit) : !!(word & csBit));

      const anns = [];
      let mosiWord = 0, misoWord = 0, bitCount = 0, wordStart = 0, active = false;

      for (let i = 1; i < buf.length; i++) {
        const wasActive = active;
        active = csActive(buf.samples[i]);
        if (!wasActive && active) { mosiWord = 0; misoWord = 0; bitCount = 0; }
        if (wasActive && !active) { bitCount = 0; } // drop partial word on CS release
        if (!active) continue;

        const prevClk = !!(buf.samples[i - 1] & clkBit), curClk = !!(buf.samples[i] & clkBit);
        const rising = !prevClk && curClk, falling = prevClk && !curClk;
        if ((sampleRising && rising) || (!sampleRising && falling)) {
          const mb = mosiBit !== null ? ((buf.samples[i] & mosiBit) ? 1 : 0) : 0;
          const sb = misoBit !== null ? ((buf.samples[i] & misoBit) ? 1 : 0) : 0;
          if (bitCount === 0) wordStart = i;
          if (cfg.msbFirst) { mosiWord = (mosiWord << 1) | mb; misoWord = (misoWord << 1) | sb; }
          else { mosiWord |= mb << bitCount; misoWord |= sb << bitCount; }
          bitCount++;
          if (bitCount >= cfg.wordBits) {
            const digits = Math.ceil(cfg.wordBits / 4);
            const fmt = (v) => cfg.format === 'hex' ? '0x' + v.toString(16).padStart(digits, '0').toUpperCase() : String(v);
            let text = mosiBit !== null ? fmt(mosiWord) : '';
            if (misoBit !== null) text += (text ? ' / ' : '') + 'MISO ' + fmt(misoWord);
            anns.push({ start: wordStart, end: i, row: 0, class: ANN.DATA, text });
            mosiWord = 0; misoWord = 0; bitCount = 0;
          }
        }
      }
      return {anns};
    }
  };

  WS.decoderDefaults.spi = { kind: 'spi', clk: 3, mosi: 4, miso: 5, cs: 6, csActiveLow: true, cpol: 0, cpha: 0, wordBits: 8, msbFirst: true, format: 'hex' };
  WS.decoderNames.spi = 'SPI';
})(window.WS = window.WS || {});
