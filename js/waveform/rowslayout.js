
(function (WS) {
  'use strict';

  const { CH_H, DEC_H } = WS.theme;

  /** Channels a decoder reads, for placing its rows under the last one. */
  function decoderChannels(cfg) {
    //console.log(cfg);
    const keys = cfg.signals || [];
    return keys.map((k) => cfg[k]).filter((v) => typeof v === 'number');
  }

  /**
   * Visible rows, top to bottom. Channels are shown in index order, except that all channels a
   * decoder reads are pulled together at the position of its lowest one, with the decoder's rows
   * directly under them. A channel already placed for an earlier decoder (e.g. a shared clock)
   * stays where it is. Decoders that read no visible channel go last.
   */
  function layoutRows(channels, decoders) {
    const rows = [];
    let y = 0;
    const placedDec = new Set();
    const placedCh = new Set();
    const visible = channels.filter((c) => c.visible);
 
    // Visible channels a decoder reads, ascending and unique.
    const readBy = (d) => [...new Set(decoderChannels(d.config).filter((i) => channels[i]?.visible))].sort((p, q) => p - q);
 
    const addChannel = (ch) => {
      placedCh.add(ch.index);
      rows.push({ kind: 'channel', ch, y, h: CH_H });
      y += CH_H;
    };
    const addDecoder = (d) => {
      placedDec.add(d.id);
      d.rows.forEach((label, row) => { rows.push({ kind: 'decoder', dec: d, row, label, y, h: DEC_H }); y += DEC_H; });
    };
    // Decoders whose channels are now all on screen go directly under what was just placed.
    const placeReadyDecoders = () => {
      for (const d of decoders) {
        if (!d.visible || placedDec.has(d.id)) continue;
        const chans = readBy(d);
        // a decoder reading no visible channel waits until every channel is placed
        const ready = chans.length ? chans.every((i) => placedCh.has(i)) : placedCh.size === visible.length;
        if (ready) addDecoder(d);
      }
    };
 
    for (const ch of visible) {
      if (placedCh.has(ch.index)) continue;
      const owner = decoders.find((d) => d.visible && !placedDec.has(d.id) && readBy(d).includes(ch.index));
      const block = owner ? readBy(owner).filter((i) => !placedCh.has(i)) : [ch.index];
      block.forEach((i) => addChannel(channels[i]));
      placeReadyDecoders();
    }
    for (const d of decoders) if (d.visible && !placedDec.has(d.id)) addDecoder(d);
    //console.log(rows);
    return rows;
  }

  WS.uiRowsLayout = {
        layoutRows
  };
})(window.WS = window.WS || {});