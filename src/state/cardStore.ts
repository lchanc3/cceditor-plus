import { useCallback, useMemo, useReducer } from 'react';

import {
  CardFields,
  CardModel,
  CardOrigin,
  Lorebook,
  LorebookEntry,
  createEmptyCard,
  createEmptyLorebookEntry,
} from '../card';
import {
  GlossaryTerm,
  TranslationMeta,
  createTranslationMeta,
  mergeTerms,
  parseSectionPath,
  readTranslationMeta,
  seedTerms,
  writeTranslationMeta,
} from '../glossary';

/**
 * The other version of one section: what pressing revert would put back.
 *
 * Per section rather than per card, because that is the shape of the problem. A
 * run of twenty sections comes back with nineteen good ones and a refusal
 * written over the twentieth, and what is wanted is that one entry back, not
 * the other nineteen thrown away.
 *
 * A swap rather than a one-way restore: reverting stores whatever was on the
 * card as the new `other`, so pressing again brings the translation back and a
 * mis-click costs nothing. It also means an edit made after the run is not lost
 * by reverting — it becomes the thing revert would return to.
 */
export interface SectionRevert {
  other: string;
  /** Whether the card currently shows the pre-translation text, for the label. */
  reverted: boolean;
}

export interface CardState {
  model: CardModel | null;
  /** Original PNG bytes, reused verbatim when exporting so artwork is untouched. */
  imageBytes: Uint8Array | null;
  origin: CardOrigin | null;
  warnings: string[];
  dirty: boolean;
  /**
   * The working copy of what is also written into `model.fields.extensions`.
   *
   * Both are kept in step by `withGlossary`, which is the only thing that
   * changes either. The card stays the single source of truth — so the draft
   * and every export carry the glossary without any extra plumbing — while this
   * saves the viewer from reparsing the extensions object on every render.
   */
  glossary: TranslationMeta;
  /** By section path. Written when a translation lands; dropped with the card. */
  reverts: Record<string, SectionRevert>;
}

export type KeyField = 'keys' | 'secondary_keys';

export type CardAction =
  | { type: 'load'; model: CardModel; imageBytes?: Uint8Array; origin: CardOrigin; warnings: string[] }
  | {
      type: 'restore';
      model: CardModel;
      imageBytes?: Uint8Array;
      reverts?: Record<string, SectionRevert>;
    }
  | { type: 'revert'; path: string }
  | { type: 'setField'; key: keyof CardFields; value: CardFields[keyof CardFields] }
  /** Write back to whatever `cardSections` called `path`. Unknown paths are ignored. */
  | { type: 'section.set'; path: string; value: string; previous?: string }
  | { type: 'greeting.set'; index: number; value: string }
  | { type: 'greeting.add' }
  | { type: 'greeting.remove'; index: number }
  | { type: 'greeting.move'; index: number; direction: -1 | 1 }
  | { type: 'lore.add' }
  | { type: 'lore.remove'; index: number }
  | { type: 'lore.patch'; index: number; patch: Partial<LorebookEntry> }
  | { type: 'lore.addKeys'; index: number; field: KeyField; raw: string }
  /** Appends already-split keys — translated terms may contain a comma. */
  | { type: 'lore.addKeyList'; index: number; field: KeyField; keys: string[] }
  | { type: 'lore.removeKey'; index: number; field: KeyField; keyIndex: number }
  | { type: 'lore.patchBook'; patch: Partial<Lorebook> }
  | { type: 'glossary.set'; meta: TranslationMeta }
  | { type: 'glossary.merge'; terms: GlossaryTerm[] }
  | { type: 'glossary.seed' }
  | { type: 'glossary.addTerm'; term: GlossaryTerm }
  | { type: 'glossary.patchTerm'; index: number; patch: Partial<GlossaryTerm> }
  | { type: 'glossary.removeTerm'; index: number }
  | { type: 'glossary.setStyleNotes'; notes: string }
  | { type: 'glossary.setLangs'; sourceLang?: string; targetLang?: string }
  | { type: 'glossary.clear' }
  | { type: 'replaceImage'; bytes: Uint8Array }
  | { type: 'dismissWarnings' }
  | { type: 'reset' };

