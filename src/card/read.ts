/**
 * Reading a character card from a file.
 *
 * Fixes the import half of the round-trip bug: the old JSON branch returned the
 * raw parsed root, so a V2/V3 file (where the character lives under `data`) came
 * back with every field `undefined`. Both branches now go through
 * `normalizeCard`, which knows about the envelope.
 */

import { base64ToUtf8, looksLikeBase64, toUint8Array, utf8Decode } from './binary';
import { CardModel, normalizeCard } from './model';
import { findTextChunk, isPng, parseChunks, readTextChunks } from './png';
import { V2_CHUNK_KEYWORDS, V3_CHUNK_KEYWORD } from './spec';

export type CardOrigin = 'ccv3' | 'chara' | 'json';

export interface ReadResult {
  model: CardModel;
  /** The original PNG bytes, kept so an export can reuse the artwork untouched. */
  imageBytes?: Uint8Array;
  format: 'png' | 'json';
  /** Where the payload actually came from, surfaced in the UI. */
  origin: CardOrigin;
  warnings: string[];
}

export class CardReadError extends Error {}

/** Payloads are meant to be base64, but some tools embed raw JSON. Accept both. */
function decodePayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  if (looksLikeBase64(trimmed)) {
    return JSON.parse(base64ToUtf8(trimmed));
  }
  // Last resort: it may be JSON with leading junk we should still try.
  return JSON.parse(trimmed);
}

export function parseCardJson(text: string): CardModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CardReadError(`JSON 格式錯誤：${(error as Error).message}`);
  }
  return normalizeCard(raw);
}

async function readPng(bytes: Uint8Array): Promise<ReadResult> {
  const chunks = parseChunks(bytes);
  const texts = await readTextChunks(chunks);

  const v3Chunk = findTextChunk(texts, V3_CHUNK_KEYWORD);
  const v2Chunk = V2_CHUNK_KEYWORDS.map((keyword) => findTextChunk(texts, keyword)).find(Boolean);

  // SPEC_V3: when both `chara` and `ccv3` are present, `ccv3` MUST win.
  const chosen = v3Chunk ?? v2Chunk;
  if (!chosen) {
    throw new CardReadError(
      '這張 PNG 沒有角色卡資料（找不到 chara 或 ccv3 chunk）。它可能只是一張普通圖片。',
    );
  }

  const warnings: string[] = [];
  if (v3Chunk && v2Chunk) {
    warnings.push('此卡同時含有 V2 與 V3 資料，已依規範採用 V3（ccv3）。');
  }

  let raw: unknown;
  try {
    raw = decodePayload(chosen.text);
  } catch (error) {
    throw new CardReadError(`角色卡資料解碼失敗：${(error as Error).message}`);
  }

  const model = normalizeCard(raw);
  if (!model.fields.name) {
    warnings.push('讀到的卡片沒有角色名稱，請確認來源檔案是否正確。');
  }

  return {
    model,
    imageBytes: bytes,
    format: 'png',
    origin: v3Chunk ? 'ccv3' : 'chara',
    warnings,
  };
}

export async function readCardBytes(input: ArrayBuffer | Uint8Array, filename = ''): Promise<ReadResult> {
  const bytes = toUint8Array(input);

  if (isPng(bytes)) return readPng(bytes);

  // Not a PNG: the only other thing we accept is JSON.
  if (/\.(jpe?g|webp|charx)$/i.test(filename)) {
    throw new CardReadError(
      '目前只支援 PNG 與 JSON 角色卡。JPEG / WebP / CharX 尚未支援。',
    );
  }

  const text = utf8Decode(bytes).replace(/^﻿/, '');
  const model = parseCardJson(text);
  const warnings: string[] = [];
  if (!model.fields.name) {
    warnings.push('讀到的卡片沒有角色名稱，請確認來源檔案是否正確。');
  }
  return { model, format: 'json', origin: 'json', warnings };
}

export async function readCardFile(file: File): Promise<ReadResult> {
  return readCardBytes(await file.arrayBuffer(), file.name);
}
