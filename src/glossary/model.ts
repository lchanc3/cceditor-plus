/**
 * What the glossary knows how to do, as pure functions over a card.
 *
 * `storage.ts` owns the shape and where it lives; this owns the operations —
 * seeding, finding where terms occur, merging two glossaries, and checking a
 * translation actually used the names it agreed to use.
 *
 * The section paths produced here (`description`, `greeting:2`, `lore:0`) are
 * the same keys `useTranslate` already uses for its per-slot status, so the
 * viewer can link a term straight to the field it appears in.
 */

import type { CardFields } from '../card';
import type { GlossaryTerm, TermOrigin } from './storage';

export interface CardSection {
  /** Matches the translation task keys in `useTranslate`. */
  path: string;
  label: string;
  text: string;
}

export interface TermUsage {
  term: GlossaryTerm;
  hits: { path: string; count: number }[];
  total: number;
}

const PLAIN_FIELDS: { key: keyof CardFields; label: string }[] = [
  { key: 'name', label: '名稱' },
  { key: 'description', label: '角色描述' },
  { key: 'personality', label: '性格設定' },
  { key: 'scenario', label: '場景' },
  { key: 'first_mes', label: '開場白' },
  { key: 'mes_example', label: '對話範例' },
  { key: 'creator_notes', label: '作者備註' },
  { key: 'system_prompt', label: '系統提示' },
  { key: 'post_history_instructions', label: '歷史後指示' },
];

const fold = (text: string): string => text.toLowerCase();

/** Macros are instructions to the engine, never terms to be translated. */
const isMacro = (text: string): boolean => /^\{\{.*\}\}$/.test(text.trim());

/** A key with no letters — an id, an index, stray punctuation — is not a term. */
const hasLetters = (text: string): boolean => /\p{L}/u.test(text);

/**
 * Scripts that write with spaces need word boundaries, or `Kael` matches inside
 * `Kaelen`. CJK writes without them, where the same rule would match nothing, so
 * those go by plain substring.
 */
const needsBoundaries = (term: string): boolean =>
  !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(term: string): RegExp {
  const escaped = escapeRegex(term);
  const pattern = needsBoundaries(term)
    ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`
    : escaped;
  return new RegExp(pattern, 'giu');
}

/** Every form that should resolve to this term. */
const formsOf = (term: GlossaryTerm): string[] =>
  [term.source, ...term.aliases].filter((form) => form.trim() !== '');

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Every stretch of translatable prose on the card, in the order the tabs show
 * them. Lorebook *keys* are deliberately excluded: they are where terms come
 * from, so counting them as occurrences would inflate every seeded term.
 */
export function cardSections(fields: CardFields): CardSection[] {
  const sections: CardSection[] = [];

  for (const { key, label } of PLAIN_FIELDS) {
    const text = fields[key];
    if (typeof text === 'string' && text.trim() !== '') sections.push({ path: key, label, text });
  }

  fields.alternate_greetings.forEach((text, index) => {
    if (text.trim() !== '') {
      sections.push({ path: `greeting:${index}`, label: `其他開場白 #${index + 1}`, text });
    }
  });

  fields.character_book?.entries.forEach((entry, index) => {
    if (entry.content.trim() !== '') {
      const name = entry.comment?.trim() || entry.keys[0] || '';
      sections.push({
        path: `lore:${index}`,
        label: `世界書 #${index + 1}${name ? `（${name}）` : ''}`,
        text: entry.content,
      });
    }
  });

  return sections;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seed(source: string, origin: TermOrigin, kind: GlossaryTerm['kind']): GlossaryTerm {
  return { source, target: '', aliases: [], kind, origin, locked: false, keepOriginal: false };
}

/**
 * The proper nouns already on the card, for free.
 *
 * Lorebook keys are the author's own list of terms worth reacting to, which
 * makes them a far better starting point than anything a model would guess —
 * and they cost nothing. Entries matching by regex are skipped: their keys are
 * patterns, not names.
 *
 * `tags` are excluded on purpose. They classify the card (`fantasy`, `NSFW`),
 * they are not part of its world.
 */
export function seedTerms(fields: CardFields): GlossaryTerm[] {
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];

  const add = (raw: string, origin: TermOrigin, kind: GlossaryTerm['kind']) => {
    const source = raw.trim();
    if (source === '' || isMacro(source) || !hasLetters(source)) return;
    if (seen.has(fold(source))) return;
    seen.add(fold(source));
    terms.push(seed(source, origin, kind));
  };

  add(fields.name, 'name', 'person');
  if (fields.nickname) add(fields.nickname, 'name', 'person');

  for (const entry of fields.character_book?.entries ?? []) {
    if (entry.use_regex) continue;
    for (const key of [...entry.keys, ...(entry.secondary_keys ?? [])]) {
      add(key, 'lore-key', 'other');
    }
  }

  return terms;
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

function countIn(text: string, term: GlossaryTerm): number {
  let count = 0;
  for (const form of formsOf(term)) {
    count += text.match(matcher(form))?.length ?? 0;
  }
  return count;
}

/**
 * Where each term actually appears. Derived on demand rather than stored — the
 * card is edited between sessions, so a saved copy would be wrong by the time
 * anyone read it.
 */
