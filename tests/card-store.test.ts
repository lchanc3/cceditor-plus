/**
 * The reducer, with the glossary rules that matter most:
 *
 * - the working copy and the copy on the card never drift apart, because
 *   whatever is in state is what a draft save and an export will carry;
 * - an AI pass fills blanks but never overwrites a decision;
 * - reopening a card restores the names it was translated with.
 */

import { describe, expect, it } from 'vitest';

import {
  CardModel,
  createEmptyCard,
  createEmptyLorebookEntry,
  normalizeCard,
} from '../src/card';
import {
  GLOSSARY_NAMESPACE,
  GlossaryTerm,
  createTerm,
  createTranslationMeta,
  readTranslationMeta,
} from '../src/glossary';
import { CardAction, CardState, cardReducer, initialCardState } from '../src/state/cardStore';

function run(state: CardState, ...actions: CardAction[]): CardState {
  return actions.reduce(cardReducer, state);
}

function loaded(model: CardModel = createEmptyCard()): CardState {
  return cardReducer(initialCardState, { type: 'load', model, origin: 'json', warnings: [] });
}

/** A card with a lorebook, so seeding has something to find. */
function worldCard(): CardModel {
  const model = createEmptyCard();
  model.fields.name = 'Kaelen';
  model.fields.description = 'The Grand Maiden Elder rules Ashfall Keep.';
  model.fields.character_book = {
    name: '',
    extensions: {},
    entries: [
      {
        ...createEmptyLorebookEntry(0),
        keys: ['Grand Maiden Elder'],
        content: 'She has ruled for eighty years.',
      },
      { ...createEmptyLorebookEntry(1), keys: ['Ashfall Keep'], content: 'A fortress of ash.' },
    ],
  };
  return model;
}

const terms = (state: CardState): GlossaryTerm[] => state.glossary.glossary;

/** The glossary as it would actually be exported, read back off the card. */
const onCard = (state: CardState) => readTranslationMeta(state.model!.fields);

describe('glossary lives on the card', () => {
  it('starts empty and writes nothing into extensions', () => {
    const state = loaded();
    expect(state.glossary).toEqual(createTranslationMeta());
    expect(state.model!.fields.extensions[GLOSSARY_NAMESPACE]).toBeUndefined();
  });

  it('mirrors every change onto the card', () => {
    const state = run(loaded(), {
      type: 'glossary.addTerm',
      term: createTerm({ source: 'Ashfall Keep', target: '燼落堡' }),
    });

    // What a draft save and an export will carry has to match what the UI shows.
    expect(onCard(state)?.glossary).toEqual(state.glossary.glossary);
    expect(state.dirty).toBe(true);
  });

  it('restores the glossary when the card is loaded again', () => {
    const saved = run(loaded(), {
      type: 'glossary.addTerm',
      term: createTerm({ source: 'Elder', target: '聖女長老', locked: true }),
    });

    const reopened = loaded(saved.model!);
    expect(terms(reopened)).toEqual(terms(saved));
    expect(reopened.dirty).toBe(false);
  });

  it('survives a round trip through the exported JSON', async () => {
    const { buildCardJson } = await import('../src/card/write');
    const saved = run(loaded(worldCard()), { type: 'glossary.seed' }, {
      type: 'glossary.merge',
      terms: [createTerm({ source: 'Ashfall Keep', target: '燼落堡', origin: 'ai' })],
    });

    const reopened = loaded(normalizeCard(JSON.parse(buildCardJson(saved.model!, 'max'))));
    expect(terms(reopened)).toEqual(terms(saved));
  });

  it('restores it from a draft too', () => {
    const saved = run(loaded(), {
      type: 'glossary.addTerm',
      term: createTerm({ source: 'Elder', target: '聖女長老' }),
    });
    // A draft stores the model, so the glossary rides along with no extra work.
    const restored = cardReducer(initialCardState, { type: 'restore', model: saved.model! });
    expect(terms(restored)).toEqual(terms(saved));
  });

  it('leaves other extensions alone', () => {
    const model = createEmptyCard();
    model.fields.extensions = { talkativeness: '0.5', fav: false };

    const state = run(loaded(model), {
      type: 'glossary.addTerm',
      term: createTerm({ source: 'Elder', target: '長老' }),
    });

    expect(state.model!.fields.extensions.talkativeness).toBe('0.5');
    expect(state.model!.fields.extensions.fav).toBe(false);
  });

  it('removes the block from the card when cleared', () => {
    const state = run(
      loaded(),
      { type: 'glossary.addTerm', term: createTerm({ source: 'Elder', target: '長老' }) },
      { type: 'glossary.clear' },
    );

    expect(terms(state)).toEqual([]);
    expect(state.model!.fields.extensions[GLOSSARY_NAMESPACE]).toBeUndefined();
  });

  it('does nothing at all without a card', () => {
    const state = cardReducer(initialCardState, {
      type: 'glossary.addTerm',
      term: createTerm({ source: 'Elder' }),
    });
    expect(state).toBe(initialCardState);
  });
});

