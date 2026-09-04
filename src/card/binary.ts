/**
 * Byte / text / base64 helpers.
 *
 * Everything here works unchanged in the browser and in Node (>=18), which is
 * why the card codec can be unit-tested without a DOM. Deliberately no `Buffer`
 * and no `node:` imports — the old implementation pulled the whole `buffer`
 * npm polyfill into the browser bundle just for `toString('base64')`.
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
// PNG tEXt chunks are Latin-1 by spec (PNG 1.2 §4.2.3), not ASCII and not UTF-8.
const latin1Decoder = new TextDecoder('latin1');

export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function latin1Decode(bytes: Uint8Array): string {
  return latin1Decoder.decode(bytes);
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode as UTF-8, or return null if the bytes are not valid UTF-8.
 *
 * Used to rescue text chunks from tools that write UTF-8 where the PNG spec
 * says Latin-1. For pure-ASCII content (which every spec-conformant base64
 * payload is) both decodings are identical, so this can only help.
 */
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Latin-1 encode. Code points above 0xFF cannot be represented and are dropped to '?'. */
export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code <= 0xff ? code : 0x3f;
  }
  return out;
}

export function asciiEncode(text: string): Uint8Array {
  return latin1Encode(text);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// btoa() takes a binary string. Building that with String.fromCharCode(...bytes)
// blows the argument limit on anything larger than ~100KB, so go in chunks.
const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  // Tolerate whitespace and URL-safe alphabets; some cards in the wild have
  // newline-wrapped base64 from being pasted through other tools.
  const cleaned = base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON string -> UTF-8 -> base64. This is the encoding the card specs mandate. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8Encode(text));
}

/** base64 -> UTF-8 -> JSON string. */
export function base64ToUtf8(base64: string): string {
  return utf8Decode(base64ToBytes(base64));
}

export function looksLikeBase64(value: string): boolean {
  const cleaned = value.replace(/\s+/g, '');
  return cleaned.length > 0 && /^[A-Za-z0-9+/\-_]+={0,2}$/.test(cleaned);
}

const CRC_TABLE = (() => {
  // Built once at module load. The previous implementation rebuilt this 256-entry
  // table on every single chunk write.
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}