export function scanUsage(fields: CardFields, terms: GlossaryTerm[]): TermUsage[] {
  const sections = cardSections(fields);

  return terms.map((term) => {
    const hits: { path: string; count: number }[] = [];
    let total = 0;
    for (const section of sections) {
      const count = countIn(section.text, term);
      if (count > 0) {
        hits.push({ path: section.path, count });
        total += count;
      }
    }
    return { term, hits, total };
  });
}

/**
 * The terms one stretch of text actually contains.
 *
 * This is what keeps the injected glossary small: a card may carry 200 terms,
 * but a single field usually touches a handful, and listing the rest wastes
 * tokens and gives the model more chances to misapply something.
 */
export function termsInText(text: string, terms: GlossaryTerm[]): GlossaryTerm[] {
  return terms.filter((term) => formsOf(term).some((form) => matcher(form).test(text)));
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * How much authority a translation carries. A person's choice outranks an
 * imported one, which outranks anything the model produced — so a later AI pass
 * fills blanks without ever quietly rewriting a decision somebody made.
 */
const AUTHORITY: Record<TermOrigin, number> = {
  manual: 4,
  import: 3,
  'lore-key': 2,
  name: 2,
  ai: 1,
};

function combine(base: GlossaryTerm, incoming: GlossaryTerm): GlossaryTerm {
  const aliases = [...base.aliases];
  const known = new Set([fold(base.source), ...base.aliases.map(fold)]);
  for (const alias of incoming.aliases) {
    if (!known.has(fold(alias))) {
      known.add(fold(alias));
      aliases.push(alias);
    }
  }

  // A locked term is the whole point of locking: nothing may rewrite it. An
  // undecided one has nothing to protect, so any translation is an improvement.
  const keepBase =
    base.locked ||
    (base.target.trim() !== '' &&
      (incoming.target.trim() === '' || AUTHORITY[incoming.origin] <= AUTHORITY[base.origin]));

  const winner = keepBase ? base : incoming;

  return {
    ...winner,
    source: base.source,
    aliases,
    // A specific kind beats the catch-all whichever side it came from.
    kind: winner.kind !== 'other' ? winner.kind : base.kind !== 'other' ? base.kind : incoming.kind,
    locked: base.locked || incoming.locked,
  };
}

/**
 * Fold `incoming` into `base`, matching on the source term case-insensitively.
 * Order is preserved: existing terms stay put, new ones are appended.
 */
export function mergeTerms(base: GlossaryTerm[], incoming: GlossaryTerm[]): GlossaryTerm[] {
  const index = new Map<string, number>();
  const merged = base.map((term, i) => {
    index.set(fold(term.source), i);
    return term;
  });

  for (const term of incoming) {
    if (term.source.trim() === '') continue;
    const at = index.get(fold(term.source));
    if (at === undefined) {
      index.set(fold(term.source), merged.length);
      merged.push(term);
    } else {
      merged[at] = combine(merged[at], term);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Terms that were given the same translation. Not always an error — two names
 * can legitimately share one rendering — but it makes the lorebook keys
 * ambiguous, so the viewer should say so.
 */
export function duplicateTargets(terms: GlossaryTerm[]): { target: string; sources: string[] }[] {
  const groups = new Map<string, string[]>();

  for (const term of terms) {
    const target = term.target.trim();
    if (target === '' || term.keepOriginal) continue;
    const key = fold(target);
    groups.set(key, [...(groups.get(key) ?? []), term.source]);
  }

  return [...groups.values()]
    .filter((sources) => sources.length > 1)
    .map((sources) => ({ target: terms.find((t) => t.source === sources[0])!.target, sources }));
}

/**
 * Terms the source text used but the translation did not honour.
 *
 * Reported rather than repaired: replacing a name inside finished prose is how
 * you end up with a broken sentence, so the viewer offers the jump and the
 * decision stays with the person reading it.
 */
export function unappliedTerms(
  sourceText: string,
  translatedText: string,
  terms: GlossaryTerm[],
): GlossaryTerm[] {
  return termsInText(sourceText, terms).filter((term) => {
    // A term kept in the source language should still be there, untouched.
    const expected = term.keepOriginal ? term.source : term.target.trim();
    if (expected === '') return false;
    return !matcher(expected).test(translatedText);
  });
}

// ---------------------------------------------------------------------------
// Lorebook keys
// ---------------------------------------------------------------------------

/**
 * The translated keys to append to a lorebook entry.
 *
 * This is what the glossary is for. A lorebook key matches against what the
 * user types, so on a translated card the key has to be the term as it appears
 * in the translated text — not an independently translated guess. Taking both
 * from the same glossary is the only thing that guarantees they agree.
 *
 * Original keys are never replaced, only added to: the source-language term
 * still has to match for anyone reading the card in the original.
 */
export function translatedKeysFor(keys: string[], terms: GlossaryTerm[]): string[] {
  const byForm = new Map<string, GlossaryTerm>();
  for (const term of terms) {
    for (const form of formsOf(term)) byForm.set(fold(form), term);
  }

  const existing = new Set(keys.map((key) => fold(key.trim())));
  const added: string[] = [];

  for (const key of keys) {
    const term = byForm.get(fold(key.trim()));
    if (!term || term.keepOriginal) continue;
    const target = term.target.trim();
    if (target === '' || existing.has(fold(target))) continue;
    existing.add(fold(target));
    added.push(target);
  }

  return added;
}
