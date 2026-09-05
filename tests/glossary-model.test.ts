/**
 * The glossary logic, exercised on cards assembled by hand so each rule is
 * visible in the test that covers it.
 *
 * The rules that matter most are the ones that decide whether a translated
 * lorebook entry still fires — `translatedKeysFor` — and the ones that stop a
 * later AI pass from quietly overwriting somebody's own wording — `mergeTerms`.
 */

import { describe, expect, it } from 'vitest';

import {
  CardFields,
  LorebookEntry,
  createEmptyCard,
  createEmptyLorebookEntry,
} from '../src/card';
import {
  GlossaryTerm,
  cardSections,
  duplicateTargets,
  glossaryReadiness,
  mergeTerms,
  parseSectionPath,
  scanUsage,
  sectionGroup,
  seedTerms,
  termsInText,
  translatedKeysFor,
  unappliedTerms,
} from '../src/glossary';

function card(overrides: Partial<CardFields> = {}): CardFields {
  return { ...createEmptyCard().fields, ...overrides };
}

function lore(entries: Partial<LorebookEntry>[]): CardFields['character_book'] {
  return {
    name: '',
    extensions: {},
    entries: entries.map((entry, i) => ({ ...createEmptyLorebookEntry(i), ...entry })),
  };
}

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

const paths = (fields: CardFields) => cardSections(fields).map((section) => section.path);

describe('cardSections', () => {
  it('skips empty fields', () => {
    expect(paths(card({ name: 'Kaelen', description: 'x', scenario: '   ' }))).toEqual([
      'name',
      'description',
    ]);
  });

  it('uses the same path keys as the translation UI', () => {
    const fields = card({
      description: 'd',
      alternate_greetings: ['a', '', 'c'],
      character_book: lore([{ content: 'one' }, { content: 'two' }]),
    });
    // `useTranslate` tracks status under exactly these keys.
    expect(paths(fields)).toEqual(['description', 'greeting:0', 'greeting:2', 'lore:0', 'lore:1']);
  });

  it('labels a lore section by its comment, falling back to its first key', () => {
    const fields = card({
      character_book: lore([
        { content: 'x', comment: '長老設定', keys: ['Elder'] },
        { content: 'y', keys: ['Ashfall Keep'] },
        { content: 'z' },
      ]),
    });
    const labels = cardSections(fields).map((section) => section.label);
    expect(labels).toEqual(['世界書 #1（長老設定）', '世界書 #2（Ashfall Keep）', '世界書 #3']);
  });
});

describe('parseSectionPath', () => {
  it('round-trips every path cardSections hands out', () => {
    // The two halves of the path grammar have to agree, or a translated field
    // would be written back to nowhere.
    const fields = card({
      name: 'n',
      description: 'd',
      creator_notes: 'c',
      system_prompt: 's',
      post_history_instructions: 'p',
      alternate_greetings: ['a', 'b'],
      character_book: lore([{ content: 'x' }, { content: 'y' }]),
    });

    for (const section of cardSections(fields)) {
      expect(parseSectionPath(section.path)).not.toBeNull();
    }
  });

  it('resolves each kind of path', () => {
    expect(parseSectionPath('description')).toEqual({ kind: 'field', key: 'description' });
    expect(parseSectionPath('greeting:2')).toEqual({ kind: 'greeting', index: 2 });
    expect(parseSectionPath('lore:0')).toEqual({ kind: 'lore', index: 0 });
  });

  it.each(['tags', 'extensions', 'greeting', 'greeting:', 'greeting:x', 'lore:1:keys', ''])(
    'rejects %p',
    (path) => {
      expect(parseSectionPath(path)).toBeNull();
    },
  );
});