export const initialCardState: CardState = {
  model: null,
  imageBytes: null,
  origin: null,
  warnings: [],
  dirty: false,
  glossary: createTranslationMeta(),
  reverts: {},
};

/** Splitting on both ASCII and full-width separators; card authors use either. */
export function splitKeys(raw: string): string[] {
  return raw
    .split(/[,、，;；]/)
    .map((key) => key.trim())
    .filter((key) => key !== '');
}

function withFields(state: CardState, fields: Partial<CardFields>): CardState {
  if (!state.model) return state;
  return {
    ...state,
    model: { ...state.model, fields: { ...state.model.fields, ...fields } },
    dirty: true,
  };
}

function emptyBook(): Lorebook {
  return { name: '', extensions: {}, entries: [] };
}

function withEntries(state: CardState, update: (entries: LorebookEntry[]) => LorebookEntry[]): CardState {
  if (!state.model) return state;
  const book = state.model.fields.character_book ?? emptyBook();
  return withFields(state, { character_book: { ...book, entries: update(book.entries) } });
}

/** Append keys the entry does not already carry. */
/**
 * Append the keys this entry does not already carry.
 *
 * The list being added is checked against itself as it goes, not only against
 * the keys already there. A batch of translated keys routinely repeats itself,
 * because several spellings of one thing translate to one word: an entry keyed
 * on `7 yo`, `7 year-old`, `7 years old` and `age: 7` gets four identical 7歲
 * back, and a fixed "not already present" test lets all four through.
 *
 * Case is ignored, which is what an entry does by default. A key that differs
 * from an existing one only in case is not a second trigger worth carrying —
 * and nothing appended here is ever a deliberate case variant, since it comes
 * from the glossary or from a translator.
 */
function appendKeys(entry: LorebookEntry, field: KeyField, keys: string[]): LorebookEntry {
  const current = entry[field] ?? [];
  const seen = new Set(current.map((key) => key.trim().toLowerCase()));
  const added: string[] = [];

  for (const raw of keys) {
    const key = raw.trim();
    const folded = key.toLowerCase();
    if (key === '' || seen.has(folded)) continue;
    seen.add(folded);
    added.push(key);
  }

  return added.length === 0 ? entry : { ...entry, [field]: [...current, ...added] };
}

/**
 * The one place the glossary changes, so the working copy and the copy on the
 * card cannot drift apart.
 */
/**
 * One section's text, or null when the path names nothing on this card.
 *
 * Shared by the write and the revert so they cannot disagree about what a path
 * points at — a revert that read a different field than the translation wrote
 * would put the wrong text in the wrong place.
 */
export function sectionText(fields: CardFields, path: string): string | null {
  const target = parseSectionPath(path);
  if (!target) return null;

  if (target.kind === 'field') {
    const value = fields[target.key];
    return typeof value === 'string' ? value : null;
  }
  if (target.kind === 'greeting') {
    return fields.alternate_greetings[target.index] ?? null;
  }
  return fields.character_book?.entries[target.index]?.content ?? null;
}

/** Write one section by path, leaving the revert record to the caller. */
function setSection(state: CardState, path: string, value: string): CardState {
  const target = parseSectionPath(path);
  if (!target || !state.model) return state;

  if (target.kind === 'field') {
    return withFields(state, { [target.key]: value } as Partial<CardFields>);
  }

  if (target.kind === 'greeting') {
    const greetings = state.model.fields.alternate_greetings;
    // A path can outlive the entry it named, so an index that no longer exists
    // is dropped rather than growing a sparse array.
    if (target.index < 0 || target.index >= greetings.length) return state;
    const next = [...greetings];
    next[target.index] = value;
    return withFields(state, { alternate_greetings: next });
  }

  const entries = state.model.fields.character_book?.entries ?? [];
  if (target.index < 0 || target.index >= entries.length) return state;
  return withEntries(state, (current) =>
    current.map((entry, i) => (i === target.index ? { ...entry, content: value } : entry)),
  );
}

