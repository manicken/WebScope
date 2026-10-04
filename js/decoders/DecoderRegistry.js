/**
 * decoders/registry.js — shared registry populated by decoders/uart.js, i2c.js, spi.js.
 * Load this before any decoder file. Add your own protocol decoders the same way:
 * push a { rows, run } object into WS.decoders under a new kind key, and add a matching
 * default config to WS.decoderDefaults + a display name to WS.decoderNames.
 */
(function (WS) {
  'use strict';
  WS.decoderregistry = WS.decoderregistry || [];
  WS.decoders = WS.decoders || [];
  WS.decoderDefaults = WS.decoderDefaults || {};
  WS.decoderNames = WS.decoderNames || {};
})(window.WS = window.WS || {});
