/**
 * decoders/i2c.js — basic I2C decoder. Simplified reference implementation: single merged
 * "data" row (START/STOP/address/data/ACK all as one stream), MSB-first, no clock-stretching
 * or repeated-start handling beyond treating every START the same. Replace with your own
 * decoder for anything beyond quick sanity-checking a bus.
 */
(function (WS) {
  'use strict';
  const { ANN } = WS.theme;

  WS.decoders.i2c = {
    rows: () => ['data'],
    run(buf, cfg) {
      console.trace();
      
      const sclBit = 1 << cfg.scl, sdaBit = 1 << cfg.sda;
      const sclHigh = (i) => !!(buf.samples[i] & sclBit);
      const sdaAt = (i) => (buf.samples[i] & sdaBit) ? 1 : 0;
      const anns = [];
      let inTx = false, bitBuf = 0, bitCount = 0, isAddress = true, byteStart = 0;

      for (let i = 1; i < buf.length; i++) {
        const prevScl = sclHigh(i - 1), curScl = sclHigh(i);
        const prevSda = sdaAt(i - 1), curSda = sdaAt(i);

        if (prevScl && curScl) {
          if (prevSda === 1 && curSda === 0) { // SDA falls while SCL high: START
            anns.push({ start: i, end: i+2, class: ANN.CONTROL, text: 'START' });
            inTx = true; bitBuf = 0; bitCount = 0; isAddress = true;
            continue;
          }
          if (prevSda === 0 && curSda === 1) { // SDA rises while SCL high: STOP
            anns.push({ start: i, end: i+2, class: ANN.CONTROL, text: 'STOP' });
            inTx = false;
            continue;
          }
        }

        if (inTx && !prevScl && curScl) { // rising SCL edge: sample a bit
          if (bitCount < 8) {
            if (bitCount === 0) byteStart = i;
            bitBuf = (bitBuf << 1) | curSda;
            bitCount++;
          } else {
            const ack = curSda === 0; // ACK is SDA held low
            let text;
            if (isAddress) {
              const addr = bitBuf >> 1, rw = bitBuf & 1;
              text = `0x${addr.toString(16).padStart(2, '0')} ${rw ? 'R' : 'W'}`;
              isAddress = false;
            } else {
              text = cfg.format === 'hex' ? '0x' + bitBuf.toString(16).padStart(2, '0').toUpperCase() : String(bitBuf);
            }
            let end = i + 1;
            while ( end < buf.length && sclHigh(end)) { end++; }
            while ( end < buf.length && sclHigh(end) == false) { end++; }
            anns.push({ start: byteStart, end: i, class: ANN.DATA , text: `${text}` });
            anns.push({ start: i, end, class: ack ? ANN.DATA : ANN.ERROR, text: `${(ack ? 'ACK' : ' NACK')}` });
            bitBuf = 0; bitCount = 0;
          }
        }
      }
      return {anns};
    }
  };
  WS.decoders.push(
    {
      kind:'i2c',

    }
  );
  WS.decoderDefaults.i2c = { kind: 'i2c', scl: 1, sda: 2, format: 'hex', signals:['scl', 'sda'] };
  WS.decoderNames.i2c = 'I²C';
})(window.WS = window.WS || {});
