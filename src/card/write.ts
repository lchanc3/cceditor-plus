/**
 * Writing a character card back out.
 *
 * Returns bytes and strings rather than Blobs so the whole codec stays testable
 * in plain Node; the browser-facing download helpers live in `src/lib/download.ts`.
 */

import { utf8ToBase64 } from './binary';
import { CardModel, toSpecV2, toSpecV3 } from './model';
import { setCardChunks } from './png';
import { ExportSpec, MANAGED_CHUNK_KEYWORDS, V3_CHUNK_KEYWORD } from './spec';
import { serializeCard } from './model';

export function buildCardJson(model: CardModel, spec: ExportSpec, pretty = true): string {
  return JSON.stringify(serializeCard(model, spec), null, pretty ? 2 : 0);
}

/**
 * Embed the card into a PNG.
 *
 * Both payloads are written, which is what SillyTavern does: older tools read
 * `chara`, V3-aware ones read `ccv3` and take precedence. Any pre-existing card
 * chunks are removed first — the old implementation left the stale one in place,
 * producing a file with two `chara` chunks.
 */
export function buildCardPng(model: CardModel, imageBytes: Uint8Array): Uint8Array {
  return setCardChunks(
    imageBytes,
    [
      { keyword: 'chara', text: utf8ToBase64(JSON.stringify(toSpecV2(model))) },
      { keyword: V3_CHUNK_KEYWORD, text: utf8ToBase64(JSON.stringify(toSpecV3(model))) },
    ],
    MANAGED_CHUNK_KEYWORDS,
  );
}

/** Stamp modification time (and creation time on first export) into V3 metadata. */
export function withExportTimestamps(model: CardModel): CardModel {
  const now = Date.now();
  return {
    ...model,
    fields: {
      ...model.fields,
      creation_date: model.fields.creation_date ?? now,
      modification_date: now,
    },
  };
}

// Characters Windows and macOS reject in filenames. Kept as a plain set rather
// than a regex so there is no escaping ambiguity around the backslash.
const ILLEGAL_FILENAME_CHARS = new Set([...'<>:"/|?*', String.fromCharCode(92)]);

export function suggestFilename(model: CardModel, extension: string): string {
  const cleaned = [...(model.fields.name || 'character')]
    .map((ch) => (ILLEGAL_FILENAME_CHARS.has(ch) || ch.charCodeAt(0) < 0x20 ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${cleaned || 'character'}.${extension}`;
}
