/**
 * PNG chunk reading and writing.
 *
 * The previous implementation had two bugs this module exists to fix:
 *   1. it appended a fresh `chara` tEXt chunk without removing the existing
 *      one, leaving two `chara` chunks in the file (a spec violation — readers
 *      that take the last match got stale data);
 *   2. it never looked at, nor wrote, the `ccv3` chunk, so V3 cards lost
 *      everything V3 added.
 */

import {
  bytesEqual,
  concatBytes,
  crc32,
  latin1Decode,
  latin1Encode,
  readUint32BE,
  uint32BE,
  utf8Decode,
  utf8DecodeStrict,
} from './binary';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export interface PngTextChunk {
  keyword: string;
  text: string;
  /** Which chunk type carried it, so we can report what a card actually used. */
  source: 'tEXt' | 'iTXt' | 'zTXt';
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
}

export class PngParseError extends Error {}

/**
 * Walk the whole chunk list. Chunk CRCs are not verified — a surprising number
 * of cards in circulation have been rewritten by tools that got the CRC wrong,
 * and refusing to read them would help nobody. CRCs we *write* are always correct.
 */
export function parseChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new PngParseError('不是有效的 PNG 檔案（signature 不符）。');

  const chunks: PngChunk[] = [];
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = latin1Decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // Truncated file: keep whatever we parsed rather than throwing it all away.
    if (dataEnd + 4 > bytes.length) break;

    chunks.push({ type, data: bytes.slice(dataStart, dataEnd) });
    offset = dataEnd + 4;

    if (type === 'IEND') break;
  }

  if (chunks.length === 0 || chunks[0].type !== 'IHDR') {
    throw new PngParseError('PNG 缺少 IHDR chunk，檔案可能已損毀。');
  }
  return chunks;
}

export function serializeChunks(chunks: PngChunk[]): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    const typeBytes = latin1Encode(chunk.type);
    parts.push(uint32BE(chunk.data.length), typeBytes, chunk.data, uint32BE(crc32(concatBytes(typeBytes, chunk.data))));
  }
  return concatBytes(...parts);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // PNG compresses text with zlib (RFC1950), which is what 'deflate' means here.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function splitAtNull(bytes: Uint8Array, from = 0): { head: Uint8Array; rest: Uint8Array } | null {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === 0) return { head: bytes.subarray(from, i), rest: bytes.subarray(i + 1) };
  }
  return null;
}

async function decodeTextChunk(chunk: PngChunk): Promise<PngTextChunk | null> {
  const split = splitAtNull(chunk.data);
  if (!split) return null;
  const keyword = latin1Decode(split.head);

  if (chunk.type === 'tEXt') {
    // The PNG spec says Latin-1, and every conformant card payload is base64
    // (pure ASCII), where the two decodings agree. Some tools embed raw JSON
    // with UTF-8 bytes anyway, so prefer UTF-8 whenever the bytes are valid
    // UTF-8 and fall back to Latin-1 otherwise.
    const text = utf8DecodeStrict(split.rest) ?? latin1Decode(split.rest);
    return { keyword, text, source: 'tEXt' };
  }

  if (chunk.type === 'zTXt') {
    // keyword \0 compressionMethod(1) compressedText
    const compressed = split.rest.subarray(1);
    try {
      return { keyword, text: utf8Decode(await inflate(compressed)), source: 'zTXt' };
    } catch {
      return null;
    }
  }

  if (chunk.type === 'iTXt') {
    // keyword \0 compressionFlag(1) compressionMethod(1) langTag \0 translatedKeyword \0 text
    const compressionFlag = split.rest[0];
    const afterFlags = split.rest.subarray(2);
    const langSplit = splitAtNull(afterFlags);
    if (!langSplit) return null;
    const translatedSplit = splitAtNull(langSplit.rest);
    if (!translatedSplit) return null;
    const payload = translatedSplit.rest;
    if (compressionFlag === 1) {
      try {
        return { keyword, text: utf8Decode(await inflate(payload)), source: 'iTXt' };
      } catch {
        return null;
      }
    }
    return { keyword, text: utf8Decode(payload), source: 'iTXt' };
  }

  return null;
}

/** Every text chunk in the file, in file order. */
export async function readTextChunks(chunks: PngChunk[]): Promise<PngTextChunk[]> {
  const out: PngTextChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt' && chunk.type !== 'zTXt') continue;
    const decoded = await decodeTextChunk(chunk);
    if (decoded) out.push(decoded);
  }
  return out;
}

export function findTextChunk(texts: PngTextChunk[], keyword: string): PngTextChunk | undefined {
  const wanted = keyword.toLowerCase();
  return texts.find((t) => t.keyword.toLowerCase() === wanted);
}

export function makeTextChunk(keyword: string, text: string): PngChunk {
  // Card payloads are base64, so they are pure ASCII and safe in a Latin-1 tEXt
  // chunk. Both specs mandate tEXt specifically, not iTXt.
  return {
    type: 'tEXt',
    data: concatBytes(latin1Encode(keyword), new Uint8Array([0]), latin1Encode(text)),
  };
}

function textChunkKeyword(chunk: PngChunk): string | null {
  if (chunk.type !== 'tEXt' && chunk.type !== 'iTXt' && chunk.type !== 'zTXt') return null;
  const split = splitAtNull(chunk.data);
  return split ? latin1Decode(split.head) : null;
}

/** Drop every text chunk whose keyword is in `keywords` (case-insensitive). */
export function removeTextChunks(chunks: PngChunk[], keywords: readonly string[]): PngChunk[] {
  const unwanted = new Set(keywords.map((k) => k.toLowerCase()));
  return chunks.filter((chunk) => {
    const keyword = textChunkKeyword(chunk);
    return keyword === null || !unwanted.has(keyword.toLowerCase());
  });
}

/**
 * Replace the card payload chunks of a PNG.
 *
 * Existing `chara` / `character_card` / `ccv3` chunks are removed first, then
 * the supplied ones are inserted directly after IHDR. Image data is untouched.
 */
export function setCardChunks(
  pngBytes: Uint8Array,
  payloads: { keyword: string; text: string }[],
  managedKeywords: readonly string[],
): Uint8Array {
  const chunks = removeTextChunks(parseChunks(pngBytes), managedKeywords);
  const ihdrIndex = chunks.findIndex((c) => c.type === 'IHDR');
  const insertAt = ihdrIndex >= 0 ? ihdrIndex + 1 : 0;
  const inserted = payloads.map((p) => makeTextChunk(p.keyword, p.text));
  return serializeChunks([...chunks.slice(0, insertAt), ...inserted, ...chunks.slice(insertAt)]);
}
