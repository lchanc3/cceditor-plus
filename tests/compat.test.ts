/**
 * Asserts that what we export is what other tools expect to import.
 *
 * These encode SillyTavern's actual import rules: it branches on `spec`, and
 * without it falls back to treating the file as a flat V1 card — which is why
 * the old `{ data: {...} }` export produced a character with no name.
 */

import { describe, expect, it } from 'vitest';

import { normalizeCard, serializeCard } from '../src/card/model';
import { buildCardJson, buildCardPng, suggestFilename, withExportTimestamps } from '../src/card/write';
import { base64ToUtf8 } from '../src/card/binary';
import { findTextChunk, parseChunks, readTextChunks } from '../src/card/png';
import { ExportSpec } from '../src/card/spec';
import { fixtureBytes, fixtureJson } from './helpers';

const model = () => normalizeCard(fixtureJson('v3-full.json'));

describe('SillyTavern import expectations', () => {
  it.each(['v2', 'v3', 'max'] as ExportSpec[])('%s export declares a spec at the root', (spec) => {
    const out = serializeCard(model(), spec);
    expect(out.spec, 'no spec field: SillyTavern would fall back to V1 parsing').toBeTypeOf('string');
    expect(out.spec_version).toBeTypeOf('string');
  });

  it.each(['v2', 'v3', 'max'] as ExportSpec[])('%s export has a non-empty data.name', (spec) => {
    const data = serializeCard(model(), spec).data as Record<string, unknown>;
    expect(data.name).toBeTruthy();
  });

  it('v1 export has a non-empty root name', () => {
    expect(serializeCard(model(), 'v1').name).toBeTruthy();
  });

  it('never exports the bare {data:...} shape the old build produced', () => {
    for (const spec of ['v1', 'v2', 'v3', 'max'] as ExportSpec[]) {
      const out = serializeCard(model(), spec);
      const hasEnvelope = 'spec' in out;
      const hasFlatName = typeof out.name === 'string' && out.name.length > 0;
      expect(hasEnvelope || hasFlatName, `${spec} export is unreadable by every importer`).toBe(true);
    }
  });

  it('emits lorebook entries in the shape importers expect', () => {
    const data = serializeCard(model(), 'v3').data as Record<string, unknown>;
    const book = data.character_book as { entries: Record<string, unknown>[] };
    expect(book.entries.length).toBeGreaterThan(0);
    for (const entry of book.entries) {
      expect(Array.isArray(entry.keys)).toBe(true);
      expect(typeof entry.content).toBe('string');
      expect(typeof entry.enabled).toBe('boolean');
      expect(typeof entry.insertion_order).toBe('number');
      expect(typeof entry.extensions).toBe('object');
    }
  });

  it('keeps {{char}} and {{user}} macros untouched', () => {
    const json = buildCardJson(model(), 'max');
    expect(json).toContain('{{char}}');
    expect(json).toContain('{{user}}');
  });

  it('round-trips non-ASCII content through base64 into the PNG chunk', async () => {
    const png = buildCardPng(model(), fixtureBytes('no-card-data.png'));
    const chara = findTextChunk(await readTextChunks(parseChunks(png)), 'chara');
    expect(JSON.parse(base64ToUtf8(chara!.text)).data.name).toContain('莉茲貝特');
  });

  it('writes both chara and ccv3 so old and new tools both work', async () => {
    const png = buildCardPng(model(), fixtureBytes('no-card-data.png'));
    const texts = await readTextChunks(parseChunks(png));
    expect(findTextChunk(texts, 'chara')).toBeDefined();
    expect(findTextChunk(texts, 'ccv3')).toBeDefined();
  });

  it('keeps the payload chunks pure ASCII, as tEXt requires', async () => {
    const png = buildCardPng(model(), fixtureBytes('no-card-data.png'));
    for (const text of await readTextChunks(parseChunks(png))) {
      expect(/^[\x00-\x7f]*$/.test(text.text), `${text.keyword} is not ASCII`).toBe(true);
    }
  });
});

describe('export timestamps', () => {
  it('sets modification_date and keeps the original creation_date', () => {
    const stamped = withExportTimestamps(model());
    expect(stamped.fields.creation_date).toBe(1700000000);
    expect(stamped.fields.modification_date).toBeGreaterThan(1700009999);
  });

  it('sets creation_date on a card that never had one', () => {
    const stamped = withExportTimestamps(normalizeCard({ name: 'new' }));
    expect(stamped.fields.creation_date).toBeGreaterThan(0);
  });
});

describe('suggested filenames', () => {
  it('strips characters the filesystem rejects', () => {
    const named = (name: string) => suggestFilename(normalizeCard({ name }), 'png');
    expect(named('a/b:c*d?e')).toBe('a_b_c_d_e.png');
    expect(named('normal name')).toBe('normal name.png');
  });

  it('keeps CJK and falls back when the name is unusable', () => {
    expect(suggestFilename(normalizeCard({ name: '莉茲貝特' }), 'json')).toBe('莉茲貝特.json');
    expect(suggestFilename(normalizeCard({ name: '' }), 'json')).toBe('character.json');
  });
});
