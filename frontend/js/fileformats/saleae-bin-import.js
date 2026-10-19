// saleae-bin.js — parser för Saleae Logic 2 "Binary Format" (v0 och v1)
const MAGIC = '<SALEAE>';
const TYPE_DIGITAL = 0, TYPE_ANALOG = 1;

function isSaleaeBinary(buf) {
  if (buf.byteLength < 16) return false;
  const b = new Uint8Array(buf, 0, 8);
  for (let i = 0; i < 8; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

function parseSaleaeBinary(buf) {
  if (!isSaleaeBinary(buf)) throw new Error('Inte en Saleae-binärfil');
  const dv = new DataView(buf);
  let o = 8;

  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(o, true); o += 8; return v; };
  const u64 = () => { const v = Number(dv.getBigUint64(o, true)); o += 8; return v; };
  const i64 = () => { const v = Number(dv.getBigInt64(o, true)); o += 8; return v; };
  const need = (bytes) => {
    if (o + bytes > buf.byteLength) throw new Error('Filen är trunkerad eller korrupt');
  };
  const f64Array = (n) => {           // slice => alignment-säkert
    need(n * 8);
    const a = new Float64Array(buf.slice(o, o + n * 8)); o += n * 8; return a;
  };
  const f32Array = (n) => {
    need(n * 4);
    const a = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4; return a;
  };

  const version = i32();
  const type = i32();
  if (version !== 0 && version !== 1) throw new Error(`Okänd version: ${version}`);

  if (type === TYPE_DIGITAL) {
    const chunkCount = version === 0 ? 1 : u64();
    const chunks = [];
    for (let c = 0; c < chunkCount; c++) {
      need(version === 0 ? 28 : 36);
      const initialState = u32();
      const samplerate = version === 1 ? f64() : null;   // v0 saknar samplerate
      const beginTime = f64();
      const endTime = f64();
      const n = u64();
      chunks.push({ initialState, samplerate, beginTime, endTime, transitions: f64Array(n) });
    }
    return { type: 'digital', version, chunks };
  }

  if (type === TYPE_ANALOG) {
    const count = version === 0 ? 1 : u64();
    const waveforms = [];
    for (let w = 0; w < count; w++) {
      let beginTime, triggerTime, samplerate, downsample, n;
      if (version === 0) {
        need(32);
        beginTime = f64(); samplerate = u64(); downsample = u64(); n = u64();
        triggerTime = beginTime;
      } else {
        need(40);
        beginTime = f64(); triggerTime = f64(); samplerate = f64(); downsample = i64(); n = u64();
      }
      waveforms.push({ beginTime, triggerTime, samplerate, downsample, samples: f32Array(n) });
    }
    return { type: 'analog', version, waveforms };
  }

  throw new Error(`Okänd datatyp: ${type}`);
}

// Transitioner -> samples (1 byte/sample, 0/1) vid given samplerate.
// OBS: stora för långa capturer — kör hellre run-length direkt från transitions om motorn tillåter det.
function digitalChunkToSamples(chunk, samplerate = chunk.samplerate) {
  if (!samplerate) throw new Error('Samplerate krävs (v0-filer saknar den)');
  const total = Math.round((chunk.endTime - chunk.beginTime) * samplerate);
  const out = new Uint8Array(total);
  let state = chunk.initialState ? 1 : 0;
  let idx = 0;
  for (const t of chunk.transitions) {
    const end = Math.min(total, Math.round((t - chunk.beginTime) * samplerate));
    if (state) out.fill(1, idx, end);
    idx = Math.max(idx, end);
    state ^= 1;
  }
  if (state && idx < total) out.fill(1, idx, total);
  return out;
}

// saleae-bin.js (tillägg)

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {          // Uint8Array / Node Buffer (kan ha byteOffset)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new Error('data måste vara ArrayBuffer eller typed array');
}

// ORar in en kanals 1-perioder i out[] med given bitmask
function orChunkIntoBits(out, mask, chunk, origin, sr) {
  const stop = Math.min(out.length, Math.round((chunk.endTime - origin) * sr));
  let prev = Math.max(0, Math.round((chunk.beginTime - origin) * sr));
  let state = chunk.initialState ? 1 : 0;

  for (const t of chunk.transitions) {
    let idx = Math.round((t - origin) * sr);
    if (idx < prev) idx = prev;            // skydd mot icke-monotona tider
    if (idx > stop) idx = stop;
    if (state) for (let i = prev; i < idx; i++) out[i] |= mask;
    prev = idx;
    state ^= 1;
  }
  if (state) for (let i = prev; i < stop; i++) out[i] |= mask;
}

/**
 * importSaleae({ items: [{ data, ch }, ...], samplerate?, maxSamples? })
 *  data: ArrayBuffer | typed array med innehållet i en Saleae .bin (digital, en kanal)
 *  ch:   bitposition 0..31 i utdata
 *  samplerate: krävs för v0-filer, överstyr annars filens (v1)
 * Returnerar { samples: Uint32Array, samplerate, beginTime, numSamples, channels }
 */
function importSaleae({ items, samplerate, maxSamples = 1 << 28 }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Inga filer angivna');

  const seen = new Set();
  const parsed = items.map(({ data, ch }, n) => {
    if (!Number.isInteger(ch) || ch < 0 || ch > 31) throw new Error(`Fil ${n}: ogiltig kanal ${ch} (0..31)`);
    if (seen.has(ch)) throw new Error(`Kanal ${ch} används av flera filer`);
    seen.add(ch);

    const p = parseSaleaeBinary(toArrayBuffer(data));
    if (p.type !== 'digital') throw new Error(`Fil ${n}: analog data stöds inte`);
    return { ch, chunks: p.chunks };
  });

  // Gemensam samplerate
  let sr = samplerate ?? null;
  for (const { chunks } of parsed) {
    for (const c of chunks) {
      if (c.samplerate == null) continue;
      if (sr == null) sr = c.samplerate;
      else if (samplerate == null && c.samplerate !== sr)
        throw new Error('Filerna har olika samplerate; ange samplerate explicit');
    }
  }
  if (sr == null) throw new Error('samplerate krävs (v0-filer saknar den)');
/*
  // Gemensam tidsbas
  let origin = Infinity, end = -Infinity;
  for (const { chunks } of parsed) for (const c of chunks) {
    if (c.beginTime < origin) origin = c.beginTime;
    if (c.endTime > end) end = c.endTime;
  }
  const total = Math.round((end - origin) * sr);
  if (total > maxSamples) throw new Error(`För stor capture: ${total} samples (max ${maxSamples})`);
  console.log({total});
  const samples = new Uint32Array(total);
  for (const { ch, chunks } of parsed) {
    const mask = (1 << ch) >>> 0;
    for (const c of chunks) orChunkIntoBits(samples, mask, c, origin, sr);
  }

  return { samples, samplerate: sr, beginTime: origin, numSamples: total, channels: seen.size };
  */

  // Gemensam tidsbas
  let origin = Infinity, end = -Infinity;
  for (const { chunks } of parsed) for (const c of chunks) {
    if (c.beginTime < origin) origin = c.beginTime;
    if (c.endTime > end) end = c.endTime;
  }

  const fullTotal = Math.round((end - origin) * sr);
  const limit = Math.max(1, Math.floor(maxSamples));
  const total = Math.min(fullTotal, limit);
  const truncated = total < fullTotal;
  if (truncated) console.warn(`Capture trunkerad: ${fullTotal} -> ${total} samples`);

  // Chunks som börjar efter klippgränsen behövs inte alls
  const limitTime = origin + total / sr;

  const samples = new Uint32Array(total);
  for (const { ch, chunks } of parsed) {
    const mask = (1 << ch) >>> 0;
    for (const c of chunks) {
      if (c.beginTime >= limitTime) continue;
      orChunkIntoBits(samples, mask, c, origin, sr);
    }
  }

  return {
    samples, samplerate: sr, beginTime: origin,
    numSamples: total, fullNumSamples: fullTotal, truncated,
    channels: seen.size
  };
}