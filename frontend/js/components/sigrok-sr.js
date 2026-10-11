// sigrok-sr.js — sigrok session files (.sr, version 2) and VCD export.
//
// Uses JSZip for the container (npm i jszip). Works in browsers (via a bundler
// or by swapping the import for the global `JSZip`) and in Node. ES module.
//
// Sample format (same as sigrok "logic" and the Edgewise Rust code):
//   - `data` is a Uint8Array of packed samples, `unitsize` bytes per sample,
//     little-endian, channel N = bit N.  unitsize = ceil(channels / 8).
//
// API
//   saveSr({ samplerate, channels, names, data, unitsize? })  -> Promise<Uint8Array>
//   loadSr(bytes)                                             -> Promise<Capture>
//   exportVcd(capture)                                        -> string
//   vcdChunks(capture)                                        -> Generator<string>
//   rateString(hz) / parseRate(str)
//
// Capture = { samplerate, channels, names, unitsize, length, data }

/*import JSZip from "jszip";*

const MAX_CHANNELS = 16;
const CHUNK_BYTES = 4 * 1024 * 1024;

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- rates

export function rateString(hz) {
  if (hz >= 1e9 && hz % 1e9 === 0) return `${hz / 1e9} GHz`;
  if (hz >= 1e6 && hz % 1e6 === 0) return `${hz / 1e6} MHz`;
  if (hz >= 1e3 && hz % 1e3 === 0) return `${hz / 1e3} kHz`;
  return `${hz} Hz`;
}

export function parseRate(str) {
  let s = String(str).trim().replace(/hz$/i, "").trim();
  if (!s) return null;
  let mult = 1;
  switch (s[s.length - 1]) {
    case "k": case "K": mult = 1e3; s = s.slice(0, -1); break;
    case "M": case "m": mult = 1e6; s = s.slice(0, -1); break;
    case "G": case "g": mult = 1e9; s = s.slice(0, -1); break;
  }
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

// ---------------------------------------------------------------- .sr save

/**
 * @param {{samplerate:number, channels:number, names?:string[], data:Uint8Array, unitsize?:number}} cap
 * @returns {Promise<Uint8Array>} contents of the .sr file
 */