describe('seedTerms', () => {
  it('takes the name, the nickname and every lorebook key for free', () => {
    const fields = card({
      name: 'Kaelen',
      nickname: 'Kael',
      character_book: lore([
        { keys: ['Grand Maiden Elder'], secondary_keys: ['Ashfall Keep'] },
        { keys: ['Emberwright'] },
      ]),
    });

    expect(seedTerms(fields).map((t) => t.source)).toEqual([
      'Kaelen',
      'Kael',
      'Grand Maiden Elder',
      'Ashfall Keep',
      'Emberwright',
    ]);
  });

  it('marks where each seed came from and leaves it undecided', () => {
    const seeded = seedTerms(card({ name: 'Kaelen', character_book: lore([{ keys: ['Keep'] }]) }));
    expect(seeded[0]).toEqual(term({ source: 'Kaelen', kind: 'person', origin: 'name' }));
    expect(seeded[1]).toEqual(term({ source: 'Keep', origin: 'lore-key' }));
  });

  it('skips keys that are genuinely patterns', () => {
    const fields = card({
      character_book: lore([
        { keys: ['^(the )?elders?$', 'stone|rock', '/ash.*/i'], use_regex: true },
        { keys: ['Emberwright'] },
      ]),
    });
    expect(seedTerms(fields).map((t) => t.source)).toEqual(['Emberwright']);
  });

  it('keeps plain keys on an entry whose regex flag is set', () => {
    // A real card had use_regex on all twenty entries while every key was an
    // ordinary word. Skipping on the flag alone lost the lot.
    const fields = card({
      character_book: lore([
        { keys: ['sacred shield', 'cathedral', 'sisters'], use_regex: true },
        { keys: ['C.H.I.P.'], use_regex: true },
      ]),
    });
    expect(seedTerms(fields).map((t) => t.source)).toEqual([
      'sacred shield',
      'cathedral',
      'sisters',
      'C.H.I.P.',
    ]);
  });

  it('keeps a key with brackets when the entry is not a regex entry', () => {
    const fields = card({ character_book: lore([{ keys: ['Elder (Grand)'] }]) });
    expect(seedTerms(fields).map((t) => t.source)).toEqual(['Elder (Grand)']);
  });

  it('skips macros and keys with no letters', () => {
    const fields = card({
      character_book: lore([{ keys: ['{{char}}', '{{user}}', '123', '---', '  ', 'Elder'] }]),
    });
    expect(seedTerms(fields).map((t) => t.source)).toEqual(['Elder']);
  });

  it('deduplicates keys that differ only in case', () => {
    const fields = card({
      character_book: lore([{ keys: ['Elder', 'elder'] }, { keys: ['ELDER'] }]),
    });
    expect(seedTerms(fields)).toHaveLength(1);
  });

  it('ignores tags, which classify the card rather than describe its world', () => {
    expect(seedTerms(card({ tags: ['fantasy', 'NSFW'] }))).toEqual([]);
  });
});

describe('sectionGroup', () => {
  it('separates the parts a translation can quietly break', () => {
    // `name` feeds every {{char}}; the directives are written for the model.
    expect(sectionGroup('name')).toBe('name');
    expect(sectionGroup('system_prompt')).toBe('directives');
    expect(sectionGroup('post_history_instructions')).toBe('directives');
    expect(sectionGroup('creator_notes')).toBe('notes');
    expect(sectionGroup('description')).toBe('core');
    expect(sectionGroup('mes_example')).toBe('core');
    expect(sectionGroup('greeting:3')).toBe('greetings');
    expect(sectionGroup('lore:12')).toBe('lore');
  });

  it('covers every path cardSections produces', () => {
    const fields = card({
      name: 'n',
      description: 'd',
      creator_notes: 'c',
      system_prompt: 's',
      post_history_instructions: 'p',
      alternate_greetings: ['a'],
      character_book: lore([{ content: 'x' }]),
    });
    for (const section of cardSections(fields)) {
      expect(sectionGroup(section.path)).toBeTruthy();
    }
  });
});

describe('glossaryReadiness', () => {
  const fields = card({
    character_book: lore([
      { keys: ['Elder'], content: 'a' },
      { keys: ['Keep'], content: 'b' },
      { keys: [], content: 'c' },
    ]),
  });

  it('counts what would and would not be translated', () => {
    const ready = glossaryReadiness(fields, [
      term({ source: 'Elder', target: '長老' }),
      term({ source: 'Keep' }),
      term({ source: 'Kaelen', keepOriginal: true }),
    ]);

    expect(ready).toEqual({
      terms: 3,
      decided: 2,
      undecided: 1,
      entriesWithKeys: 2,
      // Only the Elder entry can be given a translated key; Keep is undecided.
      entriesCovered: 1,
    });
  });

  it('reports an empty glossary as covering nothing', () => {
    expect(glossaryReadiness(fields, [])).toEqual({
      terms: 0,
      decided: 0,
      undecided: 0,
      entriesWithKeys: 2,
      entriesCovered: 0,
    });
  });

  it('does not count a kept-original term as covering its entry', () => {
    // Nothing is appended for a term staying in the source language, so the
    // entry gains no new key.
    const ready = glossaryReadiness(fields, [term({ source: 'Elder', keepOriginal: true })]);
    expect(ready.entriesCovered).toBe(0);
  });
});

