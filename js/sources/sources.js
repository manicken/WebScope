/**
 * sources.js — capture sources. DemoSource generates a synthetic capture so you can test
 * with no hardware; WebSocketSource is the reference client for your Rust gateway.
 *
 * WebSocketSource protocol (adjust to match your backend):
 *   client -> server: {"type":"start","sampleRate":N,"channels":N,"samples":N}  (JSON text)
 *   server -> client: {"type":"info","sampleRate":N,"channels":N}               (JSON text, once)
 *   server -> client: binary frames, each a run of little-endian uint32 sample words,
 *                      appended in order to the capture buffer
 *   server -> client: {"type":"done","samples":N} | {"type":"error","message":"..."}
 */
(function (WS) {
  'use strict';

  WS.sources = { DemoSource, WebSocketSource };
})(window.WS = window.WS || {});
