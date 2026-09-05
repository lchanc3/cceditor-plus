/**
 * Translation tasks.
 *
 * The translation prompt is carried over from the previous version — it was well
 * tuned, particularly the instruction to leave {{char}} / {{user}} macros alone
 * and to emit nothing but the translation. What is new here is cancellation,
 * retry on transient failures, a concurrency cap for whole-card runs, and the
 * glossary: two passes that agree on the proper nouns up front, and a block
 * pinning them into every translation request afterwards.
 */

import type { CardFields } from '../card';
import {
  CardSection,
  GlossaryTerm,
  TERM_KINDS,
  TermKind,
  cardSections,
  parseSectionPath,
  termsInText,
} from '../glossary';
import { parseJsonItems } from './json';
import { ChatMessage, Provider, ProviderError } from './types';

export interface TranslateOptions {
  targetLang: string;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * The whole glossary. Only the terms the text actually contains are sent, so
   * a 200-term card still produces a short prompt.
   */
  glossary?: GlossaryTerm[];
  /** Register, pronouns, forms of address — what the glossary cannot pin down. */
  styleNotes?: string;
  /** Who the card is about, so a section translated alone knows whose world it is. */
  card?: CardContext;
  /** What this particular section is. */
  section?: SectionContext;
  /** Shared pause, so one throttled request slows every other one with it. */
  gate?: RateGate;
}

/**
 * The pace every request keeps to.
 *
 * It does two jobs. It spaces requests out so a per-minute quota is respected
 * before the endpoint has to say no — reacting to a 429 is too late, since the
 * quota is already spent and the window takes a minute to roll over. And it is
 * shared, so one throttled request slows every other one with it rather than
 * letting the other workers keep spending an allowance that has run out.
 */
export interface RateGate {
  wait(signal?: AbortSignal): Promise<void>;
  pause(ms: number): void;
}

/** `perMinute` of 0 disables pacing; the gate then only reacts to a 429. */
export function createRateGate(perMinute = 0): RateGate {
  const spacing = perMinute > 0 ? 60_000 / perMinute : 0;
  let next = 0;

  return {
    async wait(signal) {
      const now = Date.now();
      // Claim a slot before waiting for it, so concurrent callers queue behind
      // each other instead of all deciding the same moment is free.
      const start = Math.max(now, next);
      next = start + spacing;
      if (start > now) await delay(start - now, signal);
    },
    pause(ms) {
      next = Math.max(next, Date.now() + ms);
    },
  };
}

/** Reported as a progress step so a multi-request pass can show where it is. */
export type ProgressFn = (done: number, total: number) => void;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Background about the card, sent with every section.
 *
 * Sections are translated one request at a time, which means a lorebook entry
 * arrives at the model with no idea whose card it is or what the other nineteen
 * entries said. The glossary fixes the proper nouns; this fixes everything a
 * translator would otherwise have to guess — who is speaking, what kind of
 * world it is, whether a word is a place or a title.
 */
export interface CardContext {
  name: string;
  nickname: string;
  summary: string;
}

/** What one section is, which the section's own text rarely says. */
export interface SectionContext {
  label: string;
  keys: string[];
}

/** Enough of the description to establish the setting, without paying for all of it. */
const SUMMARY_LIMIT = 320;

function summarise(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat;
}

export function cardContext(fields: CardFields, forPath?: string): CardContext {
  return {
    name: fields.name.trim(),
    nickname: fields.nickname?.trim() ?? '',
    // Translating the description means the summary would just be the text
    // again, so it is dropped rather than paid for twice.
    summary: forPath === 'description' ? '' : summarise(fields.description),
  };
}

export function sectionContext(fields: CardFields, path: string): SectionContext | undefined {
  const section = cardSections(fields).find((entry) => entry.path === path);
  if (!section) return undefined;

  const target = parseSectionPath(path);
  const keys =
    target?.kind === 'lore' ? (fields.character_book?.entries[target.index]?.keys ?? []) : [];

  return { label: section.label, keys };
}

function contextBlock(card?: CardContext, section?: SectionContext): string {
  const lines: string[] = [];

  if (card?.name) {
    lines.push(`角色：${card.name}${card.nickname ? `（又稱 ${card.nickname}）` : ''}`);
  }
  if (card?.summary) lines.push(`設定摘要：${card.summary}`);
  if (section?.label) {
    const keys = section.keys.length > 0 ? `｜觸發關鍵字：${section.keys.join('、')}` : '';
    lines.push(`本段內容是：${section.label}${keys}`);
  }

  if (lines.length === 0) return '';

  // The instruction not to translate the block matters: without it the model
  // helpfully returns the background as part of the answer.
  return `

【卡片背景 — 只用來理解上下文，絕對不要翻譯或輸出這一段】
${lines.join('\n')}`;
}