describe('scanUsage', () => {
  const fields = card({
    description: 'The Grand Maiden Elder rules. The Grand Maiden Elder is old.',
    first_mes: 'Welcome to Ashfall Keep.',
    character_book: lore([{ keys: ['Emberwright'], content: 'A guild in Ashfall Keep.' }]),
  });

  it('reports each section a term appears in, with counts', () => {
    const [elder, keep] = scanUsage(fields, [
      term({ source: 'Grand Maiden Elder' }),
      term({ source: 'Ashfall Keep' }),
    ]);

    expect(elder.hits).toEqual([{ path: 'description', count: 2 }]);
    expect(elder.total).toBe(2);
    expect(keep.hits).toEqual([
      { path: 'first_mes', count: 1 },
      { path: 'lore:0', count: 1 },
    ]);
  });

  it('does not count a lorebook key as an occurrence of itself', () => {
    // Otherwise every seeded term would look used whether or not any prose
    // mentions it.
    const [ember] = scanUsage(fields, [term({ source: 'Emberwright' })]);
    expect(ember.total).toBe(0);
  });

  it('counts aliases too', () => {
    const [elder] = scanUsage(fields, [
      term({ source: 'Grand Maiden Elder', aliases: ['Ashfall Keep'] }),
    ]);
    // Two of the source term in description, one alias each in first_mes and lore:0.
    expect(elder.hits).toEqual([
      { path: 'description', count: 2 },
      { path: 'first_mes', count: 1 },
      { path: 'lore:0', count: 1 },
    ]);
    expect(elder.total).toBe(4);
  });

  it('is case-insensitive', () => {
    const [keep] = scanUsage(card({ description: 'ashfall KEEP' }), [term({ source: 'Ashfall Keep' })]);
    expect(keep.total).toBe(1);
  });
});

describe('term matching', () => {
  const present = (text: string, source: string, aliases: string[] = []) =>
    termsInText(text, [term({ source, aliases })]).length === 1;

  it('respects word boundaries in space-separated scripts', () => {
    expect(present('Kaelen walked in.', 'Kael')).toBe(false);
    expect(present('Kael walked in.', 'Kael')).toBe(true);
    expect(present('"Kael!" she said.', 'Kael')).toBe(true);
  });

  it('matches CJK by substring, where boundaries do not exist', () => {
    expect(present('聖女長老走了進來。', '聖女長老')).toBe(true);
    expect(present('他向聖女長老行禮', '聖女長老')).toBe(true);
  });

  it('treats regex metacharacters in a term as literal text', () => {
    expect(present('The C.H.I.P. unit.', 'C.H.I.P.')).toBe(true);
    expect(present('The CxHxIxPx unit.', 'C.H.I.P.')).toBe(false);
    expect(present('Elder (Grand) spoke.', 'Elder (Grand)')).toBe(true);
  });

  it('returns only the terms a text actually contains', () => {
    const terms = [term({ source: 'Kaelen' }), term({ source: 'Ashfall Keep' })];
    expect(termsInText('Kaelen went home.', terms).map((t) => t.source)).toEqual(['Kaelen']);
  });
});