describe('seeding and merging', () => {
  it('seeds from the name and the lorebook keys', () => {
    const state = run(loaded(worldCard()), { type: 'glossary.seed' });
    expect(terms(state).map((t) => t.source)).toEqual([
      'Kaelen',
      'Grand Maiden Elder',
      'Ashfall Keep',
    ]);
    expect(terms(state).every((t) => t.target === '')).toBe(true);
  });

  it('seeding twice adds nothing the second time', () => {
    const once = run(loaded(worldCard()), { type: 'glossary.seed' });
    const twice = run(once, { type: 'glossary.seed' });
    expect(terms(twice)).toEqual(terms(once));
  });

  it('lets an AI pass fill a blank translation', () => {
    const state = run(loaded(worldCard()), { type: 'glossary.seed' }, {
      type: 'glossary.merge',
      terms: [createTerm({ source: 'Ashfall Keep', target: '燼落堡', origin: 'ai' })],
    });

    expect(terms(state).find((t) => t.source === 'Ashfall Keep')?.target).toBe('燼落堡');
  });

  it('does not let an AI pass overwrite a translation somebody typed', () => {
    const state = run(
      loaded(worldCard()),
      { type: 'glossary.seed' },
      { type: 'glossary.patchTerm', index: 1, patch: { target: '聖女長老' } },
      {
        type: 'glossary.merge',
        terms: [createTerm({ source: 'Grand Maiden Elder', target: '大女長老', origin: 'ai' })],
      },
    );

    expect(terms(state)[1].target).toBe('聖女長老');
  });
});

describe('editing terms', () => {
  const seeded = () => run(loaded(worldCard()), { type: 'glossary.seed' });

  it('marks a translation somebody typed as theirs', () => {
    // Seeds arrive as `lore-key`; without this the next AI pass could outrank
    // a person's own wording.
    const state = run(seeded(), { type: 'glossary.patchTerm', index: 1, patch: { target: '聖女長老' } });
    expect(terms(state)[1].origin).toBe('manual');
  });

  it('does the same for a decision to keep the original', () => {
    const state = run(seeded(), {
      type: 'glossary.patchTerm',
      index: 0,
      patch: { keepOriginal: true },
    });
    expect(terms(state)[0].origin).toBe('manual');
  });

  it('leaves the origin alone for edits that are not decisions', () => {
    const state = run(seeded(), { type: 'glossary.patchTerm', index: 1, patch: { kind: 'title' } });
    expect(terms(state)[1].origin).toBe('lore-key');
    expect(terms(state)[1].kind).toBe('title');
  });

  it('respects an origin the caller gave explicitly', () => {
    const state = run(seeded(), {
      type: 'glossary.patchTerm',
      index: 1,
      patch: { target: '聖女長老', origin: 'import' },
    });
    expect(terms(state)[1].origin).toBe('import');
  });

  it('removes a term', () => {
    const state = run(seeded(), { type: 'glossary.removeTerm', index: 0 });
    expect(terms(state).map((t) => t.source)).toEqual(['Grand Maiden Elder', 'Ashfall Keep']);
  });

  it('keeps style notes and languages on the card', () => {
    const state = run(
      loaded(),
      { type: 'glossary.setStyleNotes', notes: '第二人稱用「你」。' },
      { type: 'glossary.setLangs', targetLang: '繁體中文' },
    );

    expect(onCard(state)?.styleNotes).toBe('第二人稱用「你」。');
    expect(onCard(state)?.targetLang).toBe('繁體中文');
  });
});

