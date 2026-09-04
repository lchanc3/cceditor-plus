import { describe, expect, it } from 'vitest';

import { detectSpec, normalizeCard } from '../src/card/model';
import { readCardBytes } from '../src/card/read';
import { fixtureBytes, fixtureJson } from './helpers';

describe('detectSpec', () => {
  it('reads the spec field when present', () => {
    expect(detectSpec({ spec: 'chara_card_v3', data: {} })).toBe('v3');
    expect(detectSpec({ spec: 'chara_card_v2', data: {} })).toBe('v2');
  });

  it('treats a flat object as V1', () => {
    expect(detectSpec({ name: 'a', description: 'b' })).toBe('v1');
  });

  it('infers V2 from a bare data envelope with no spec field', () => {
    expect(detectSpec({ data: { name: 'a' } })).toBe('v2');
  });

  it('upgrades a bare envelope to V3 when a V3-only field is present', () => {
    expect(detectSpec({ data: { name: 'a', group_only_greetings: [] } })).toBe('v3');
  });

  it('does not throw on junk', () => {
    expect(detectSpec(null)).toBe('v1');
    expect(detectSpec('nope')).toBe('v1');
  });
});

describe('normalizeCard', () => {
  it('reads V1 fields from the root', () => {
    const model = normalizeCard(fixtureJson('v1-basic.json'));
    expect(model.sourceSpec).toBe('v1');
    expect(model.fields.name).toContain('莉茲貝特');
    expect(model.fields.first_mes).toContain('{{user}}');
  });

  it('maps legacy TavernAI field names onto the modern ones', () => {
    const model = normalizeCard(fixtureJson('v1-legacy-tavernai.json'));
    expect(model.fields.name).toBe('古老的旅人');
    expect(model.fields.description).toBe('一位沉默寡言的旅行者。');
    expect(model.fields.scenario).toBe('荒野的岔路口。');
    expect(model.fields.first_mes).toContain('點了點頭');
    expect(model.fields.mes_example).toContain('<START>');
  });

  it('reads V2 fields from data, not from the root', () => {
    // The bug the old importer had: it returned the root, so name was undefined.
    const model = normalizeCard(fixtureJson('v2-full.json'));
    expect(model.sourceSpec).toBe('v2');
    expect(model.fields.name).toContain('莉茲貝特');
    expect(model.fields.alternate_greetings).toHaveLength(2);
    expect(model.fields.character_book?.entries).toHaveLength(2);
  });

  it('reads all V3-only fields', () => {
    const model = normalizeCard(fixtureJson('v3-full.json'));
    expect(model.sourceSpec).toBe('v3');
    expect(model.fields.nickname).toBe('莉茲');
    expect(model.fields.group_only_greetings).toHaveLength(1);
    expect(model.fields.source).toEqual(['https://example.invalid/cards/lisbeth']);
    expect(model.fields.assets?.[0]).toMatchObject({ type: 'icon', uri: 'ccdefault:' });
    expect(model.fields.creator_notes_multilingual?.['zh-TW']).toBeDefined();
    expect(model.fields.creation_date).toBe(1700000000);
  });

  it('preserves data-level fields no spec defines', () => {
    const model = normalizeCard(fixtureJson('v3-full.json'));
    expect(model.extraData.risu_extra).toEqual({ emotion_pack: 'lisbeth-v1' });
  });

  it('preserves root-level fields no spec defines', () => {
    const model = normalizeCard(fixtureJson('v2-with-root-mirror.json'));
    expect(model.extraRoot.avatar).toBe('none');
    expect(model.extraRoot.create_date).toBeDefined();
  });

  it('does not keep the stale flat V1 mirror at the root', () => {
    // SillyTavern writes a copy of the V1 fields next to `data`. Keeping those
    // would let a pre-edit value survive into the export.
    const model = normalizeCard(fixtureJson('v2-with-root-mirror.json'));
    expect(model.extraRoot).not.toHaveProperty('name');
    expect(model.extraRoot).not.toHaveProperty('description');
    expect(model.extraRoot).not.toHaveProperty('spec');
    expect(model.extraRoot).not.toHaveProperty('data');
  });

  it('fills required fields with empty defaults', () => {
    const model = normalizeCard({ name: 'x' });
    expect(model.fields.description).toBe('');
    expect(model.fields.alternate_greetings).toEqual([]);
    expect(model.fields.tags).toEqual([]);
    expect(model.fields.extensions).toEqual({});
    expect(model.fields.group_only_greetings).toEqual([]);
  });

  it('normalises lorebook entries without dropping unknown keys', () => {
    const model = normalizeCard(fixtureJson('v2-full.json'));
    const second = model.fields.character_book!.entries[1];
    expect(second.use_regex).toBe(false); // defaulted, V2 has no such field
    expect(second.enabled).toBe(true); // defaulted
    expect(second.risu_hidden_note).toBe('keep me'); // preserved
  });

  it('survives a lorebook with a malformed entry list', () => {
    const model = normalizeCard({ data: { name: 'x', character_book: { entries: 'nope' } } });
    expect(model.fields.character_book?.entries).toEqual([]);
  });

  it('coerces non-string scalars rather than crashing', () => {
    const model = normalizeCard({ name: 42, description: true, tags: ['a', null, 7] });
    expect(model.fields.name).toBe('42');
    expect(model.fields.description).toBe('true');
    expect(model.fields.tags).toEqual(['a', '7']);
  });
});

describe('reading files', () => {
  it('prefers the ccv3 chunk when both are present', async () => {
    const result = await readCardBytes(fixtureBytes('v2v3-dual-chunk.png'));
    expect(result.origin).toBe('ccv3');
    expect(result.model.fields.name).not.toBe('STALE V2 NAME');
    expect(result.warnings.join()).toContain('V3');
  });

  it('falls back to the chara chunk when there is no ccv3', async () => {
    const result = await readCardBytes(fixtureBytes('v2-chara.png'));
    expect(result.origin).toBe('chara');
    expect(result.model.sourceSpec).toBe('v2');
  });

  it('accepts a chunk holding raw JSON instead of base64', async () => {
    const result = await readCardBytes(fixtureBytes('v2-chara-raw-json.png'));
    expect(result.model.fields.name).toContain('莉茲貝特');
  });

  it('keeps the original PNG bytes for re-export', async () => {
    const original = fixtureBytes('v2-chara.png');
    const result = await readCardBytes(original);
    expect(result.imageBytes).toEqual(original);
  });

  it('reports a helpful error for an image with no card data', async () => {
    await expect(readCardBytes(fixtureBytes('no-card-data.png'))).rejects.toThrow(/沒有角色卡資料/);
  });

  it('reports a helpful error for malformed JSON', async () => {
    await expect(readCardBytes(new TextEncoder().encode('{not json'))).rejects.toThrow(/JSON/);
  });

  it('rejects formats it cannot handle yet by name', async () => {
    await expect(readCardBytes(new TextEncoder().encode('x'), 'card.charx')).rejects.toThrow(/CharX/);
  });
});