function withGlossary(state: CardState, meta: TranslationMeta): CardState {
  if (!state.model) return state;
  return {
    ...withFields(state, { extensions: writeTranslationMeta(state.model.fields, meta) }),
    glossary: meta,
  };
}

/** Change the term list, leaving the rest of the metadata alone. */
function withTerms(state: CardState, update: (terms: GlossaryTerm[]) => GlossaryTerm[]): CardState {
  return withGlossary(state, { ...state.glossary, glossary: update(state.glossary.glossary) });
}

/** What the card already carries, or an empty glossary if it carries nothing. */
const hydrate = (model: CardModel): TranslationMeta =>
  readTranslationMeta(model.fields) ?? createTranslationMeta();

export function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case 'load':
      return {
        model: action.model,
        imageBytes: action.imageBytes ?? null,
        origin: action.origin,
        warnings: action.warnings,
        dirty: false,
        // Reading the glossary back off the card is what stops the names
        // drifting between one editing session and the next.
        glossary: hydrate(action.model),
        // Paths into the card that was open before this one would put its text
        // into a card it never belonged to.
        reverts: {},
      };

    case 'restore':
      return {
        model: action.model,
        imageBytes: action.imageBytes ?? null,
        origin: null,
        warnings: [],
        dirty: true,
        glossary: hydrate(action.model),
        // Carried through the draft, so closing the tab after a bad run is not
        // itself the thing that makes it permanent.
        reverts: action.reverts ?? {},
      };

    case 'revert': {
      const point = state.reverts[action.path];
      if (!state.model || !point) return state;

      const current = sectionText(state.model.fields, action.path);
      if (current === null) return state;

      return {
        ...setSection(state, action.path, point.other),
        reverts: {
          ...state.reverts,
          // What was on the card becomes the way back, so this is reversible
          // however many times it is pressed.
          [action.path]: { other: current, reverted: !point.reverted },
        },
      };
    }

    case 'setField':
      return withFields(state, { [action.key]: action.value } as Partial<CardFields>);

    case 'section.set': {
      const written = setSection(state, action.path, action.value);
      // Unchanged means the path named nothing, so there is nothing to offer
      // back either.
      if (written === state || action.previous === undefined) return written;

      // Only a translation passes `previous`. A typed edit does not, and must
      // not overwrite the way back to what was there before the run.
      return {
        ...written,
        reverts: { ...written.reverts, [action.path]: { other: action.previous, reverted: false } },
      };
    }

    case 'greeting.set': {
      if (!state.model) return state;
      const next = [...state.model.fields.alternate_greetings];
      next[action.index] = action.value;
      return withFields(state, { alternate_greetings: next });
    }

    case 'greeting.add':
      if (!state.model) return state;
      return withFields(state, {
        alternate_greetings: [...state.model.fields.alternate_greetings, ''],
      });

    case 'greeting.remove':
      if (!state.model) return state;
      return withFields(state, {
        alternate_greetings: state.model.fields.alternate_greetings.filter((_, i) => i !== action.index),
      });

    case 'greeting.move': {
      if (!state.model) return state;
      const next = [...state.model.fields.alternate_greetings];
      const target = action.index + action.direction;
      if (target < 0 || target >= next.length) return state;
      [next[action.index], next[target]] = [next[target], next[action.index]];
      return withFields(state, { alternate_greetings: next });
    }

    case 'lore.add':
      return withEntries(state, (entries) => [...entries, createEmptyLorebookEntry(entries.length)]);

    case 'lore.remove':
      return withEntries(state, (entries) => entries.filter((_, i) => i !== action.index));

    case 'lore.patch':
      return withEntries(state, (entries) =>
        entries.map((entry, i) => (i === action.index ? { ...entry, ...action.patch } : entry)),
      );

    case 'lore.addKeys':
      return withEntries(state, (entries) =>
        entries.map((entry, i) =>
          i === action.index ? appendKeys(entry, action.field, splitKeys(action.raw)) : entry,
        ),
      );

    case 'lore.addKeyList':
      return withEntries(state, (entries) =>
        entries.map((entry, i) =>
          i === action.index ? appendKeys(entry, action.field, action.keys) : entry,
        ),
      );

    case 'lore.removeKey':
      return withEntries(state, (entries) =>
        entries.map((entry, i) => {
          if (i !== action.index) return entry;
          const current = entry[action.field] ?? [];
          return { ...entry, [action.field]: current.filter((_, k) => k !== action.keyIndex) };
        }),
      );

    case 'lore.patchBook': {
      if (!state.model) return state;
      const book = state.model.fields.character_book ?? emptyBook();
      return withFields(state, { character_book: { ...book, ...action.patch } });
    }

    case 'glossary.set':
      return withGlossary(state, action.meta);

    case 'glossary.merge':
      // `mergeTerms` decides what wins, so an AI pass fills blanks without
      // overwriting anything a person settled.
      return withTerms(state, (terms) => mergeTerms(terms, action.terms));

    case 'glossary.seed': {
      const { model } = state;
      if (!model) return state;
      return withTerms(state, (terms) => mergeTerms(terms, seedTerms(model.fields)));
    }

    case 'glossary.addTerm':
      return withTerms(state, (terms) => [...terms, action.term]);

    case 'glossary.patchTerm':
      return withTerms(state, (terms) =>
        terms.map((term, i) => {
          if (i !== action.index) return term;
          const patched = { ...term, ...action.patch };
          // This action is the UI's, so a changed translation is a person's
          // decision and has to outrank the next AI pass. Setting it here means
          // no call site can forget.
          const decided =
            action.patch.target !== undefined || action.patch.keepOriginal !== undefined;
          return decided && action.patch.origin === undefined
            ? { ...patched, origin: 'manual' as const }
            : patched;
        }),
      );

    case 'glossary.removeTerm':
      return withTerms(state, (terms) => terms.filter((_, i) => i !== action.index));

    case 'glossary.setStyleNotes':
      return withGlossary(state, { ...state.glossary, styleNotes: action.notes });

    case 'glossary.setLangs':
      return withGlossary(state, {
        ...state.glossary,
        ...(action.sourceLang !== undefined ? { sourceLang: action.sourceLang } : {}),
        ...(action.targetLang !== undefined ? { targetLang: action.targetLang } : {}),
      });

    case 'glossary.clear':
      return withGlossary(state, createTranslationMeta());

    case 'replaceImage':
      // Only the artwork changes. The previous build routed this through the
      // full import path, which reparsed the file and wiped every edit.
      return { ...state, imageBytes: action.bytes, dirty: true };

    case 'dismissWarnings':
      return { ...state, warnings: [] };

    case 'reset':
      return initialCardState;
  }
}

export function useCardStore() {
  const [state, dispatch] = useReducer(cardReducer, initialCardState);

  const actions = useMemo(
    () => ({
      load: (model: CardModel, origin: CardOrigin, warnings: string[], imageBytes?: Uint8Array) =>
        dispatch({ type: 'load', model, origin, warnings, imageBytes }),
      restore: (
        model: CardModel,
        imageBytes?: Uint8Array,
        reverts?: Record<string, SectionRevert>,
      ) => dispatch({ type: 'restore', model, imageBytes, reverts }),
      revert: (path: string) => dispatch({ type: 'revert', path }),
      setField: <K extends keyof CardFields>(key: K, value: CardFields[K]) =>
        dispatch({ type: 'setField', key, value }),
      startBlank: () => dispatch({ type: 'load', model: createEmptyCard(), origin: 'json', warnings: [] }),
      dispatch,
    }),
    [],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return { state, actions, reset, dispatch };
}
