/**
 * layout.js — visible rows (channels + decoder rows), top to bottom.
 * Ported from edgewise's src/renderer/src/layout.ts (decoderChannels folded in from actions.ts
 * so this file has no dependency on capture/decoder actions).
 * Rows are arranged per decoder, see layoutRows.
 */
(function (WS) {
  'use strict';
  const { CH_H, DEC_H } = WS.theme;

  /** Channel indexes a decoder reads, taken from the config fields named in cfg.signals. */
  function decoderChannels(cfg) {
    console.log(cfg);
    const keys = cfg.signals || [];
    return keys.map((k) => cfg[k]).filter((v) => typeof v === 'number');
  }

  /**
   * Build the visible rows, top to bottom: channel rows and decoder rows.
   *
   * A decoder declares its rows in d.rows, each as { id, label, anchor?, placement? }:
   *
   *   anchor      What the row is shown next to. One of
   *                 { signal: 'mosi' }                 the channel chosen in config field 'mosi'
   *                 { row: 'addr' }                    another row of the same decoder
   *                 { decoder: 'source', row: 'data' } a row of another decoder; config field
   *                                                    'source' holds that decoder's id, and
   *                                                    `row` defaults to its last row
   *   placement   'after' (default) or 'before': below or above the anchor.
   *
   * A row without an anchor, or whose anchor cannot be found (channel hidden or not chosen,
   * decoder removed or hidden, unknown row id), is shown under the last channel of the
   * decoder's block (see step 1).
   *
   * The channel order never depends on the rows; the rows only decide where they are inserted.
   */
  function layoutRows(channels, decoders) {
    const visibleChannels = channels.filter((c) => c.visible);
    const visibleDecoders = decoders.filter((d) => d.visible);

    // Visible channels a decoder reads: unique and in ascending channel order.
    const readBy = (d) => [...new Set(decoderChannels(d.config).filter((i) => channels[i]?.visible))].sort((p, q) => p - q);

    // ---- Step 1: decide the order of the channel rows ------------------------------------
    // Channels normally keep their index order. The exception: when we reach a channel that a
    // decoder reads, we pull all of that decoder's other channels up next to it, so they are
    // never split by unrelated channels. Such a group of channels is called a "block".
    // A channel that no decoder reads is a block of its own.
    const blocks = [];                 // e.g. [[0, 5], [1], [2], [3], [4], [6], [7]]
    const placed = new Set();          // channels that already belong to a block
    for (const ch of visibleChannels) {
      if (placed.has(ch.index)) continue;

      // The first decoder (in list order) that reads this channel owns the block.
      const owner = visibleDecoders.find((d) => readBy(d).includes(ch.index));

      // The block holds the owner's channels that are not already in an earlier block,
      // so a channel shared with an earlier decoder (e.g. a common clock) stays where it was.
      const block = owner ? readBy(owner).filter((i) => !placed.has(i)) : [ch.index];
      block.forEach((i) => placed.add(i));
      blocks.push(block);
    }

    const channelOrder = blocks.flat();                                   // final top-to-bottom order
    const position = new Map(channelOrder.map((idx, pos) => [idx, pos])); // channel index -> row position
    const blockEnd = new Map();                                           // channel index -> last channel of its block
    for (const block of blocks) block.forEach((idx) => blockEnd.set(idx, block[block.length - 1]));

    // ---- Step 2: hang every row on the node it is anchored to ----------------------------
    // Every channel row and every decoder row becomes a node with two lists of decoder rows
    // that are shown directly before / after it. Anchoring a row to another decoder row makes
    // chains possible: channel -> row -> row of another decoder -> ...
    const channelNode = new Map(channelOrder.map((idx) => [idx, { channel: idx, before: [], after: [] }]));
    const rowNode = new Map();                 // 'decoderId:rowIndex' -> node
    const rowKey = (d, row) => `${d.id}:${row}`;
    for (const d of visibleDecoders) {
      d.rows.forEach((_, row) => rowNode.set(rowKey(d, row), { dec: d, row, before: [], after: [] }));
    }

    // The node an anchor points at, or undefined if it cannot be resolved.
    const anchorNode = (d, anchor) => {
      if (!anchor) return undefined;
      if (anchor.signal !== undefined) return channelNode.get(d.config[anchor.signal]);

      if (anchor.decoder !== undefined) {
        const target = visibleDecoders.find((x) => x.id === d.config[anchor.decoder]);
        if (!target) return undefined;
        const row = anchor.row === undefined ? target.rows.length - 1 : target.rows.findIndex((r) => r.id === anchor.row);
        return rowNode.get(rowKey(target, row));
      }

      const row = d.rows.findIndex((r) => r.id === anchor.row);        // { row } = same decoder
      return rowNode.get(rowKey(d, row));
    };

    const lastChannel = channelOrder[channelOrder.length - 1];
    const rowsAtEnd = [];                      // only used when no channel is visible at all

    for (const d of visibleDecoders) {
      const chans = readBy(d);

      // Fallback node: the end of the block holding the decoder's lowest-placed channel.
      // A decoder that reads no visible channel uses the last channel instead.
      const lowest = chans.length ? chans.reduce((a, b) => (position.get(b) > position.get(a) ? b : a)) : undefined;
      const fallback = channelNode.get(chans.length ? blockEnd.get(lowest) : lastChannel);

      // Visiting decoders in list order and rows in row order keeps rows hanging on one node ordered.
      d.rows.forEach((def, row) => {
        const me = rowNode.get(rowKey(d, row));
        const target = anchorNode(d, def.anchor);

        if (target && target !== me) {
          target[def.placement === 'before' ? 'before' : 'after'].push(me);
        } else if (fallback) {
          fallback.after.push(me);
        } else {
          rowsAtEnd.push(me);                  // no channels at all -> bottom
        }
      });
    }

    // ---- Step 3: emit the rows top to bottom, assigning y positions ----------------------
    const out = [];
    let y = 0;
    const emitted = new Set();                 // guards against anchor cycles (A after B after A)

    // Emit a node's "before" rows, the node itself, then its "after" rows.
    const emit = (node) => {
      if (emitted.has(node)) return;
      emitted.add(node);

      node.before.forEach(emit);
      if (node.dec) {
        out.push({ kind: 'decoder', dec: node.dec, row: node.row, label: node.dec.rows[node.row].label, y, h: DEC_H });
        y += DEC_H;
      } else {
        out.push({ kind: 'channel', ch: channels[node.channel], y, h: CH_H });
        y += CH_H;
      }
      node.after.forEach(emit);
    };

    channelOrder.forEach((idx) => emit(channelNode.get(idx)));
    rowsAtEnd.forEach(emit);
    rowNode.forEach(emit);                     // rows only reachable through an anchor cycle go last
    return out;
  }

  WS.layout = { decoderChannels, layoutRows };
})(window.WS = window.WS || {});
