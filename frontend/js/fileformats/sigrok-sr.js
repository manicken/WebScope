// sigrok-sr.js — sigrok session files (.sr, version 2) and VCD export.
//
// No dependencies: a small built-in ZIP reader/writer on top of the native
// CompressionStream / DecompressionStream. Works in browsers and Node 18+. ES module.
// readZip/writeZip are exported too, for building project files (zip of plain files).
//
// Sample format (same as sigrok "logic"): unitsize = ceil(channels / 8) bytes per
// sample, little-endian, channel N = bit N. Up to 32 channels.
//   saveSr input `data` can be either
//     - a Uint8Array / ArrayBuffer of already packed bytes (unitsize bytes per sample), or
//     - any other typed array (Uint16Array, Uint32Array, Int32Array...) or plain Array
//       with ONE SAMPLE PER ELEMENT; only the low unitsize bytes of each element are saved.
//   loadSr returns packed bytes; unpackSamples(cap) gives a Uint32Array, one sample per element.
//
// API
//   saveSr({ samplerate, channels, names, data, unitsize? })  -> Promise<Uint8Array>
//   loadSr(bytes)                                             -> Promise<Capture>
//   exportVcd(capture)                                        -> string
//   vcdChunks(capture)                                        -> Generator<string>
//   unpackSamples(capture)                                    -> Uint32Array
//   rateString(hz) / parseRate(str)
//   writeZip(entries, opts) / readZip(bytes)                  (generic zip helpers)
//
// Capture = { samplerate, channels, names, unitsize, length, data }

const MAX_CHANNELS = 32;
const CHUNK_BYTES = 4 * 1024 * 1024;

// Normalise any typed array / DataView / ArrayBuffer / plain array to a Uint8Array
// view of the same bytes, so e.g. a Uint16Array, a Buffer or an array created in another
// realm (worker/iframe) is handled the same way as a plain Uint8Array.
function toBytes(d) {
  if (d instanceof Uint8Array && d.constructor === Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer || Object.prototype.toString.call(d) === "[object ArrayBuffer]") return new Uint8Array(d);
  if (Array.isArray(d)) return Uint8Array.from(d);
  throw new TypeError("sample data must be a typed array, ArrayBuffer or array of bytes");
}

// Turn user sample data into packed bytes (unitsize bytes per sample, little-endian).
// Uint8Array / ArrayBuffer / DataView are taken as already packed. Any other typed array
// or plain Array is one sample per element; only the low `unitsize` bytes are kept.
function packSamples(d, unitsize) {
  if (d instanceof ArrayBuffer || Object.prototype.toString.call(d) === "[object ArrayBuffer]") return new Uint8Array(d);
  const tag = Object.prototype.toString.call(d);
  if (tag === "[object Uint8Array]" || tag === "[object Uint8ClampedArray]" || tag === "[object DataView]") return toBytes(d);
  if (!ArrayBuffer.isView(d) && !Array.isArray(d)) throw new TypeError("sample data must be a typed array, ArrayBuffer or Array");
  if (unitsize > 4) throw new RangeError("element-per-sample input supports at most 32 channels");
  const out = new Uint8Array(d.length * unitsize);
  for (let i = 0, o = 0; i < d.length; i++) {
    const v = d[i] >>> 0;
    for (let b = 0; b < unitsize; b++) out[o++] = (v >>> (8 * b)) & 0xff;
  }
  return out;
}

/** Packed capture -> Uint32Array, one sample per element (channel N = bit N). */
function unpackSamples(cap) {
  const { data, unitsize } = cap;
  const n = Math.floor(data.length / unitsize);
  const out = new Uint32Array(n);
  for (let i = 0, o = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < unitsize; b++) v |= data[o++] << (8 * b);
    out[i] = v >>> 0;
  }
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- rates

function rateString(hz) {
  if (hz >= 1e9 && hz % 1e9 === 0) return `${hz / 1e9} GHz`;
  if (hz >= 1e6 && hz % 1e6 === 0) return `${hz / 1e6} MHz`;
  if (hz >= 1e3 && hz % 1e3 === 0) return `${hz / 1e3} kHz`;
  return `${hz} Hz`;
}

