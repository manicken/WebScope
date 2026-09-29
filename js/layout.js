/**
 * layout.js — visible rows (channels + decoder rows), top to bottom.
 * Ported from edgewise's src/renderer/src/layout.ts (decoderChannels folded in from actions.ts
 * so this file has no dependency on capture/decoder actions).
 */
(function (WS) {
  'use strict';
  const { CH_H, DEC_H } = WS.theme;

  const DECODER_FIELD_KEYS = { uart: ['channel'], i2c: ['scl', 'sda'], spi: ['clk', 'mosi', 'miso', 'cs'] };

  /** Channels a decoder reads, for placing its rows under the last one. */
  function decoderChannels(cfg) {
    const keys = DECODER_FIELD_KEYS[cfg.kind] || [];
    return keys.map((k) => cfg[k]).filter((v) => typeof v === 'number');
  }

  /** Visible rows, top to bottom. Decoder rows sit under the last channel they read. */
  function layoutRows(channels, decoders) {
    const rows = [];
    let y = 0;
    const placed = new Set();
    const visible = channels.filter((c) => c.visible);
    const lastVisible = visible.length ? visible[visible.length - 1].index : -1;
    const addDecoder = (d) => {
      placed.add(d.id);
      d.rows.forEach((label, row) => { rows.push({ kind: 'decoder', dec: d, row, label, y, h: DEC_H }); y += DEC_H; });
    };
    for (const ch of visible) {
      rows.push({ kind: 'channel', ch, y, h: CH_H });
      y += CH_H;
      for (const d of decoders) {
        if (!d.visible || placed.has(d.id)) continue;
        const chans = decoderChannels(d.config).filter((i) => channels[i]?.visible);
        const last = chans.length ? Math.max(...chans) : -1;
        if (last === ch.index || (last === -1 && ch.index === lastVisible)) addDecoder(d);
      }
    }
    for (const d of decoders) if (d.visible && !placed.has(d.id)) addDecoder(d);
    return rows;
  }

  WS.layout = { decoderChannels, layoutRows };
})(window.WS = window.WS || {});
