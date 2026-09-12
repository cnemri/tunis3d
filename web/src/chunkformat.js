// Reader for the per-chunk binary container written by pipeline/build_tiles.py.
//   uint32 magic ('TUN1'), uint32 headerLength, header JSON (utf-8), payload
// header = { meta: {...}, sections: { name: { offset, length, dtype, count } } }
const MAGIC = 0x314e5554; // 'TUN1' little-endian

const CTORS = {
  float32: Float32Array,
  uint32: Uint32Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
  int8: Int8Array,
  int16: Int16Array,
};

export function parseChunk(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad chunk magic');
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
  const base = 8 + headerLen;
  const sections = {};
  for (const [name, s] of Object.entries(header.sections)) {
    const Ctor = CTORS[s.dtype];
    // Sections are 4-byte aligned by the writer; copy anyway so buffers stay
    // independent when a chunk is disposed.
    sections[name] = new Ctor(buffer.slice(base + s.offset, base + s.offset + s.length));
  }
  return { meta: header.meta, sections };
}

export async function fetchChunk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`chunk ${url}: ${res.status}`);
  return parseChunk(await res.arrayBuffer());
}