function parseRate(str) {
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

// ---------------------------------------------------------------- ZIP reader/writer (native deflate)
// Uses the built-in CompressionStream/DecompressionStream("deflate-raw"): native zlib
// speed, and off the main thread in browsers.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipeThrough(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const deflateRaw = (d) => pipeThrough(d, new CompressionStream("deflate-raw"));
const inflateRaw = (d) => pipeThrough(d, new DecompressionStream("deflate-raw"));

/**
 * Build a ZIP file. Entries are compressed in parallel; an entry that doesn't
 * shrink is stored instead.
 * @param {{name:string, data:Uint8Array|string}[]} entries  (strings are stored as UTF-8 text;
 *   names may contain "/" for folders, e.g. "decoders/uart.js")
 * @param {{compress?:boolean, onProgress?:(percent:number)=>void}} [opts]
 * @returns {Promise<Uint8Array>}
 */
async function writeZip(entries, opts = {}) {
  const { compress = true, onProgress } = opts;
  const enc = new TextEncoder();
  let done = 0;
  const packed = await Promise.all(
    entries.map(async ({ name, data }) => {
      if (typeof data === "string") data = enc.encode(data);
      else data = toBytes(data);
      const crc = crc32(data);
      let body = data;
      let method = 0;
      if (compress && data.length) {
        const c = await deflateRaw(data);
        if (c.length < data.length) { body = c; method = 8; }
      }
      onProgress?.((++done / entries.length) * 100);
      return { nameBytes: enc.encode(name), size: data.length, crc, body, method };
    }),
  );

  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [];
  const central = [];
  let offset = 0;
  for (const { nameBytes, size, crc, body, method } of packed) {
    if (body.length > 0xfffffffe || offset > 0xfffffffe) throw new Error("ZIP64 not supported (file too large)");

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0x0800, true);    // flags: UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    parts.push(lh, body);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);        // version made by
    cv.setUint16(6, 20, true);        // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);   // local header offset
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + body.length;
  }

  const cd = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, packed.length, true);
  ev.setUint16(10, packed.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, cd, end]);
}

/**
 * Open a ZIP file (stored or deflate entries; no ZIP64, no encryption).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{names:()=>string[], has:(n:string)=>boolean,
 *            read:(n:string, o?:{verify?:boolean})=>Promise<Uint8Array>,
 *            readText:(n:string)=>Promise<string>}}
 */
function readZip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  if (count === 0xffff || pos === 0xffffffff) throw new Error("ZIP64 not supported");

  const dec = new TextDecoder();
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const nlen = view.getUint16(pos + 28, true);
    const elen = view.getUint16(pos + 30, true);
    const clen = view.getUint16(pos + 32, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nlen));
    files.set(name, {
      method: view.getUint16(pos + 10, true),
      crc: view.getUint32(pos + 16, true),
      csize: view.getUint32(pos + 20, true),
      lho: view.getUint32(pos + 42, true),
    });
    pos += 46 + nlen + elen + clen;
  }

  const read = async (name, { verify = true } = {}) => {
    const f = files.get(name);
    if (!f) throw new Error(`missing ZIP entry "${name}"`);
    if (view.getUint32(f.lho, true) !== 0x04034b50) throw new Error("corrupt ZIP entry");
    const start = f.lho + 30 + view.getUint16(f.lho + 26, true) + view.getUint16(f.lho + 28, true);
    const raw = bytes.subarray(start, start + f.csize);
    let out;
    if (f.method === 0) out = raw;
    else if (f.method === 8) out = await inflateRaw(raw);
    else throw new Error(`unsupported ZIP compression method ${f.method} in "${name}"`);
    if (verify && crc32(out) !== f.crc) throw new Error(`CRC mismatch in "${name}"`);
    return out;
  };
  return {
    names: () => [...files.keys()].filter((n) => !n.endsWith("/")),
    has: (n) => files.has(n),
    read,
    readText: async (n) => dec.decode(await read(n)),
  };
}

// ---------------------------------------------------------------- .sr save

/**
 * @param {{samplerate:number, channels:number, names?:string[], data:Uint8Array, unitsize?:number}} cap
 * @param {{compress?:boolean, onProgress?:(percent:number)=>void}} [opts]
 *   compress: false = store uncompressed (fastest, big file). Default true.
 * @returns {Promise<Uint8Array>} contents of the .sr file
 */
