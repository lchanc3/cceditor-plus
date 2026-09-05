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
  readTranslationMeta,
  seedTerms,
  writeTranslationMeta,
} from '../glossary';

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
}

export type KeyField = 'keys' | 'secondary_keys';

export type CardAction =
  | { type: 'load'; model: CardModel; imageBytes?: Uint8Array; origin: CardOrigin; warnings: string[] }
  | { type: 'restore'; model: CardModel; imageBytes?: Uint8Array }
  | { type: 'setField'; key: keyof CardFields; value: CardFields[keyof CardFields] }
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
function appendKeys(entry: LorebookEntry, field: KeyField, keys: string[]): LorebookEntry {
  const current = entry[field] ?? [];
  const added = keys
    .map((key) => key.trim())
    .filter((key) => key !== '' && !current.includes(key));
  return added.length === 0 ? entry : { ...entry, [field]: [...current, ...added] };
}

/**
 * The one place the glossary changes, so the working copy and the copy on the
 * card cannot drift apart.
 */
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
      };

    case 'restore':
      return {
        model: action.model,
        imageBytes: action.imageBytes ?? null,
        origin: null,
        warnings: [],
        dirty: true,
        glossary: hydrate(action.model),
      };

    case 'setField':
      return withFields(state, { [action.key]: action.value } as Partial<CardFields>);

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
      restore: (model: CardModel, imageBytes?: Uint8Array) =>
        dispatch({ type: 'restore', model, imageBytes }),
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