describe('section.set', () => {
  const withCard = () =>
    loaded({
      ...worldCard(),
      fields: { ...worldCard().fields, alternate_greetings: ['first', 'second'] },
    });

  it('writes back to a plain field', () => {
    const state = run(withCard(), { type: 'section.set', path: 'description', value: '譯文' });
    expect(state.model!.fields.description).toBe('譯文');
    expect(state.dirty).toBe(true);
  });

  it('writes back to a greeting', () => {
    const state = run(withCard(), { type: 'section.set', path: 'greeting:1', value: '第二句' });
    expect(state.model!.fields.alternate_greetings).toEqual(['first', '第二句']);
  });

  it('writes back to a lorebook entry, leaving its keys alone', () => {
    const state = run(withCard(), { type: 'section.set', path: 'lore:0', value: '她統治了八十年。' });
    const entry = state.model!.fields.character_book!.entries[0];
    expect(entry.content).toBe('她統治了八十年。');
    expect(entry.keys).toEqual(['Grand Maiden Elder']);
  });

  it('ignores a path it does not recognise', () => {
    const before = withCard();
    expect(run(before, { type: 'section.set', path: 'tags', value: 'x' })).toBe(before);
  });

  it('ignores an index that no longer exists', () => {
    // Paths are captured before a translation run and can outlive the entry
    // they named; growing a sparse array instead would corrupt the card.
    const before = withCard();
    expect(run(before, { type: 'section.set', path: 'greeting:9', value: 'x' })).toBe(before);
    expect(run(before, { type: 'section.set', path: 'lore:9', value: 'x' })).toBe(before);
  });
});

describe('lore.addKeyList', () => {
  const withEntry = () => loaded(worldCard());

  it('appends translated keys without replacing the originals', () => {
    const state = run(withEntry(), {
      type: 'lore.addKeyList',
      index: 0,
      field: 'keys',
      keys: ['聖女長老'],
    });

    expect(state.model!.fields.character_book!.entries[0].keys).toEqual([
      'Grand Maiden Elder',
      '聖女長老',
    ]);
  });

  it('does not split on commas, which a translated term may contain', () => {
    const state = run(withEntry(), {
      type: 'lore.addKeyList',
      index: 0,
      field: 'keys',
      keys: ['長老, 大人'],
    });
    expect(state.model!.fields.character_book!.entries[0].keys).toContain('長老, 大人');
  });

  it('skips keys the entry already has, and blank ones', () => {
    const state = run(withEntry(), {
      type: 'lore.addKeyList',
      index: 0,
      field: 'keys',
      keys: ['Grand Maiden Elder', '  ', '聖女長老'],
    });
    expect(state.model!.fields.character_book!.entries[0].keys).toEqual([
      'Grand Maiden Elder',
      '聖女長老',
    ]);
  });

  it('still splits a raw string for the manual input box', () => {
    const state = run(withEntry(), {
      type: 'lore.addKeys',
      index: 1,
      field: 'secondary_keys',
      raw: '燼落堡, 灰堡',
    });
    expect(state.model!.fields.character_book!.entries[1].secondary_keys).toEqual([
      '燼落堡',
      '灰堡',
    ]);
  });
});