async function saveSr(cap, opts = {}) {
  const { samplerate, channels } = cap;
  const names = cap.names ?? [];
  const unitsize = cap.unitsize ?? Math.max(1, Math.ceil(channels / 8));
  const data = packSamples(cap.data, unitsize);
  if (data.length % unitsize !== 0) throw new Error("data length is not a multiple of unitsize");

  let meta =
    `[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\n` +
    `total probes=${channels}\nsamplerate=${rateString(samplerate)}\ntotal analog=0\n`;
  for (let i = 0; i < channels; i++) meta += `probe${i + 1}=${names[i] ?? `D${i}`}\n`;
  meta += `unitsize=${unitsize}\n`;

  const enc = new TextEncoder();
  const entries = [
    { name: "version", data: enc.encode("2") },
    { name: "metadata", data: enc.encode(meta) },
  ];
  const step = Math.floor(CHUNK_BYTES / unitsize) * unitsize;
  for (let o = 0, i = 1; o < data.length; o += step, i++) {
    entries.push({ name: `logic-1-${i}`, data: data.subarray(o, Math.min(o + step, data.length)) });
  }
  return writeZip(entries, { compress: opts.compress ?? true, onProgress: opts.onProgress });
}

// ---------------------------------------------------------------- .sr load

/**
 * @param {Uint8Array|ArrayBuffer|Blob} input contents of a .sr file
 * @returns {Promise<{samplerate:number, channels:number, names:string[], unitsize:number, length:number, data:Uint8Array}>}
 *   Channels are capped at 32; `unitsize` is ceil(channels / 8),
 *   regardless of what the file used (extra bytes are dropped, missing ones zero-filled).
 */
async function loadSr(input) {
  if (typeof Blob !== "undefined" && input instanceof Blob) input = await input.arrayBuffer();
  const zip = readZip(input);
  if (!zip.has("metadata")) throw new Error('not a sigrok session file (no "metadata" entry)');
  const meta = await zip.readText("metadata");

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
  const channelCount = Math.min(probes, MAX_CHANNELS);
  const names = Array.from({ length: channelCount }, (_, i) => kv.get(`probe${i + 1}`) ?? `D${i}`);
  const keep = Math.max(1, Math.ceil(channelCount / 8));

  // Chunk files: "<base>" or "<base>-<n>", in numeric order.
  const parts = [];
  for (const n of zip.names()) {
    if (n === base) parts.push([0, n]);
    else if (n.startsWith(base + "-")) {
      const idx = Number(n.slice(base.length + 1));
      if (Number.isInteger(idx)) parts.push([idx, n]);
    }
  }
  parts.sort((a, b) => a[0] - b[0]);

  // Inflate all chunks in parallel (order is preserved by Promise.all).
  const out = await Promise.all(
    parts.map(async ([, name]) => {
      const buf = await zip.read(name);
      if (fileUnit === keep) return buf;
      const n = Math.floor(buf.length / fileUnit);
      const conv = new Uint8Array(n * keep);
      const copy = Math.min(keep, fileUnit);
      for (let i = 0; i < n; i++) for (let b = 0; b < copy; b++) conv[i * keep + b] = buf[i * fileUnit + b];
      return conv;
    }),
  );
  const data = concat(out);
  return { samplerate, channelCount, names, unitsize: keep, length: data.length / keep, data };
}

// ---------------------------------------------------------------- VCD export

/** Yields the VCD text in ~64 KB pieces (good for streaming to a file/download). Up to 32 channels. */
function* vcdChunks(cap) {
  const { channels, samplerate } = cap;
  const names = cap.names ?? [];
  const unitsize = cap.unitsize ?? Math.max(1, Math.ceil(channels / 8));
  const data = packSamples(cap.data, unitsize);
  if (channels > MAX_CHANNELS) throw new Error("VCD export supports up to 32 channels");
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
  const get =
    unitsize === 1
      ? (i) => data[i]
      : (i) => {
          let v = 0;
          for (let b = 0, o = i * unitsize; b < unitsize; b++) v |= data[o + b] << (8 * b);
          return v;
        };

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
