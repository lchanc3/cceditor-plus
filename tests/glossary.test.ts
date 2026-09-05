/**
 * The glossary is only useful if it is still there next time the card is opened,
 * so these tests are the same shape as `roundtrip.test.ts`: write it, export it,
 * read it back, check nothing moved.
 */

import { describe, expect, it } from 'vitest';

import { CardFields, CardModel, ExportSpec, normalizeCard } from '../src/card';
import { readCardBytes } from '../src/card/read';
import { buildCardJson, buildCardPng } from '../src/card/write';
import {
  GLOSSARY_NAMESPACE,
  GlossaryTerm,
  TranslationMeta,
  clearTranslationMeta,
  createTranslationMeta,
  hasTranslationMeta,
  readTranslationMeta,
  writeTranslationMeta,
} from '../src/glossary';
import { fixtureBytes, fixtureJson } from './helpers';

const encode = (text: string) => new TextEncoder().encode(text);

function term(partial: Partial<GlossaryTerm> & { source: string }): GlossaryTerm {
  return {
    target: '',
    aliases: [],
    kind: 'other',
    origin: 'ai',
    locked: false,
    keepOriginal: false,
    ...partial,
  };
}

/** Covers every optional field, so an omission shows up as a failure. */
const META: TranslationMeta = createTranslationMeta({
  sourceLang: 'English',
  targetLang: '繁體中文',
  styleNotes: '第二人稱用「你」不用「您」；長老對主角固定稱「孩子」。',
  updatedAt: 1757030400,
  glossary: [
    term({
      source: 'Grand Maiden Elder',
      target: '聖女長老',
      aliases: ['the Elder', 'Grand Maiden'],
      kind: 'title',
      origin: 'lore-key',
      locked: true,
    }),
    term({ source: 'Ashfall Keep', target: '燼落堡', kind: 'place' }),
    term({ source: 'Kaelen', kind: 'person', origin: 'manual', keepOriginal: true }),
    // Extracted but not yet decided: the whole point of persisting is not
    // paying for the extraction pass twice.
    term({ source: 'Emberwright', kind: 'org' }),
  ],
});

function withMeta(model: CardModel, meta: TranslationMeta = META): CardModel {
  return {
    ...model,
    fields: { ...model.fields, extensions: writeTranslationMeta(model.fields, meta) },
  };
}

function loadFixture(): CardModel {
  return normalizeCard(fixtureJson('v3-full.json'));
}

async function reimportJson(model: CardModel, spec: ExportSpec): Promise<CardModel> {
  const result = await readCardBytes(encode(buildCardJson(model, spec)), 'exported.json');
  return result.model;
}

/** The raw stored block, as it sits inside `data.extensions`. */
function storedBlock(fields: CardFields): Record<string, unknown> {
  return fields.extensions[GLOSSARY_NAMESPACE] as Record<string, unknown>;
}

describe('glossary round trip', () => {
  it.each(['v2', 'v3', 'max'] as ExportSpec[])(
    'survives a %s JSON export intact',
    async (spec) => {
      const reloaded = await reimportJson(withMeta(loadFixture()), spec);
      expect(readTranslationMeta(reloaded.fields)).toEqual(META);
    },
  );

  it('survives a PNG export intact', async () => {
    const source = await readCardBytes(fixtureBytes('v2-chara.png'));
    const png = buildCardPng(withMeta(source.model), source.imageBytes!);
    const reloaded = await readCardBytes(png);
    expect(readTranslationMeta(reloaded.model.fields)).toEqual(META);
  });

  it('survives five consecutive save/load cycles unchanged', async () => {
    let model = withMeta(loadFixture());
    const snapshot = buildCardJson(model, 'max');
    for (let i = 0; i < 5; i++) model = await reimportJson(model, 'max');
    expect(buildCardJson(model, 'max')).toBe(snapshot);
    expect(readTranslationMeta(model.fields)).toEqual(META);
  });

  it('is idempotent — reading and rewriting changes nothing', () => {
    const once = withMeta(loadFixture());
    const twice = withMeta(once, readTranslationMeta(once.fields)!);
    expect(twice.fields.extensions).toEqual(once.fields.extensions);
  });

  it('is lost in a V1 export, because V1 has no extensions at all', async () => {
    const reloaded = await reimportJson(withMeta(loadFixture()), 'v1');
    expect(hasTranslationMeta(reloaded.fields)).toBe(false);
  });
});

describe('glossary storage and the rest of the card', () => {
  it('leaves other extensions untouched', () => {
    const original = loadFixture();
    const written = withMeta(original);

    // The fixture carries SillyTavern's own extension data.
    expect(written.fields.extensions.talkativeness).toBe(original.fields.extensions.talkativeness);
    expect(written.fields.extensions.fav).toBe(original.fields.extensions.fav);
    expect(written.fields.extensions.depth_prompt).toEqual(original.fields.extensions.depth_prompt);
  });

  it('does not mutate the card it was given', () => {
    const original = loadFixture();
    const before = JSON.stringify(original.fields.extensions);
    writeTranslationMeta(original.fields, META);
    expect(JSON.stringify(original.fields.extensions)).toBe(before);
  });

  it('carries through unknown keys written by a future build', () => {
    const original = loadFixture();
    const seeded: CardModel = {
      ...original,
      fields: {
        ...original.fields,
        extensions: {
          ...original.fields.extensions,
          [GLOSSARY_NAMESPACE]: { v: 99, somethingNew: { keep: 'me' } },
        },
      },
    };

    expect(storedBlock(withMeta(seeded).fields).somethingNew).toEqual({ keep: 'me' });
  });

  it('clears only its own block', () => {
    const written = withMeta(loadFixture());
    const cleared = clearTranslationMeta(written.fields);
    expect(cleared[GLOSSARY_NAMESPACE]).toBeUndefined();
    expect(cleared.talkativeness).toBe(written.fields.extensions.talkativeness);
  });
});

