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

export interface CardState {
  model: CardModel | null;
  /** Original PNG bytes, reused verbatim when exporting so artwork is untouched. */
  imageBytes: Uint8Array | null;
  origin: CardOrigin | null;
  warnings: string[];
  dirty: boolean;
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
  | { type: 'lore.removeKey'; index: number; field: KeyField; keyIndex: number }
  | { type: 'lore.patchBook'; patch: Partial<Lorebook> }
  | { type: 'replaceImage'; bytes: Uint8Array }
  | { type: 'dismissWarnings' }
  | { type: 'reset' };

export const initialCardState: CardState = {
  model: null,
  imageBytes: null,
  origin: null,
  warnings: [],
  dirty: false,
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

export function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case 'load':
      return {
        model: action.model,
        imageBytes: action.imageBytes ?? null,
        origin: action.origin,
        warnings: action.warnings,
        dirty: false,
      };

    case 'restore':
      return {
        model: action.model,
        imageBytes: action.imageBytes ?? null,
        origin: null,
        warnings: [],
        dirty: true,
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
        entries.map((entry, i) => {
          if (i !== action.index) return entry;
          const current = entry[action.field] ?? [];
          const added = splitKeys(action.raw).filter((key) => !current.includes(key));
          if (added.length === 0) return entry;
          return { ...entry, [action.field]: [...current, ...added] };
        }),
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
