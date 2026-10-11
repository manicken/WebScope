/**
 * layout.js — visible rows (channels + decoder rows), top to bottom.
 * Ported from edgewise's src/renderer/src/layout.ts
 * so this file has no dependency on capture/decoder
 * Rows are arranged per decoder, see layoutRows.
 */
(function (WS) {
  'use strict';
  const { CH_H, DEC_H } = WS.theme;

  /** Channel indexes a decoder reads, taken from the config fields named in cfg.signals. */
  function decoderChannels(decoder) {
    const keys = decoder.signals || [];
    return keys.map((k) => decoder[k]).filter((v) => typeof v === 'number');
  }

  /**
   * Build the visible rows, top to bottom: channel rows and decoder rows.
   *
   * A decoder declares its rows in d.rows(), each as { id, label, anchor?, placement? }:
   *
   *   anchor      What the row is shown next to. One of
   *                 { signal: 'mosi' }                 the channel chosen in config field 'mosi'
   *                 { row: 'addr' }                    another row of the same decoder
   *                 { decoder: 'source', row: 'data' } a row of another decoder; config field
   *                                                    'source' holds that decoder's id, and
   *                                                    `row` defaults to its last row's id
   *   placement   'after' (default) or 'before': below or above the anchor.
   */
  function layoutRows(channels, decoders) {
    const visibleChannels = channels.filter((c) => c.visible);
    const visibleDecoders = decoders.filter((d) => d.visible);

    // Visible channels a decoder reads: unique and in ascending channel order.
    const readBy = (d) => [...new Set(decoderChannels(d).filter((i) => channels[i]?.visible))].sort((p, q) => p - q);

    // ---- Step 1: decide the order of the channel rows ------------------------------------
    const blocks = [];                 
    const placed = new Set();          
    for (const ch of visibleChannels) {
      if (placed.has(ch.index)) continue;

      const owner = visibleDecoders.find((d) => readBy(d).includes(ch.index));
      const block = owner ? readBy(owner).filter((i) => !placed.has(i)) : [ch.index];
      block.forEach((i) => placed.add(i));
      blocks.push(block);
    }

    const channelOrder = blocks.flat();                                   
    const position = new Map(channelOrder.map((idx, pos) => [idx, pos])); 
    const blockEnd = new Map();                                           
    for (const block of blocks) block.forEach((idx) => blockEnd.set(idx, block[block.length - 1]));

    // ---- Step 2: hang every row on the node it is anchored to ----------------------------
    const channelNode = new Map(channelOrder.map((idx) => [idx, { channel: idx, before: [], after: [] }]));
    const rowNode = new Map();                 // 'decoderId:rowId' -> node
    const rowKey = (d, rowId) => `${d.id}:${rowId}`;

    // Registrera alla noder baserat på radens ID istället för dess index
    for (const d of visibleDecoders) {
      d.rows().forEach((rowDef) => {
        rowNode.set(rowKey(d, rowDef.id), { dec: d, rowDef, before: [], after: [] });
      });
    }

    // Resolva noden som ett ankare pekar på
    const anchorNode = (d, anchor) => {
      if (!anchor) return undefined;
      if (anchor.signal !== undefined) return channelNode.get(d.cfg[anchor.signal]);

      if (anchor.decoder !== undefined) {
        const target = visibleDecoders.find((x) => x.id === d.cfg[anchor.decoder]);
        if (!target) return undefined;
        
        // Om inget specifikt row-id angetts, ta ID:t från sista raden i mål-dekodern
        const targetRows = target.rows();
        const targetRowId = anchor.row === undefined 
          ? targetRows[targetRows.length - 1]?.id 
          : anchor.row;
          
        return rowNode.get(rowKey(target, targetRowId));
      }

      // Samma dekoder ({ row }) -> matcha direkt mot row id
      return rowNode.get(rowKey(d, anchor.row));
    };

    const lastChannel = channelOrder[channelOrder.length - 1];
    const rowsAtEnd = [];                      

    for (const d of visibleDecoders) {
      const chans = readBy(d);

      const lowest = chans.length ? chans.reduce((a, b) => (position.get(b) > position.get(a) ? b : a)) : undefined;
      const fallback = channelNode.get(chans.length ? blockEnd.get(lowest) : lastChannel);

      d.rows().forEach((def) => {
        const me = rowNode.get(rowKey(d, def.id));
        const target = anchorNode(d, def.anchor);

        if (target && target !== me) {
          target[def.placement === 'before' ? 'before' : 'after'].push(me);
        } else if (fallback) {
          fallback.after.push(me);
        } else {
          rowsAtEnd.push(me);                  
        }
      });
    }

    // ---- Step 3: emit the rows top to bottom, assigning y positions ----------------------
    const out = [];
    let y = 0;
    const emitted = new Set();                 

    const emit = (node) => {
      if (emitted.has(node)) return;
      emitted.add(node);

      node.before.forEach(emit);
      if (node.dec) {
        out.push({ 
          kind: 'decoder', 
          dec: node.dec, 
          rowId: node.rowDef.id, // Skickar med ID istället för index-nummer
          gutter: node.rowDef, 
          y, 
          h: DEC_H 
        });
        y += DEC_H;
      } else {
        out.push({ kind: 'channel', ch: channels[node.channel], y, h: CH_H });
        y += CH_H;
      }
      node.after.forEach(emit);
    };

    channelOrder.forEach((idx) => emit(channelNode.get(idx)));
    rowsAtEnd.forEach(emit);
    rowNode.forEach(emit);                     
    return out;
  }

  WS.uiRowsLayout = { decoderChannels, layoutRows };
})(window.WS = window.WS || {});
