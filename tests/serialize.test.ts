import { describe, expect, it } from 'vitest';

import {
  normalizeCard,
  serializeCard,
  toMaxCompatible,
  toSpecV1,
  toSpecV2,
  toSpecV3,
} from '../src/card/model';
import { V1_FIELDS } from '../src/card/spec';
import { fixtureJson } from './helpers';

const v3Model = () => normalizeCard(fixtureJson('v3-full.json'));
const v2Model = () => normalizeCard(fixtureJson('v2-full.json'));

describe('toSpecV1', () => {
  it('emits exactly the six V1 fields and nothing else', () => {
    expect(Object.keys(toSpecV1(v3Model())).sort()).toEqual([...V1_FIELDS].sort());
  });

  it('carries the character content down from a V3 card', () => {
    expect(toSpecV1(v3Model()).name).toContain('莉茲貝特');
  });
});

describe('toSpecV2', () => {
  it('emits the correct envelope', () => {
    const out = toSpecV2(v3Model());
    expect(out.spec).toBe('chara_card_v2');
    expect(out.spec_version).toBe('2.0');
    expect(out.data).toBeTypeOf('object');
  });

  it('always includes every required V2 field', () => {
    const out = toSpecV2(normalizeCard({ name: 'minimal' }));
    for (const key of [
      'name',
      'description',
      'personality',
      'scenario',
      'first_mes',
      'mes_example',
      'creator_notes',
      'system_prompt',
      'post_history_instructions',
      'alternate_greetings',
      'tags',
      'creator',
      'character_version',
      'extensions',
    ]) {
      expect(out.data, `missing required V2 field: ${key}`).toHaveProperty(key);
    }
  });

  it('does not leak V3-only fields into a V2 export', () => {
    const out = toSpecV2(v3Model());
    for (const key of ['assets', 'nickname', 'group_only_greetings', 'source']) {
      expect(out.data).not.toHaveProperty(key);
    }
  });

  it('keeps unmodelled data fields', () => {
    expect(toSpecV2(v3Model()).data).toHaveProperty('risu_extra');
  });

  it('omits an empty character_book rather than emitting a hollow one', () => {
    const model = normalizeCard({ data: { name: 'x', character_book: { entries: [] } } });
    expect(toSpecV2(model).data).not.toHaveProperty('character_book');
  });

  it('keeps a character_book that has entries', () => {
    expect(toSpecV2(v2Model()).data.character_book?.entries).toHaveLength(2);
  });
});

describe('toSpecV3', () => {
  it('emits the correct envelope', () => {
    const out = toSpecV3(v2Model());
    expect(out.spec).toBe('chara_card_v3');
    expect(out.spec_version).toBe('3.0');
  });

  it('includes group_only_greetings even when the source was V2', () => {
    // It is a required V3 field, so it must be present (empty is fine).
    expect(toSpecV3(v2Model()).data.group_only_greetings).toEqual([]);
  });

  it('carries every V3-only field through', () => {
    const out = toSpecV3(v3Model());
    expect(out.data.nickname).toBe('莉茲');
    expect(out.data.assets).toHaveLength(1);
    expect(out.data.source).toHaveLength(1);
    expect(out.data.creation_date).toBe(1700000000);
  });

  it('gives every lorebook entry the V3-required use_regex flag', () => {
    for (const entry of toSpecV3(v2Model()).data.character_book!.entries) {
      expect(entry).toHaveProperty('use_regex');
      expect(typeof entry.use_regex).toBe('boolean');
    }
  });
});

describe('toMaxCompatible', () => {
  const max = () => toMaxCompatible(v3Model());

  it('exposes the flat V1 fields at the root for a V1-only reader', () => {
    const out = max();
    for (const key of V1_FIELDS) {
      expect(out, `V1 reader needs root.${key}`).toHaveProperty(key);
    }
    expect(out.name).toContain('莉茲貝特');
  });

  it('declares the V3 spec so newer readers use data', () => {
    expect(max().spec).toBe('chara_card_v3');
    expect(max().spec_version).toBe('3.0');
  });

  it('carries the full V3 data payload', () => {
    const data = max().data as Record<string, unknown>;
    expect(data.nickname).toBe('莉茲');
    expect(data.character_book).toBeDefined();
  });

  it('keeps the root and data views of a field in agreement', () => {
    const out = max();
    const data = out.data as Record<string, unknown>;
    for (const key of V1_FIELDS) {
      expect(out[key]).toBe(data[key]);
    }
  });
});

describe('serializeCard dispatch', () => {
  it('routes each spec name to the right serialiser', () => {
    const model = v3Model();
    expect(serializeCard(model, 'v1')).toEqual(toSpecV1(model));
    expect(serializeCard(model, 'v2')).toEqual(toSpecV2(model));
    expect(serializeCard(model, 'v3')).toEqual(toSpecV3(model));
    expect(serializeCard(model, 'max')).toEqual(toMaxCompatible(model));
  });

  it('produces JSON-serialisable output with no undefined holes', () => {
    for (const spec of ['v1', 'v2', 'v3', 'max'] as const) {
      const json = JSON.stringify(serializeCard(v3Model(), spec));
      expect(json).not.toContain('undefined');
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });
});