/** A term is only worth sending once somebody has decided what to do with it. */
const isDecided = (term: GlossaryTerm): boolean =>
  term.keepOriginal || term.target.trim() !== '';

function glossaryBlock(terms: GlossaryTerm[]): string {
  const decided = terms.filter(isDecided);
  if (decided.length === 0) return '';

  const lines = decided.map((term) =>
    term.keepOriginal ? `${term.source} => 保留原文，不可翻譯` : `${term.source} => ${term.target}`,
  );

  return `

【術語表 — 必須嚴格採用】
${lines.join('\n')}

術語表規則：
- 表中的詞每次出現，一律使用指定譯名，不得改譯、簡稱或加註。
- 標示「保留原文」的詞，維持原文拼寫不翻譯。
- 未列在表中的專有名詞，依你的判斷翻譯，但同一段內必須前後一致。`;
}

const styleBlock = (notes: string | undefined): string =>
  notes?.trim() ? `\n\n【文風要求】\n${notes.trim()}` : '';

const systemPrompt = (options: TranslateOptions, pinned: GlossaryTerm[]) =>
  `你是一位專業的角色設定翻譯。請將以下內容翻譯成${options.targetLang}。

【嚴格指令】：
1. 保持角色的語氣與性格特徵。
2. 絕對保留所有技術性格式與變數（如 {{char}}, {{user}}, <START>, {{original}} 等），不可翻譯或改寫。
3. 保留原文的換行與段落結構。
4. 絕不輸出任何解釋、開場白或是結尾語（例如：「這是一份翻譯...」）。
5. 只允許輸出純粹的翻譯內容。${contextBlock(options.card, options.section)}${styleBlock(options.styleNotes)}${glossaryBlock(pinned)}`;

const MAX_ATTEMPTS = 3;
/** Being throttled is worth more patience than a hiccup is. */
const MAX_TRANSIENT_ATTEMPTS = 5;
/** A rate-limit window is measured in a minute, not in the 0.8s a blip needs. */
const TRANSIENT_BACKOFF_MS = 12_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function withRetry<T>(run: () => Promise<T>, options: TranslateOptions): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    await options.gate?.wait(options.signal);

    try {
      return await run();
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      lastError = error;

      const failure = error instanceof ProviderError ? error : null;
      if (!failure?.retryable) break;

      const transient = failure.transient;
      if (attempt >= (transient ? MAX_TRANSIENT_ATTEMPTS : MAX_ATTEMPTS)) break;

      // A blip clears in under a second; a rate limit clears when the server's
      // window rolls over, which only the server knows — so prefer what it said.
      const waitMs = transient
        ? (failure.options.retryAfterMs ?? TRANSIENT_BACKOFF_MS * attempt)
        : 800 * attempt;

      if (transient) options.gate?.pause(waitMs);
      await delay(waitMs, options.signal);
    }
  }
  throw lastError;
}

function chatWithRetry(
  provider: Provider,
  messages: ChatMessage[],
  options: TranslateOptions,
): Promise<string> {
  return withRetry(
    () =>
      provider.chat(messages, {
        temperature: options.temperature ?? 0.3,
        topP: 0.8,
        signal: options.signal,
      }),
    options,
  );
}

/**
 * Ask for a JSON list and parse it.
 *
 * The parse happens *inside* the retried closure on purpose: malformed JSON is
 * a retryable `ProviderError`, and asking the same question again is usually
 * what fixes it. Parsing outside the loop would waste that.
 */
function chatJson<T>(
  provider: Provider,
  messages: ChatMessage[],
  options: TranslateOptions,
  key: string,
  context: string,
): Promise<T[]> {
  return withRetry(async () => {
    const text = await provider.chat(messages, {
      // Naming and extraction are recall tasks, not creative ones.
      temperature: 0.1,
      topP: 0.8,
      json: true,
      signal: options.signal,
    });
    return parseJsonItems<T>(text, key, context);
  }, options);
}

/** Strip a wrapper the model added despite being told not to. */
function cleanOutput(text: string): string {
  let out = text.trim();
  const fence = out.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1].trim();
  return out;
}

