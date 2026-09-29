/**
 * theme.js — shared constants used across layout, draw and store.
 */
(function (WS) {
  'use strict';

  const ANN = { DATA: 0, ADDRESS: 1, CONTROL: 2, ACK: 3, WARN: 4, ERROR: 5, DENSE: 255 };
  const RULER_H = 32, CH_H = 44, DEC_H = 30;

  const PALETTE = [
    '#ff6b9a', '#ff9f43', '#ffd43b', '#51cf66', '#22d3ee', '#4dabf7', '#9775fa', '#f783ac',
    '#ffa94d', '#a9e34b', '#3bc9db', '#748ffc', '#da77f2', '#ff8787', '#63e6be', '#e599f7'
  ];
  const DECODER_COLORS = ['#7c6cff', '#22d3ee', '#ff9f43', '#51cf66', '#ff6b9a', '#ffd43b'];
  const CLASS_COLORS = { [ANN.ADDRESS]: '#ffb020', [ANN.CONTROL]: '#4dabf7', [ANN.ACK]: '#37b24d', [ANN.WARN]: '#fd7e14', [ANN.ERROR]: '#f03e3e' };

  const THEME = {
    bg: '#0a0b0f', rowAlt: 'rgba(255,255,255,0.018)', grid: 'rgba(255,255,255,0.045)', gridMajor: 'rgba(255,255,255,0.08)',
    ruler: '#0f1116', rulerText: '#7d8394', border: 'rgba(255,255,255,0.07)', cursor: 'rgba(255,255,255,0.35)',
    markerA: '#22d3ee', markerB: '#ff9f43', trigger: '#ff5577',
    font: '11px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif',
    mono: '11px "SF Mono", "JetBrains Mono", ui-monospace, monospace'
  };

  WS.theme = { ANN, RULER_H, CH_H, DEC_H, PALETTE, DECODER_COLORS, CLASS_COLORS, THEME };
})(window.WS = window.WS || {});