describe('stored payload', () => {
  it('omits every default rather than spelling it out', () => {
    const json = JSON.stringify(storedBlock(withMeta(loadFixture()).fields));

    expect(json).not.toContain('"l":false');
    expect(json).not.toContain('"keep":false');
    expect(json).not.toContain('"a":[]');
    expect(json).not.toContain('"t":""');
    expect(json).not.toContain('"k":"other"');
    // Occurrence counts are derived data and must not be persisted.
    expect(json).not.toContain('hits');
  });

  it('stays small enough to ride inside a PNG chunk', () => {
    const many = createTranslationMeta({
      glossary: Array.from({ length: 200 }, (_, i) =>
        term({ source: `Term Number ${i}`, target: `第${i}號術語`, kind: 'concept' }),
      ),
      styleNotes: 'x',
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify(storedBlock(withMeta(loadFixture(), many).fields)),
    );
    // base64 inflates by 4/3 on the way into the tEXt chunk.
    expect(Math.ceil((bytes.length * 4) / 3)).toBeLessThan(40 * 1024);
  });

  it('writes nothing at all when there is nothing to say', () => {
    const written = withMeta(loadFixture(), createTranslationMeta({ targetLang: '繁體中文' }));
    expect(written.fields.extensions[GLOSSARY_NAMESPACE]).toBeUndefined();
  });

  it('drops a block that was written and then emptied', () => {
    const written = withMeta(loadFixture());
    const emptied = withMeta(written, createTranslationMeta());
    expect(emptied.fields.extensions[GLOSSARY_NAMESPACE]).toBeUndefined();
    expect(emptied.fields.extensions.talkativeness).toBeDefined();
  });
});

describe('reading a hand-edited or damaged block', () => {
  const read = (stored: unknown): TranslationMeta | null => {
    const fields = { ...loadFixture().fields };
    fields.extensions = { ...fields.extensions, [GLOSSARY_NAMESPACE]: stored };
    return readTranslationMeta(fields);
  };

  it('returns null when there is no block', () => {
    expect(readTranslationMeta(loadFixture().fields)).toBeNull();
  });

  it.each([null, 'nonsense', 42, [], { v: 1 }, { v: 1, glossary: [] }])(
    'returns null for %p',
    (stored) => {
      expect(read(stored)).toBeNull();
    },
  );

  it('skips entries that are not usable terms', () => {
    const meta = read({
      v: 1,
      glossary: [null, 'string', { t: '沒有原文' }, { s: '   ' }, { s: 'Kept', t: '留下' }],
    });
    expect(meta?.glossary.map((t) => t.source)).toEqual(['Kept']);
  });

  it('falls back to safe values for unknown kind and origin', () => {
    const meta = read({ v: 1, glossary: [{ s: 'X', t: 'Y', k: 'weapon', o: 'telepathy' }] });
    expect(meta?.glossary[0].kind).toBe('other');
    // Not 'ai' — an unattributable term must outrank a later AI pass.
    expect(meta?.glossary[0].origin).toBe('import');
  });

  it('keeps the first of two entries for the same term, ignoring case', () => {
    const meta = read({
      v: 1,
      glossary: [
        { s: 'Grand Maiden Elder', t: '聖女長老' },
        { s: 'grand maiden elder', t: '大女長老' },
      ],
    });
    expect(meta?.glossary).toHaveLength(1);
    expect(meta?.glossary[0].target).toBe('聖女長老');
  });

  it('drops aliases that just restate the source', () => {
    const meta = read({
      v: 1,
      glossary: [{ s: 'Kaelen', t: '凱倫', a: ['kaelen', 'Kaelen', 'Kael', 'Kael'] }],
    });
    expect(meta?.glossary[0].aliases).toEqual(['Kael']);
  });

  it('trims whitespace and ignores a non-array glossary', () => {
    expect(read({ v: 1, glossary: { s: 'X' }, styleNotes: '  用「你」  ' })?.styleNotes).toBe(
      '用「你」',
    );
    expect(read({ v: 1, glossary: [{ s: '  Ashfall Keep  ', t: '  燼落堡 ' }] })?.glossary[0]).toEqual(
      term({ source: 'Ashfall Keep', target: '燼落堡', origin: 'import' }),
    );
  });

  it('ignores a non-numeric updatedAt', () => {
    expect(read({ v: 1, glossary: [{ s: 'X' }], updatedAt: 'yesterday' })?.updatedAt).toBeUndefined();
  });
});
