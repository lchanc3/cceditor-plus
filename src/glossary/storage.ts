/**
 * Where the translation glossary lives on the card.
 *
 * `data.extensions` is the spec-sanctioned home for editor-owned data: V2 and V3
 * both require readers to preserve keys they do not recognise, `normalizeCard`
 * already reads the object verbatim and `v2Data` writes it straight back, and —
 * the part that actually matters at runtime — the glossary never reaches a
 * prompt from here. `extensions` is inert metadata to SillyTavern, so storing a
 * few hundred terms costs file size and nothing else.
 *
 * `creator_notes` is the obvious-looking alternative and the wrong one: it is
 * display copy, rendered verbatim on the character panel and on card-sharing
 * sites, and it is the field most likely to be hand-edited by somebody else.
 *
 * One inherent limitation: a V1 export has six fields and no `extensions`, so
 * the glossary cannot survive one. The export dialog has to say so.
 */

import type { CardFields } from '../card';

/** Namespaced so no other editor's extension data can collide with ours. */
export const GLOSSARY_NAMESPACE = 'cceditor_plus';

/** Bumped only for a breaking change to the stored shape. */
export const GLOSSARY_SCHEMA_VERSION = 1;

export const TERM_KINDS = ['person', 'place', 'org', 'item', 'title', 'concept', 'other'] as const;
export type TermKind = (typeof TERM_KINDS)[number];

/**
 * Where a translation came from, which is what decides precedence: anything a
 * person chose or brought in outranks anything the model produced, so a later
 * AI pass may fill blanks but never overwrite `manual` / `import` / `lore-key`.
 */
const TERM_ORIGINS = ['lore-key', 'name', 'ai', 'manual', 'import'] as const;
export type TermOrigin = (typeof TERM_ORIGINS)[number];

export interface GlossaryTerm {
  /** The term as it appears in the source text. */
  source: string;
  /** The agreed translation. Empty means extracted but not yet decided. */
  target: string;
  /** Spelling variants that should resolve to the same translation. */
  aliases: string[];
  kind: TermKind;
  origin: TermOrigin;
  /** Locked terms are never rewritten by a later AI pass. */
  locked: boolean;
  /** Leave this term in the source language. */
  keepOriginal: boolean;
}

export interface TranslationMeta {
  sourceLang: string;
  targetLang: string;
  /**
   * Free-form style decisions — pronouns, register, forms of address. The
   * glossary pins proper nouns; this is what keeps everything around them from
   * drifting between sessions.
   */
  styleNotes: string;
  /** Epoch seconds. Set by the caller, so this module stays deterministic. */
  updatedAt?: number;
  glossary: GlossaryTerm[];
}

/**
 * Stored keys are abbreviated because this payload rides inside a base64'd PNG
 * chunk, where every byte is inflated by 4/3. Readability is the viewer's job.
 *
 * Deliberately absent: where each term occurs. That is derived data — rescan the
 * card on load — and storing it would both inflate the payload and go stale the
 * moment anyone edits a field.
 */
interface StoredTerm {
  s: string;
  t?: string;
  a?: string[];
  k?: TermKind;
  o?: TermOrigin;
  l?: true;
  keep?: true;
}

/** Keys this module owns inside its namespace; anything else is carried through. */
const OWNED_KEYS = new Set(['v', 'sourceLang', 'targetLang', 'styleNotes', 'updatedAt', 'glossary']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asTextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asText).filter((text) => text !== '') : [];

const fold = (text: string): string => text.toLowerCase();