describe('mergeTerms', () => {
  it('lets AI fill in a blank translation', () => {
    const merged = mergeTerms(
      [term({ source: 'Ashfall Keep', origin: 'lore-key' })],
      [term({ source: 'Ashfall Keep', target: '燼落堡', origin: 'ai' })],
    );
    expect(merged[0].target).toBe('燼落堡');
    expect(merged[0].origin).toBe('ai');
  });

  it('does not let AI overwrite a translation somebody chose', () => {
    const merged = mergeTerms(
      [term({ source: 'Elder', target: '聖女長老', origin: 'manual' })],
      [term({ source: 'Elder', target: '大女長老', origin: 'ai' })],
    );
    expect(merged[0].target).toBe('聖女長老');
  });

  it('lets a person overwrite an AI translation', () => {
    const merged = mergeTerms(
      [term({ source: 'Elder', target: '大女長老', origin: 'ai' })],
      [term({ source: 'Elder', target: '聖女長老', origin: 'manual' })],
    );
    expect(merged[0].target).toBe('聖女長老');
  });

  it('never overwrites a locked term, whatever the authority', () => {
    const merged = mergeTerms(
      [term({ source: 'Elder', target: '聖女長老', origin: 'ai', locked: true })],
      [term({ source: 'Elder', target: '大女長老', origin: 'manual' })],
    );
    expect(merged[0].target).toBe('聖女長老');
    expect(merged[0].locked).toBe(true);
  });

  it('unions aliases and keeps the more specific kind', () => {
    const merged = mergeTerms(
      [term({ source: 'Elder', aliases: ['the Elder'], kind: 'other' })],
      [term({ source: 'Elder', aliases: ['the Elder', 'Elders'], kind: 'title' })],
    );
    expect(merged[0].aliases).toEqual(['the Elder', 'Elders']);
    expect(merged[0].kind).toBe('title');
  });

  it('matches on the source case-insensitively but keeps the original spelling', () => {
    const merged = mergeTerms(
      [term({ source: 'Ashfall Keep' })],
      [term({ source: 'ashfall keep', target: '燼落堡' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('Ashfall Keep');
    expect(merged[0].target).toBe('燼落堡');
  });

  it('appends unknown terms without disturbing the existing order', () => {
    const merged = mergeTerms(
      [term({ source: 'A' }), term({ source: 'B' })],
      [term({ source: 'B', target: 'b' }), term({ source: 'C' })],
    );
    expect(merged.map((t) => t.source)).toEqual(['A', 'B', 'C']);
  });

  it('ignores incoming terms with no source', () => {
    expect(mergeTerms([term({ source: 'A' })], [term({ source: '  ' })])).toHaveLength(1);
  });
});

describe('duplicateTargets', () => {
  it('reports two terms sharing one translation', () => {
    const found = duplicateTargets([
      term({ source: 'Elder', target: '長老' }),
      term({ source: 'Elder Council', target: '長老' }),
      term({ source: 'Keep', target: '堡' }),
    ]);
    expect(found).toEqual([{ target: '長老', sources: ['Elder', 'Elder Council'] }]);
  });

  it('ignores undecided and kept-original terms', () => {
    expect(
      duplicateTargets([
        term({ source: 'A' }),
        term({ source: 'B' }),
        term({ source: 'C', target: 'x', keepOriginal: true }),
        term({ source: 'D', target: 'x', keepOriginal: true }),
      ]),
    ).toEqual([]);
  });
});

describe('unappliedTerms', () => {
  const terms = [
    term({ source: 'Grand Maiden Elder', target: '聖女長老' }),
    term({ source: 'Kaelen', keepOriginal: true }),
    term({ source: 'Emberwright' }),
  ];

  it('reports a term the translation failed to honour', () => {
    const missed = unappliedTerms(
      'The Grand Maiden Elder greeted Kaelen.',
      '大女長老向 Kaelen 問好。',
      terms,
    );
    expect(missed.map((t) => t.source)).toEqual(['Grand Maiden Elder']);
  });

  it('reports nothing when the agreed names were used', () => {
    expect(
      unappliedTerms('The Grand Maiden Elder greeted Kaelen.', '聖女長老向 Kaelen 問好。', terms),
    ).toEqual([]);
  });

  it('flags a kept-original term that got translated anyway', () => {
    const missed = unappliedTerms('Kaelen arrived.', '凱倫抵達了。', terms);
    expect(missed.map((t) => t.source)).toEqual(['Kaelen']);
  });

  it('says nothing about terms that are still undecided', () => {
    expect(unappliedTerms('Emberwright rose.', '某某會崛起了。', terms)).toEqual([]);
  });

  it('says nothing about terms the source never used', () => {
    expect(unappliedTerms('A quiet day.', '平靜的一天。', terms)).toEqual([]);
  });
});

describe('translatedKeysFor', () => {
  const terms = [
    term({ source: 'Grand Maiden Elder', target: '聖女長老', aliases: ['the Elder'] }),
    term({ source: 'Kaelen', target: '凱倫', keepOriginal: true }),
    term({ source: 'Emberwright' }),
  ];

  it('returns the agreed translation, which is what makes the entry fire', () => {
    // The key has to be the term as it appears in the translated text; taking
    // both from the glossary is the only thing that guarantees they agree.
    expect(translatedKeysFor(['Grand Maiden Elder'], terms)).toEqual(['聖女長老']);
  });

  it('resolves an alias to the same translation', () => {
    expect(translatedKeysFor(['the Elder'], terms)).toEqual(['聖女長老']);
  });

  it('matches a key case-insensitively and ignores surrounding space', () => {
    expect(translatedKeysFor(['  grand maiden elder '], terms)).toEqual(['聖女長老']);
  });

  it('adds nothing for kept-original, undecided or unknown keys', () => {
    expect(translatedKeysFor(['Kaelen', 'Emberwright', 'Something Else'], terms)).toEqual([]);
  });

  it('does not add a key the entry already has', () => {
    expect(translatedKeysFor(['Grand Maiden Elder', '聖女長老'], terms)).toEqual([]);
  });

  it('does not repeat itself when two keys share a translation', () => {
    expect(translatedKeysFor(['Grand Maiden Elder', 'the Elder'], terms)).toEqual(['聖女長老']);
  });
});
