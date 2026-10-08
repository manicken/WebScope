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
  function decoderChannels(decoder) {
    //console.log(cfg);
    const keys = decoder.signals || [];
    return keys.map((k) => decoder[k]).filter((v) => typeof v === 'number');
  }

  /**
   * Build the visible rows, top to bottom: channel rows and decoder rows.
   *
   * Two settings on a decoder instance control where its rows go:
   *
   *   d.rowLayout   'grouped' (default)
   *                   All of the decoder's rows sit together, directly under the last channel
   *                   of its block (see step 1).
   *                 'bySignal'
   *                   Each row sits directly under the channel it belongs to, so e.g. SPI can
   *                   show the MOSI annotations right after the MOSI signal.
   *
   *   d.rowSignals  Only used by 'bySignal'. An array parallel to d.rows: entry n names the
   *                 config field of the signal that row n belongs to (e.g. ['mosi', 'miso']).
   *                 A row with no entry, or whose channel is hidden, is placed like 'grouped'.
   *
   * The channel order is the same in both modes; rowLayout only decides where decoder rows go.
   */
    function layoutRows(channels, decoders) {
        //console.log(channels, decoders);
        const visibleChannels = channels.filter((c) => c.visible);

        // Visible channels a decoder reads: unique and in ascending channel order.
        const readBy = (d) => [...new Set(decoderChannels(d).filter((i) => channels[i]?.visible))].sort((p, q) => p - q);

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
            const owner = decoders.find((d) => d.visible && readBy(d).includes(ch.index));

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

        // ---- Step 2: decide which channel each decoder row goes under ------------------------
        const rowsUnder = new Map(channelOrder.map((idx) => [idx, []])); // channel index -> decoder rows placed under it
        const rowsAtEnd = [];                                            // only used when no channel is visible at all

        // Channel a row is bound to ('bySignal' only), or undefined if it has no usable binding.
        const boundChannel = (d, row) => {
            if (d.rowLayout !== 'bySignal') return undefined;
            const field = d.rowSignals?.[row];
            const idx = field == null ? undefined : d.config[field];
            return typeof idx === 'number' && channels[idx]?.visible ? idx : undefined;
        };

        const lastChannel = channelOrder[channelOrder.length - 1];

        for (const d of decoders) {
            if (!d.visible) continue;
            const chans = readBy(d);

            // Where 'grouped' rows go: under the end of the block holding the decoder's lowest-placed
            // channel. A decoder that reads no visible channel goes under the last channel instead.
            const lowest = chans.length ? chans.reduce((a, b) => (position.get(b) > position.get(a) ? b : a)) : undefined;
            const groupEnd = chans.length ? blockEnd.get(lowest) : lastChannel;

            // Visiting decoders in list order and rows in row order keeps rows under one channel ordered.

            d.rows().forEach((_, row) => {
                const under = boundChannel(d, row) ?? groupEnd;
                (rowsUnder.get(under) ?? rowsAtEnd).push({ dec: d, row });   // no channels at all -> bottom
            });
        }

        // ---- Step 3: emit the rows top to bottom, assigning y positions ----------------------
        const out = [];
        let y = 0;
        const pushDecoderRows = (list) => {
            for (const { dec, row } of list) {
                out.push({ kind: 'decoder', dec, row:row, gutter: dec.rows()[row], y, h: DEC_H });
                y += DEC_H;
            }
        };
        for (const idx of channelOrder) {
            out.push({ kind: 'channel', ch: channels[idx], y, h: CH_H });
            y += CH_H;
            pushDecoderRows(rowsUnder.get(idx));
        }
        pushDecoderRows(rowsAtEnd);
        return out;
    }

  WS.uiRowsLayout = { decoderChannels, layoutRows };
})(window.WS = window.WS || {});