export async function translateText(
  provider: Provider,
  content: string,
  options: TranslateOptions,
): Promise<string> {
  if (!content.trim()) return content;

  // Filtering here rather than at the call site means a caller cannot forget to
  // do it and quietly send the whole glossary with every field.
  const pinned = options.glossary ? termsInText(content, options.glossary) : [];

  const text = await chatWithRetry(
    provider,
    [
      { role: 'system', content: systemPrompt(options, pinned) },
      { role: 'user', content: `待翻譯內容：\n"""\n${content}\n"""` },
    ],
    options,
  );
  return cleanOutput(text);
}

/**
 * The fallback for lorebook keys the glossary has no entry for.
 *
 * Prefer `translatedKeysFor`: a key translated independently of the entry's
 * text may not match the term the reader actually types, and then the entry
 * never fires. This exists for the terms that never made it into a glossary.
 */
export async function translateKeywords(
  provider: Provider,
  keywords: string[],
  options: TranslateOptions,
): Promise<string[]> {
  const valid = keywords.map((k) => k.trim()).filter((k) => k !== '');
  if (valid.length === 0) return [];

  const text = await chatWithRetry(
    provider,
    [
      {
        role: 'user',
        content: `請將以下關鍵字清單翻譯成${options.targetLang}，並以逗號分隔回傳。除了翻譯的語言實體外，絕不輸出任何解釋或句子。
例如：apple, tree -> 蘋果, 樹

待翻譯關鍵字：
${valid.join(', ')}`,
      },
    ],
    { ...options, temperature: 0.1 },
  );

  return cleanOutput(text)
    .split(/[,、，]/)
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

// ---------------------------------------------------------------------------
// Glossary passes
// ---------------------------------------------------------------------------

/** About a page of text per request: enough context to judge, cheap enough to repeat. */
const EXTRACT_BATCH_CHARS = 4000;
const DECIDE_BATCH_TERMS = 40;
/** Characters of surrounding text shown when asking for a translation. */
const SNIPPET_WIDTH = 70;

const EXTRACT_PROMPT = `你是一位協助翻譯的術語整理員。請從以下角色卡內容中，找出所有需要統一譯名的專有名詞。

【算專有名詞】人名、地名、組織與勢力、稱謂與頭銜、專屬物品、專屬概念或設定用語。
【不算】一般名詞與形容詞、日常詞彙、{{char}} 與 {{user}} 等巨集、<START> 等標記。

【規則】
1. s 必須逐字取自原文，不要翻譯，也不要更動大小寫。
2. 同一個詞的其他寫法（縮寫、加冠詞、複數）放進 a，不要拆成多筆。
3. 找不到任何專有名詞時回傳 {"terms":[]}。

【輸出格式】只輸出 JSON，不要有任何說明文字：
{"terms":[{"s":"原文詞","k":"person|place|org|item|title|concept|other","a":["其他寫法"]}]}`;

const decidePrompt = (targetLang: string, settled: GlossaryTerm[]): string => {
  const known =
    settled.length === 0
      ? ''
      : `

【已決定的譯名 — 必須沿用，不可更動，也不要重複輸出】
${settled
  .map((term) => (term.keepOriginal ? `${term.source} => 保留原文` : `${term.source} => ${term.target}`))
  .join('\n')}`;

  return `你是一位專業的角色設定翻譯，正在為一張角色卡決定專有名詞的統一譯名。目標語言是${targetLang}。

【規則】
1. 每個詞只給一個譯名，整張卡共用。
2. 譯名要貼合角色卡的語境與文風，不要逐字硬譯。
3. 人名等不適合意譯的詞可以維持原文，此時把 keep 設為 true，不要填 t。
4. 只處理【待決定的詞】清單裡的詞，s 必須與清單中的原文完全一致。${known}

【輸出格式】只輸出 JSON，不要有任何說明文字：
{"terms":[{"s":"原文詞","t":"譯名"},{"s":"原文詞","keep":true}]}`;
};

interface RawTerm {
  s?: unknown;
  t?: unknown;
  a?: unknown;
  k?: unknown;
  keep?: unknown;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asTextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asText).filter((text) => text !== '') : [];

const asKind = (value: unknown): TermKind =>
  TERM_KINDS.includes(value as TermKind) ? (value as TermKind) : 'other';

const fold = (text: string): string => text.toLowerCase();

/** Group sections so each request carries roughly `limit` characters. */
function batchSections(sections: CardSection[], limit: number): CardSection[][] {
  const batches: CardSection[][] = [];
  let current: CardSection[] = [];
  let size = 0;

  for (const section of sections) {
    if (current.length > 0 && size + section.text.length > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += section.text.length;
  }

  // A single section over the limit gets a request to itself rather than being
  // cut in half, which would slice terms apart at the seam.
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Candidate proper nouns from the whole card.
 *
 * Runs before any translation, so the names are agreed once instead of being
 * re-invented per field. Pair the result with `seedTerms`, which supplies the
 * lorebook keys for free — this pass only has to find what those missed.
 */
export async function extractTerms(
  provider: Provider,
  fields: CardFields,
  options: TranslateOptions & { onProgress?: ProgressFn },
): Promise<GlossaryTerm[]> {
  const batches = batchSections(cardSections(fields), EXTRACT_BATCH_CHARS);
  const found = new Map<string, GlossaryTerm>();

  // Sequential and fail-fast. This is two to six requests for a typical card,
  // and a pooled run that swallowed one failed batch would hand back a glossary
  // with holes in it — worse than an error somebody can retry.
  for (const [index, batch] of batches.entries()) {
    options.signal?.throwIfAborted();

    const items = await chatJson<RawTerm>(
      provider,
      [
        { role: 'system', content: EXTRACT_PROMPT },
        {
          role: 'user',
          content: batch.map((section) => `## ${section.label}\n${section.text}`).join('\n\n'),
        },
      ],
      options,
      'terms',
      '抽取專有名詞',
    );

    for (const item of items) {
      const source = asText(item.s);
      if (source === '' || found.has(fold(source))) continue;
      found.set(fold(source), {
        source,
        target: '',
        aliases: asTextList(item.a).filter((alias) => fold(alias) !== fold(source)),
        kind: asKind(item.k),
        origin: 'ai',
        locked: false,
        keepOriginal: false,
      });
    }

    options.onProgress?.(index + 1, batches.length);
  }

  return [...found.values()];
}

/** The first place a term appears, with a little text either side of it. */
function snippetFor(sections: CardSection[], source: string): string {
  const needle = fold(source);

  for (const section of sections) {
    const at = fold(section.text).indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_WIDTH);
    const end = Math.min(section.text.length, at + source.length + SNIPPET_WIDTH);
    const body = section.text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < section.text.length ? '…' : ''}`;
  }

  return '';
}

/**
 * Settle on a translation for every term that does not have one.
 *
 * Terms somebody already decided are sent as a "must reuse" list rather than
 * being re-asked, which is what keeps a second run from drifting away from the
 * first. Locked terms are never touched. The result is a set of decisions for
 * the caller to fold in with `mergeTerms`, so the precedence rules still apply.
 */
export async function decideTranslations(
  provider: Provider,
  fields: CardFields,
  terms: GlossaryTerm[],
  options: TranslateOptions & { onProgress?: ProgressFn },
): Promise<GlossaryTerm[]> {
  const pending = terms.filter((term) => !term.locked && !isDecided(term));
  if (pending.length === 0) return [];

  const sections = cardSections(fields);
  const settled = terms.filter(isDecided);
  const bySource = new Map(pending.map((term) => [fold(term.source), term]));

  const batches: GlossaryTerm[][] = [];
  for (let i = 0; i < pending.length; i += DECIDE_BATCH_TERMS) {
    batches.push(pending.slice(i, i + DECIDE_BATCH_TERMS));
  }

  const decisions: GlossaryTerm[] = [];
  const seen = new Set<string>();

  for (const [index, batch] of batches.entries()) {
    options.signal?.throwIfAborted();

    const listing = batch
      .map((term, i) => {
        const snippet = snippetFor(sections, term.source);
        return `${i + 1}. ${term.source}（${term.kind}）${snippet ? `｜出現於：${snippet}` : ''}`;
      })
      .join('\n');

    const items = await chatJson<RawTerm>(
      provider,
      [
        { role: 'system', content: decidePrompt(options.targetLang, settled) },
        { role: 'user', content: `【待決定的詞】\n${listing}` },
      ],
      options,
      'terms',
      '決定譯名',
    );

    for (const item of items) {
      const term = bySource.get(fold(asText(item.s)));
      // Anything not on the list — a hallucinated term, or one already settled —
      // is dropped rather than quietly added to the glossary.
      if (!term || seen.has(fold(term.source))) continue;

      const keepOriginal = item.keep === true;
      const target = asText(item.t);
      if (!keepOriginal && target === '') continue;

      seen.add(fold(term.source));
      decisions.push({
        ...term,
        target: keepOriginal ? '' : target,
        keepOriginal,
        origin: 'ai',
      });
    }

    options.onProgress?.(index + 1, batches.length);
  }

  return decisions;
}

/**
 * Run tasks with a small concurrency cap.
 *
 * Whole-card translation can be 20+ requests; firing them all at once gets you
 * rate-limited by every hosted provider and swamps a local one.
 */
export async function runPooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 3,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (signal?.aborted) return;
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Whole-card translation
// ---------------------------------------------------------------------------

export interface SectionResult {
  path: string;
  label: string;
  /** The translation, when it worked. */
  text?: string;
  /** A message already written for the user, when it did not. */
  error?: string;
  /** A content filter rejected this text specifically. */
  filtered?: boolean;
  /** The endpoint asked us to slow down — a rate limit, not a broken setup. */
  transient?: boolean;
  /** Never attempted, because the run was stopped. */
  skipped?: boolean;
}

export interface TranslateCardOptions extends TranslateOptions {
  onProgress?: ProgressFn;
  /** Restrict the run to these paths, so a retry costs only what failed. */
  only?: string[];
  concurrency?: number;
}

/**
 * How many non-filtered failures end the run.
 *
 * A blocked section says nothing about the others — character cards trip
 * content filters routinely, which is the whole reason the Gemini provider
 * turns every safety category down. Nor does a rate limit: a free Gemini tier
 * measured in requests per minute will throttle a long card halfway through,
 * and stopping there would throw away the half that had not run yet.
 *
 * Anything else — a bad key, a wrong model name, an unreachable endpoint —
 * fails every section identically, and has already been retried by the time it
 * lands here. Two is enough to tell that apart without spending twenty requests
 * to learn the key is wrong, while still tolerating one unlucky section.
 */
const FATAL_FAILURE_LIMIT = 2;

/**
 * Translate the whole card, section by section.
 *
 * Partial success is the point: nineteen good translations must not be thrown
 * away because the twentieth was blocked. Nothing is written here — the caller
 * decides what to do with each result, and the sections that failed still hold
 * their original text, so a retry can be limited to those with `only`.
 */
export async function translateCard(
  provider: Provider,
  fields: CardFields,
  options: TranslateCardOptions,
): Promise<SectionResult[]> {
  const wanted = options.only ? new Set(options.only) : null;
  const sections = cardSections(fields).filter((s) => !wanted || wanted.has(s.path));
  if (sections.length === 0) return [];

  let fatalFailures = 0;
  let finished = 0;
  // One gate for the whole run, so a throttled section slows the others too.
  const gate = options.gate ?? createRateGate();

  const entries = fields.character_book?.entries ?? [];
  const keysFor = (path: string): string[] => {
    const target = parseSectionPath(path);
    return target?.kind === 'lore' ? (entries[target.index]?.keys ?? []) : [];
  };

  const tasks = sections.map((section) => async (): Promise<SectionResult> => {
    const base = { path: section.path, label: section.label };

    if (fatalFailures >= FATAL_FAILURE_LIMIT) {
      return { ...base, skipped: true, error: '前面的錯誤會影響每一段，因此沒有嘗試。' };
    }

    try {
      const text = await translateText(provider, section.text, {
        ...options,
        gate,
        card: cardContext(fields, section.path),
        section: { label: section.label, keys: keysFor(section.path) },
      });
      return { ...base, text };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      const failure = error instanceof ProviderError ? error : null;
      const filtered = failure?.filtered ?? false;
      const transient = failure?.transient ?? false;
      if (!filtered && !transient) fatalFailures++;
      return { ...base, error: describeError(error), filtered, transient };
    } finally {
      options.onProgress?.(++finished, sections.length);
    }
  });

  const settled = await runPooled(tasks, options.concurrency ?? 3, options.signal);

  return sections.map((section, index) => {
    const result = settled[index];
    // `runPooled` leaves a hole for anything it never started, which is what a
    // cancellation mid-run looks like.
    if (!result) return { path: section.path, label: section.label, skipped: true };
    return result.status === 'fulfilled'
      ? result.value
      : {
          path: section.path,
          label: section.label,
          error: describeError(result.reason),
        };
  });
}

export function describeError(error: unknown): string {
  if ((error as Error)?.name === 'AbortError') return '已取消。';
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error) return error.message;
  return '發生未知錯誤。';
}