async function saveSr(cap) {
  const { samplerate, channels, data } = cap;
  const names = cap.names ?? [];
  const unitsize = cap.unitsize ?? Math.max(1, Math.ceil(channels / 8));
  if (data.length % unitsize !== 0) throw new Error("data length is not a multiple of unitsize");

  let meta =
    `[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\n` +
    `total probes=${channels}\nsamplerate=${rateString(samplerate)}\ntotal analog=0\n`;
  for (let i = 0; i < channels; i++) meta += `probe${i + 1}=${names[i] ?? `D${i}`}\n`;
  meta += `unitsize=${unitsize}\n`;

  const zip = new JSZip();
  zip.file("version", "2");
  zip.file("metadata", meta);
  const step = Math.floor(CHUNK_BYTES / unitsize) * unitsize;
  for (let o = 0, i = 1; o < data.length; o += step, i++) {
    zip.file(`logic-1-${i}`, data.subarray(o, Math.min(o + step, data.length)));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- .sr load

/**
 * @param {Uint8Array|ArrayBuffer|Blob} input contents of a .sr file
 * @returns {Promise<{samplerate:number, channels:number, names:string[], unitsize:number, length:number, data:Uint8Array}>}
 *   Channels are capped at 16; `unitsize` is 1 (<=8 channels) or 2 (9-16),
 *   regardless of what the file used (extra bytes are dropped, missing ones zero-filled).
 */
async function loadSr(input) {
  const zip = await JSZip.loadAsync(input);
  const metaFile = zip.file("metadata");
  if (!metaFile) throw new Error('not a sigrok session file (no "metadata" entry)');
  const meta = await metaFile.async("string");

  const kv = new Map();
  let section = "";
  for (let line of meta.split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith("[")) section = line;
    else {
      const eq = line.indexOf("=");
      if (eq > 0 && section === "[device 1]") kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }

  const int = (k, d) => { const n = parseInt(kv.get(k), 10); return Number.isFinite(n) ? n : d; };
  const probes = int("total probes", 8);
  const fileUnit = Math.max(1, int("unitsize", 1));
  const samplerate = (kv.has("samplerate") && parseRate(kv.get("samplerate"))) || 1_000_000;
  const base = kv.get("capturefile") || "logic-1";
  const channels = Math.min(probes, MAX_CHANNELS);
  const names = Array.from({ length: channels }, (_, i) => kv.get(`probe${i + 1}`) ?? `D${i}`);
  const keep = channels > 8 ? 2 : 1;

  // Chunk files: "<base>" or "<base>-<n>", in numeric order.
  const parts = [];
  for (const n of Object.keys(zip.files)) {
    if (n === base) parts.push([0, n]);
    else if (n.startsWith(base + "-")) {
      const idx = Number(n.slice(base.length + 1));
      if (Number.isInteger(idx)) parts.push([idx, n]);
    }
  }
  parts.sort((a, b) => a[0] - b[0]);

  const out = [];
  for (const [, name] of parts) {
    const buf = await zip.file(name).async("uint8array");
    if (fileUnit === keep) { out.push(buf); continue; }
    const n = Math.floor(buf.length / fileUnit);
    const conv = new Uint8Array(n * keep);
    const copy = Math.min(keep, fileUnit);
    for (let i = 0; i < n; i++) for (let b = 0; b < copy; b++) conv[i * keep + b] = buf[i * fileUnit + b];
    out.push(conv);
  }
  const data = concat(out);
  return { samplerate, channels, names, unitsize: keep, length: data.length / keep, data };
}

// ---------------------------------------------------------------- VCD export

/** Yields the VCD text in ~64 KB pieces (good for streaming to a file/download). Supports up to 16 channels. */
function* vcdChunks(cap) {
  const { channels, samplerate, data } = cap;
  const names = cap.names ?? [];
  const unitsize = cap.unitsize ?? Math.max(1, Math.ceil(channels / 8));
  if (channels > MAX_CHANNELS) throw new Error("VCD export supports up to 16 channels");
  const length = data.length / unitsize;
  const id = (i) => String.fromCharCode(33 + i);

  let hdr = "$version WebScope $end\n$timescale 1 ps $end\n$scope module logic $end\n";
  for (let i = 0; i < channels; i++) hdr += `$var wire 1 ${id(i)} ${(names[i] ?? `D${i}`).replace(/ /g, "_")} $end\n`;
  hdr += "$upscope $end\n$enddefinitions $end\n";
  yield hdr;
  if (length === 0) return;

  const rate = Math.max(1, samplerate);
  const psPerSample = 1e12 / rate;
  const exact = Number.isInteger(psPerSample);
  const bigRate = BigInt(rate);
  const time = (i) => {
    if (exact && i * psPerSample <= Number.MAX_SAFE_INTEGER) return String(i * psPerSample);
    return String((BigInt(i) * 1_000_000_000_000n) / bigRate);
  };
  const get = unitsize === 1 ? (i) => data[i] : (i) => data[i * unitsize] | (data[i * unitsize + 1] << 8);

  let prev = get(0);
  let buf = `#0\n`;
  for (let c = 0; c < channels; c++) buf += `${(prev >> c) & 1}${id(c)}\n`;

  for (let i = 1; i < length; i++) {
    const v = get(i);
    if (v === prev) continue;
    buf += `#${time(i)}\n`;
    const diff = prev ^ v;
    for (let c = 0; c < channels; c++) if ((diff >> c) & 1) buf += `${(v >> c) & 1}${id(c)}\n`;
    prev = v;
    if (buf.length > 65536) { yield buf; buf = ""; }
  }
  buf += `#${time(length)}\n`;
  yield buf;
}

function exportVcd(cap) {
  return [...vcdChunks(cap)].join("");
}