/** Aliases that merely restate the source, or each other, carry no information. */
function cleanAliases(source: string, aliases: string[]): string[] {
  const seen = new Set([fold(source)]);
  const out: string[] = [];
  for (const alias of aliases) {
    const key = fold(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

export function createTranslationMeta(partial: Partial<TranslationMeta> = {}): TranslationMeta {
  return { sourceLang: '', targetLang: '', styleNotes: '', glossary: [], ...partial };
}

/**
 * A term with the defaults filled in. `manual` because this is the path a
 * person adding a term by hand goes through; the AI passes build their own.
 */
export function createTerm(partial: Partial<GlossaryTerm> & { source: string }): GlossaryTerm {
  return {
    target: '',
    aliases: [],
    kind: 'other',
    origin: 'manual',
    locked: false,
    keepOriginal: false,
    ...partial,
  };
}

/**
 * A block with no terms and no style notes says nothing, so it is not written at
 * all — the same reasoning that makes `serializeCard` drop an empty lorebook.
 */
export function isEmptyTranslationMeta(meta: TranslationMeta): boolean {
  return (
    meta.styleNotes.trim() === '' && meta.glossary.every((term) => term.source.trim() === '')
  );
}

function readTerms(raw: unknown): GlossaryTerm[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const source = asText(item.s);
    if (source === '') continue;
    // A card should never hold the same term twice, but if it does the first one
    // wins, so reading is stable rather than dependent on array order.
    if (seen.has(fold(source))) continue;
    seen.add(fold(source));

    terms.push({
      source,
      target: asText(item.t),
      aliases: cleanAliases(source, asTextList(item.a)),
      kind: TERM_KINDS.includes(item.k as TermKind) ? (item.k as TermKind) : 'other',
      // An unattributable term counts as imported, not as AI output: that is the
      // direction that cannot silently overwrite somebody's own wording.
      origin: TERM_ORIGINS.includes(item.o as TermOrigin) ? (item.o as TermOrigin) : 'import',
      locked: item.l === true,
      keepOriginal: item.keep === true,
    });
  }

  return terms;
}

/** `null` when the card carries nothing worth restoring. */
export function readTranslationMeta(fields: CardFields): TranslationMeta | null {
  const stored = fields.extensions?.[GLOSSARY_NAMESPACE];
  if (!isRecord(stored)) return null;

  const updatedAt = stored.updatedAt;
  const meta: TranslationMeta = {
    sourceLang: asText(stored.sourceLang),
    targetLang: asText(stored.targetLang),
    styleNotes: asText(stored.styleNotes),
    glossary: readTerms(stored.glossary),
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };

  return isEmptyTranslationMeta(meta) ? null : meta;
}

export function hasTranslationMeta(fields: CardFields): boolean {
  return readTranslationMeta(fields) !== null;
}

function storeTerm(term: GlossaryTerm): StoredTerm {
  const source = term.source.trim();
  const target = term.target.trim();
  const aliases = cleanAliases(
    source,
    term.aliases.map((alias) => alias.trim()).filter((alias) => alias !== ''),
  );

  // Every default is omitted, `origin: 'import'` included, matching the fallback
  // in `readTerms` so the round trip stays exact.
  return {
    s: source,
    ...(target !== '' ? { t: target } : {}),
    ...(aliases.length > 0 ? { a: aliases } : {}),
    ...(term.kind !== 'other' ? { k: term.kind } : {}),
    ...(term.origin !== 'import' ? { o: term.origin } : {}),
    ...(term.locked ? { l: true as const } : {}),
    ...(term.keepOriginal ? { keep: true as const } : {}),
  };
}

/**
 * Returns the replacement `extensions` object — the caller commits it with
 * `setField('extensions', …)`, so this stays a pure function over the card.
 *
 * Unrecognised keys inside our own namespace are carried through, on the same
 * principle as `extraData`: a newer build of this editor may have written
 * something an older one has no business deleting.
 */
export function writeTranslationMeta(
  fields: CardFields,
  meta: TranslationMeta,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fields.extensions };
  const previous = isRecord(next[GLOSSARY_NAMESPACE]) ? next[GLOSSARY_NAMESPACE] : {};

  if (isEmptyTranslationMeta(meta)) {
    delete next[GLOSSARY_NAMESPACE];
    return next;
  }

  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!OWNED_KEYS.has(key)) carried[key] = value;
  }

  const seen = new Set<string>();
  const glossary: StoredTerm[] = [];
  for (const term of meta.glossary) {
    const source = term.source.trim();
    if (source === '' || seen.has(fold(source))) continue;
    seen.add(fold(source));
    glossary.push(storeTerm(term));
  }

  const sourceLang = meta.sourceLang.trim();
  const targetLang = meta.targetLang.trim();
  const styleNotes = meta.styleNotes.trim();

  next[GLOSSARY_NAMESPACE] = {
    ...carried,
    v: GLOSSARY_SCHEMA_VERSION,
    ...(sourceLang !== '' ? { sourceLang } : {}),
    ...(targetLang !== '' ? { targetLang } : {}),
    ...(styleNotes !== '' ? { styleNotes } : {}),
    ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
    ...(glossary.length > 0 ? { glossary } : {}),
  };

  return next;
}

/** Remove the block entirely, leaving every other extension untouched. */
export function clearTranslationMeta(fields: CardFields): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fields.extensions };
  delete next[GLOSSARY_NAMESPACE];
  return next;
}
