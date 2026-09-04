import { describe, expect, it } from 'vitest';

import { concatBytes, crc32, latin1Encode, uint32BE, utf8ToBase64 } from '../src/card/binary';
import {
  PNG_SIGNATURE,
  findTextChunk,
  isPng,
  makeTextChunk,
  parseChunks,
  readTextChunks,
  removeTextChunks,
  serializeChunks,
  setCardChunks,
} from '../src/card/png';
import { MANAGED_CHUNK_KEYWORDS } from '../src/card/spec';
import { fixtureBytes } from './helpers';

describe('PNG chunk parsing', () => {
  it('recognises the PNG signature', () => {
    expect(isPng(fixtureBytes('v2-chara.png'))).toBe(true);
    expect(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });

  it('parses a well-formed chunk list starting at IHDR and ending at IEND', () => {
    const chunks = parseChunks(fixtureBytes('v2-chara.png'));
    expect(chunks[0].type).toBe('IHDR');
    expect(chunks.at(-1)?.type).toBe('IEND');
    expect(chunks.map((c) => c.type)).toContain('IDAT');
  });

  it('rejects a file that is not a PNG', () => {
    expect(() => parseChunks(new Uint8Array(32))).toThrow(/PNG/);
  });

  it('round-trips bytes exactly when nothing is changed', () => {
    const original = fixtureBytes('v3-ccv3.png');
    expect(serializeChunks(parseChunks(original))).toEqual(original);
  });
});

describe('CRC32', () => {
  it('matches the known PNG IEND checksum', () => {
    // IEND has no data, so its CRC is the checksum of the type bytes alone.
    expect(crc32(latin1Encode('IEND'))).toBe(0xae426082);
  });

  it('writes a CRC that validates for every chunk it emits', () => {
    const bytes = serializeChunks(parseChunks(fixtureBytes('v2-chara.png')));
    let offset = 8;
    let checked = 0;
    while (offset + 8 <= bytes.length) {
      const length =
        ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const end = offset + 8 + length;
      const stored =
        ((bytes[end] << 24) | (bytes[end + 1] << 16) | (bytes[end + 2] << 8) | bytes[end + 3]) >>> 0;
      expect(crc32(bytes.subarray(offset + 4, end))).toBe(stored);
      checked++;
      offset = end + 4;
    }
    expect(checked).toBeGreaterThan(2);
  });
});

describe('text chunks', () => {
  it('reads a tEXt chunk back out', async () => {
    const texts = await readTextChunks(parseChunks(fixtureBytes('v2-chara.png')));
    expect(findTextChunk(texts, 'chara')?.source).toBe('tEXt');
  });

  it('matches keywords case-insensitively', async () => {
    const texts = await readTextChunks(parseChunks(fixtureBytes('v3-ccv3.png')));
    expect(findTextChunk(texts, 'CCV3')).toBeDefined();
  });

  it('reads a zTXt chunk', async () => {
    // Build one by hand: keyword \0 compressionMethod(1) zlib(text)
    const { deflateSync } = await import('node:zlib');
    const base = parseChunks(fixtureBytes('no-card-data.png'));
    const payload = concatBytes(
      latin1Encode('chara'),
      new Uint8Array([0, 0]),
      new Uint8Array(deflateSync(Buffer.from('hello zTXt', 'utf-8'))),
    );
    base.splice(1, 0, { type: 'zTXt', data: payload });
    const texts = await readTextChunks(parseChunks(serializeChunks(base)));
    expect(findTextChunk(texts, 'chara')).toMatchObject({ text: 'hello zTXt', source: 'zTXt' });
  });

  it('reads an uncompressed iTXt chunk', async () => {
    const base = parseChunks(fixtureBytes('no-card-data.png'));
    const payload = concatBytes(
      latin1Encode('chara'),
      new Uint8Array([0, 0, 0]), // null, compressionFlag=0, compressionMethod=0
      new Uint8Array([0]), // empty language tag
      new Uint8Array([0]), // empty translated keyword
      new TextEncoder().encode('中文 iTXt payload'),
    );
    base.splice(1, 0, { type: 'iTXt', data: payload });
    const texts = await readTextChunks(parseChunks(serializeChunks(base)));
    expect(findTextChunk(texts, 'chara')?.text).toBe('中文 iTXt payload');
  });
});

describe('setCardChunks', () => {
  it('replaces an existing chara chunk instead of adding a second one', async () => {
    // This is the regression for the old injectMetadataIntoPng, which inserted a
    // new chunk while leaving the original in place.
    const updated = setCardChunks(
      fixtureBytes('v2-chara.png'),
      [{ keyword: 'chara', text: utf8ToBase64('{"spec":"chara_card_v2"}') }],
      MANAGED_CHUNK_KEYWORDS,
    );
    const texts = await readTextChunks(parseChunks(updated));
    expect(texts.filter((t) => t.keyword.toLowerCase() === 'chara')).toHaveLength(1);
  });

  it('removes a stale ccv3 chunk as well', async () => {
    const updated = setCardChunks(
      fixtureBytes('v2v3-dual-chunk.png'),
      [{ keyword: 'chara', text: 'e30=' }],
      MANAGED_CHUNK_KEYWORDS,
    );
    const texts = await readTextChunks(parseChunks(updated));
    expect(texts.map((t) => t.keyword.toLowerCase())).toEqual(['chara']);
  });

  it('inserts payload chunks directly after IHDR', () => {
    const updated = setCardChunks(
      fixtureBytes('no-card-data.png'),
      [
        { keyword: 'chara', text: 'a' },
        { keyword: 'ccv3', text: 'b' },
      ],
      MANAGED_CHUNK_KEYWORDS,
    );
    expect(parseChunks(updated).map((c) => c.type).slice(0, 3)).toEqual(['IHDR', 'tEXt', 'tEXt']);
  });

  it('leaves the image data byte-for-byte identical', () => {
    const original = fixtureBytes('v2-chara.png');
    const updated = setCardChunks(
      original,
      [{ keyword: 'chara', text: 'something-completely-different' }],
      MANAGED_CHUNK_KEYWORDS,
    );
    const idat = (bytes: Uint8Array) =>
      parseChunks(bytes)
        .filter((c) => c.type === 'IDAT')
        .map((c) => c.data);
    expect(idat(updated)).toEqual(idat(original));
  });

  it('keeps chunks it does not manage', () => {
    const base = parseChunks(fixtureBytes('no-card-data.png'));
    base.splice(1, 0, makeTextChunk('Software', 'SomeOtherTool'));
    const withExtra = serializeChunks(base);
    const updated = setCardChunks(withExtra, [{ keyword: 'chara', text: 'x' }], MANAGED_CHUNK_KEYWORDS);
    expect(parseChunks(updated).length).toBe(parseChunks(withExtra).length + 1);
  });
});

describe('removeTextChunks', () => {
  it('only drops the listed keywords', () => {
    const chunks = [
      { type: 'IHDR', data: new Uint8Array(13) },
      makeTextChunk('chara', 'a'),
      makeTextChunk('Comment', 'b'),
      { type: 'IEND', data: new Uint8Array(0) },
    ];
    expect(removeTextChunks(chunks, ['chara']).map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IEND']);
  });
});

describe('serializeChunks', () => {
  it('always emits the PNG signature first', () => {
    const bytes = serializeChunks([{ type: 'IEND', data: new Uint8Array(0) }]);
    expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(bytes.subarray(4, 8)).toEqual(uint32BE(0x0d0a1a0a).subarray(0, 4));
  });
});
