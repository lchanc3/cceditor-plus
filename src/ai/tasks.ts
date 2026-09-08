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
    try {
      return parseJsonItems<T>(text, key, context);
    } catch (error) {
      // Valid output here is JSON, so prose that opens with a refusal is one.
      // Retrying it three times only buys three more refusals.
      if (!REFUSAL.test(text)) throw error;
      throw new ProviderError(
        `${context}時模型拒絕作答，不是格式問題。回應開頭是：${text.trim().slice(0, 80)}`,
        { retryable: false, filtered: true },
      );
    }
  }, options);
}

/**
 * What a model says instead of doing the work.
 *
 * A refusal that arrives as an HTTP error or a `content_filter` finish reason
 * is already understood. This is the other kind: a perfectly ordinary 200
 * carrying a polite sentence about why not. Nothing downstream could tell it
 * from an answer, so on the JSON tasks it surfaced as「格式不對」— which sends
 * the reader off to fix their prompt or their parser — and on a translation it
 * was simply written into the card as though it were the translation.
 *
 * Anchored to the start, because a card may well contain an apology in its
 * dialogue; a refusal is what the reply opens with.
 */
const REFUSAL =
  /^\s*(?:i\s*(?:'m|’m|am)\s+(?:sorry|afraid|unable)|i\s+(?:can'?t|cannot|won'?t|will\s+not)|sorry[,.]|as\s+an\s+ai\b|i\s+apolog|抱歉|對不起|对不起|我(?:無法|无法|不能|不會|不会|很抱歉))/i;

/**
 * Whether a translation is really a refusal.
 *
 * The marker alone is not enough: a section whose source apologises should come
 * back apologising, and a card has plenty of dialogue that does. What gives a
 * refusal away is that the apology has no counterpart in the source — the model
 * opened with something the text it was given never said.
 *
 * The length cap is the second half of that. A long reply that merely opens with
 * an apologetic line is a translation of one; a refusal is a sentence or two
 * standing in for a whole section.
 */
function refusedToTranslate(source: string, output: string): boolean {
  return REFUSAL.test(output) && !REFUSAL.test(source) && output.length < 200;
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
  const translated = cleanOutput(text);
  if (refusedToTranslate(content, translated)) {
    throw new ProviderError(`模型拒絕翻譯這一段，回覆的是：${translated.slice(0, 80)}`, {
      retryable: false,
      filtered: true,
    });
  }

  return translated;
}

/** The longest a translated lorebook key can plausibly be. `Church of the Eternal Light` is 27. */
const KEY_MAX_CHARS = 40;
/** Keys per request. A card's whole lorebook is normally one of these. */
const KEYS_BATCH = 60;

/**
 * Whether an answer is an explanation rather than a key.
 *
 * Length alone does not catch it: a sentence of thirty characters is shorter
 * than the cap and still nothing a reader would ever type. A full stop is what
 * gives it away — a lorebook key does not contain one, and a sentence almost
 * always does. Written into an entry, prose matches nothing and has to be found
 * and deleted by hand later.
 */
const looksLikeProse = (word: string): boolean =>
  word.length > KEY_MAX_CHARS || /[\n。．｡]/.test(word);

interface RawKey {
  i?: unknown;
  t?: unknown;
}

/**
 * The names already settled, which this pass may not contradict.
 *
 * Two reasons it is here. A card over sixty keys goes out in more than one
 * request, and the second one is blind to the first unless it is told — the
 * same drift `decideTranslations` carries a "must reuse" list to prevent. And
 * the glossary may already hold decisions from a naming pass or from somebody's
 * own typing; a key that is also a term must not come back rendered a second
 * way, or the entry stops matching the prose that pins the term.
 */
const settledBlock = (settled: [string, string][]): string =>
  settled.length === 0
    ? ''
    : `

【已決定的譯名 — 必須沿用，不可改譯】
${settled.map(([source, target]) => `${source} => ${target}`).join('\n')}`;

const keysPrompt = (targetLang: string, settled: [string, string][]): string =>
  `你是一位協助翻譯角色卡的術語整理員。請把以下世界書關鍵字翻譯成${targetLang}。

【這些字的用途】它們是拿去比對讀者輸入的文字，不是拿來閱讀的句子。

【規則】
1. 只輸出那個詞本身：不要加說明、不要加引號或標點、不要造句。
2. 同一個意思的不同寫法給同一個譯名（7 yo、7 year-old、age: 7 都是七歲）。
3. 人名、地名等專有名詞照譯；不適合意譯的用音譯。
4. 不確定怎麼翻的那一筆整個不要輸出——不要給空字串，也不要把原文抄回來。
5. i 必須是清單上的編號，t 是那個編號的譯名。${settledBlock(settled)}

【輸出格式】只輸出 JSON，不要有任何說明文字：
{"keys":[{"i":1,"t":"譯名"}]}`;

/**
 * Names for lorebook keys the glossary has no term for.
 *
 * Returned as glossary terms rather than written anywhere, so the caller folds
 * them in with `mergeTerms` and the precedence rules still apply. That is the
 * point of the shape: run this *before* translating and the same decision
 * reaches the prose, through the pinned glossary block, and the entry's keys.
 * Translating a key on its own afterwards guarantees nothing — the prose may
 * well have rendered it another way, and then the entry never fires.
 *
 * Numbered rather than positional, and answered by number. Matched up by
 * position, a model that drops one key and merges two others returns a list of
 * exactly the right length with every answer after the seam attached to the
 * wrong word, and a lorebook full of confidently wrong triggers looks exactly
 * like a working one. By number, a dropped key costs that key alone.
 *
 * Which is what lets a whole card go in one request. It was two per entry.
 */
export async function translateLoreKeys(
  provider: Provider,
  keys: string[],
  options: TranslateOptions & { onProgress?: ProgressFn },
): Promise<GlossaryTerm[]> {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const trimmed = key.trim();
    // Asking twice about two spellings that fold together is a request spent to
    // be told the same thing.
    if (trimmed === '' || seen.has(fold(trimmed))) continue;
    seen.add(fold(trimmed));
    wanted.push(trimmed);
  }
  if (wanted.length === 0) return [];

  // Whatever the glossary has already settled leads the reuse list, so this
  // pass agrees with the terms that are pinned into the prose.
  const settled: [string, string][] = (options.glossary ?? [])
    .filter((term) => !term.keepOriginal && term.target.trim() !== '')
    .map((term) => [term.source, term.target.trim()]);

  const batches: string[][] = [];
  for (let at = 0; at < wanted.length; at += KEYS_BATCH) {
    batches.push(wanted.slice(at, at + KEYS_BATCH));
  }

  const named: GlossaryTerm[] = [];

  for (const [index, batch] of batches.entries()) {
    options.signal?.throwIfAborted();

    const items = await chatJson<RawKey>(
      provider,
      [
        { role: 'system', content: keysPrompt(options.targetLang, settled) },
        {
          role: 'user',
          content: `【待翻譯關鍵字】\n${batch.map((key, i) => `${i + 1}. ${key}`).join('\n')}`,
        },
      ],
      options,
      'keys',
      '翻譯世界書關鍵字',
    );

    for (const item of items) {
      const at = Number(item.i) - 1;
      const source = Number.isInteger(at) ? batch[at] : undefined;
      const target = asText(item.t);

      if (source === undefined || target === '' || looksLikeProse(target)) continue;
      // An echo of the key adds nothing; the original is already on the entry.
      if (fold(target) === fold(source)) continue;

      settled.push([source, target]);
      named.push({
        source,
        target,
        aliases: [],
        kind: 'other',
        origin: 'ai',
        locked: false,
        keepOriginal: false,
      });
    }

    options.onProgress?.(index + 1, batches.length);
  }

  return named;
}

// ---------------------------------------------------------------------------
// Glossary passes
// ---------------------------------------------------------------------------

/** About a page of text per request: enough context to judge, cheap enough to repeat. */
const EXTRACT_BATCH_CHARS = 4000;
const DECIDE_BATCH_TERMS = 40;
/** Reviewing carries one more line per term than naming does, but not enough more to split further. */
const REVIEW_BATCH_TERMS = 40;
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
  const translated = settled.filter((term) => !term.keepOriginal);
  const kept = settled.filter((term) => term.keepOriginal);

  /**
   * Two lists, because one of them was being copied. Rendering a kept term as
   * `Emberwright => 保留原文` puts the flag in the exact shape this pass answers in,
   * and a real card came back with `{"s":"Emberwright","t":"保留原文"}` — the
   * instruction typed into the 譯名 field. Rule 5 offers `keep`; the example
   * sitting beside it won. Kept terms carry no arrow now, so there is nothing
   * to imitate.
   */
  const known = [
    translated.length === 0
      ? ''
      : `

【已決定的譯名 — 必須沿用，不可更動，也不要重複輸出】
${translated.map((term) => `${term.source} => ${term.target}`).join('\n')}`,
    kept.length === 0
      ? ''
      : `

【維持原文的詞 — 不要翻譯，也不要重複輸出】
${kept.map((term) => term.source).join('、')}`,
  ].join('');

  return `你是一位專業的角色設定翻譯，正在為一張角色卡決定專有名詞的統一譯名。目標語言是${targetLang}。

【規則】
1. 每個詞只給一個譯名，整張卡共用。
2. 譯名要貼合角色卡的語境與文風，不要逐字硬譯，也不要自造生硬的組合——譯名要是讀得順的中文詞。
3. 先判斷這個詞在這張卡裡是什麼：組織、生物、地點、頭銜還是概念，再依那個身分翻，不要套用它在現實世界最常見的意思。奇幻設定裡的生物尤其不要用現實物種名。
4. 避開在中文口語裡會被讀成別的意思的詞。
5. 人名等不適合意譯的詞可以維持原文，此時把 keep 設為 true，不要填 t。
6. 只處理【待決定的詞】清單裡的詞，s 必須與清單中的原文完全一致。${known}

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

/** Ways a model says "leave it alone" when it was asked for a translation. */
const KEEP_ORIGINAL_ANSWERS = new Set([
  '保留原文',
  '保持原文',
  '維持原文',
  '维持原文',
  '保留英文',
  '不翻譯',
  '不譯',
  '不译',
  'keep original',
  'keep as is',
  'original',
]);

const isKeepAnswer = (text: string): boolean =>
  KEEP_ORIGINAL_ANSWERS.has(text.toLowerCase().split(/[，,（(]/)[0].trim());

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

/**
 * Which lorebook entry a term keys, by the entry's own name.
 *
 * This is the single most useful thing that can be said about a seeded term
 * and it was being thrown away. Every key `seedTerms` takes arrives with kind
 * `other`, so the listing said nothing but the word itself and seventy
 * characters of surrounding prose — and a bare `church` was duly translated as
 * a building on a card whose entry is called *Church of the Eternal Light*.
 * Naming the entry settles what the word is before any rule has to.
 */
function entryTitles(fields: CardFields): Map<string, string> {
  const seen = new Map<string, string | null>();

  for (const entry of fields.character_book?.entries ?? []) {
    const title = entry.comment?.trim();
    if (!title) continue;
    for (const key of [...entry.keys, ...(entry.secondary_keys ?? [])]) {
      const folded = fold(key.trim());
      if (folded === '') continue;
      // A key on several entries names none of them, so it is dropped rather
      // than attributed to whichever happened to come first. `cathedral` keys
      // both the Order and the Cathedral on a real card.
      const first = seen.get(folded);
      seen.set(folded, first === undefined || first === title ? title : null);
    }
  }

  const titles = new Map<string, string>();
  for (const [key, title] of seen) if (title !== null) titles.set(key, title);
  return titles;
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
 * The pending terms as families, so ones sharing a root travel together.
 *
 * Batches of forty are what let a 130-term card be named at all, but they also
 * mean the model decides each batch blind to the others. A real card came back
 * with `keziah` kept in the source language and `keziah's domain` rendered
 * 凱齊亞的領域: the two were never in front of it at the same time, so no
 * instruction could have made them agree. Only being in one request can.
 *
 * A term's family is named by the shortest term contained in it, found with the
 * same word-aware matcher the glossary uses everywhere else — so `Kael` does not
 * claim `Kaelen`, and `sister` does not claim `sisters`. Plurals therefore stay
 * apart, which costs nothing: they are separate words that reach the same
 * translation on their own. It is the possessives and the compounds that drift.
 *
 * Families are emitted in the order their first member had, so everything else
 * keeps the seeded order — which follows the lorebook, and already puts one
 * entry's vocabulary together.
 */
function relatedFamilies(pending: GlossaryTerm[]): GlossaryTerm[][] {
  const rootOf = new Map<GlossaryTerm, string>();

  for (const term of pending) {
    const root = termsInText(term.source, pending).reduce(
      (shortest, inside) => (inside.source.length < shortest.length ? inside.source : shortest),
      term.source,
    );
    rootOf.set(term, fold(root));
  }

  const families = new Map<string, GlossaryTerm[]>();
  for (const term of pending) {
    const key = rootOf.get(term)!;
    families.set(key, [...(families.get(key) ?? []), term]);
  }

  const ordered: GlossaryTerm[][] = [];
  const emitted = new Set<string>();

  for (const term of pending) {
    const key = rootOf.get(term)!;
    if (emitted.has(key)) continue;
    emitted.add(key);
    ordered.push(families.get(key)!);
  }

  return ordered;
}

/**
 * Pack families into requests without splitting one that would fit.
 *
 * A family longer than the limit gets a request to itself rather than being cut
 * in half, for the same reason an oversized section does: the split is the one
 * thing this is trying to avoid.
 */
function batchTerms(families: GlossaryTerm[][], limit: number): GlossaryTerm[][] {
  const batches: GlossaryTerm[][] = [];
  let current: GlossaryTerm[] = [];

  for (const family of families) {
    if (current.length > 0 && current.length + family.length > limit) {
      batches.push(current);
      current = [];
    }
    current.push(...family);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * One term as the model sees it: what it is, which entry it keys, and the first
 * place it appears. Shared by the two passes that work from a numbered list, so
 * a term cannot be described one way when it is named and another when its name
 * is reviewed.
 */
function describeTerm(
  term: GlossaryTerm,
  position: number,
  sections: CardSection[],
  titles: Map<string, string>,
  withCurrent = false,
): string {
  const snippet = snippetFor(sections, term.source);
  const title = titles.get(fold(term.source));

  return [
    `${position}. ${term.source}（${term.kind}）`,
    withCurrent ? `｜現在的譯名：${term.keepOriginal ? '保留原文' : term.target.trim()}` : '',
    title ? `｜世界書條目：${title}` : '',
    snippet ? `｜出現於：${snippet}` : '',
  ].join('');
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
  const titles = entryTitles(fields);
  const settled = terms.filter(isDecided);
  const bySource = new Map(pending.map((term) => [fold(term.source), term]));

  const batches = batchTerms(relatedFamilies(pending), DECIDE_BATCH_TERMS);

  const decisions: GlossaryTerm[] = [];
  const seen = new Set<string>();

  for (const [index, batch] of batches.entries()) {
    options.signal?.throwIfAborted();

    const listing = batch
      .map((term, i) => describeTerm(term, i + 1, sections, titles))
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

      // A model that answers the flag instead of setting it. The reuse list no
      // longer shows it the phrase, but the pinned glossary block and a style
      // note can say it just as loudly — and a 譯名 that reads "keep the
      // original" was never a 譯名. Left unread it reaches the prose as
      // `Emberwright => 保留原文` and the lorebook as a trigger nobody will type.
      const keepOriginal = item.keep === true || isKeepAnswer(asText(item.t));
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
 * One translated name the review thinks is wrong.
 *
 * `current` is what the term said when it was reviewed, and it is what makes a
 * finding disposable: the moment somebody takes the suggestion, retypes the
 * name, or decides it differently, the finding no longer describes anything and
 * the viewer can drop it without having to ask again.
 */
export interface TermReview {
  source: string;
  /** The translation as reviewed. Empty when the term is kept in the source language. */
  current: string;
  suggestion: string;
  /** One line on why the current name does not work. */
  reason: string;
}

interface RawIssue {
  s?: unknown;
  t?: unknown;
  why?: unknown;
}

/**
 * The bar a finding has to clear.
 *
 * Deliberately asymmetric: the model is asked for the names that are wrong, not
 * for a verdict on every name. A verdict per term would spend most of its output
 * on the nine in ten that are fine, and a list padded with "這個沒問題" is a list
 * nobody reads to the end. The cost of that choice is that a model asked for
 * problems will find some, so the prompt spends its length on what does *not*
 * count — the same constraint `checks.ts` states, for the same reason: one
 * needless suggestion teaches the reader to skip the next one.
 *
 * Rule 4 is a preference, not a fact about translation: a Latin-script name in
 * the middle of Chinese prose breaks immersion in roleplay, which is what these
 * cards are for. It is also where a real run went wrong — `keziah` kept in the
 * source language while `keziah's domain` became 凱齊亞的領域.
 */
const reviewPrompt = (targetLang: string, card: CardContext): string =>
  `你是一位資深的角色卡翻譯審稿。有人已經為這張卡的專有名詞決定了譯名，請你挑出其中真的該改的。目標語言是${targetLang}。

【該改的】
1. 譯名指向錯的東西——把設定裡的生物、組織、地點或概念，套成它在現實世界最常見的意思。
2. 譯名在中文裡會被讀成別的意思，或讀起來不像一個詞。
3. 同一個詞族前後不一致——詞根與它的複合詞用了不同的處理方式。
4. 人名、地名之類的專有名詞被標為「保留原文」。中文角色卡裡夾著外文名會讓讀者出戲，除非它本來就是縮寫或代號，否則應該音譯。

【不該改的】
- 只是換個說法、更文雅、或更貼近字面。譯名沒有唯一解，讀得通就不要動它。
- 同一個意思的不同寫法。
- 你沒把握的。寧可漏掉也不要硬提——每一條沒必要的建議，都會讓人更不想看這份清單。

【規則】
1. s 必須與清單中的原文完全一致。
2. t 是建議的新譯名，必須與現在的譯名不同。
3. why 用一句話說明現在這個為什麼不行。
4. 清單裡沒有一個該改時，回傳 {"issues":[]}。這是常見的結果，不是失敗。${contextBlock(card)}

【輸出格式】只輸出 JSON，不要有任何說明文字：
{"issues":[{"s":"原文詞","t":"建議譯名","why":"一句話理由"}]}`;

/**
 * Read the decided names back and say which ones are wrong.
 *
 * This is the layer the deterministic checks cannot reach. `simplifiedTargets`
 * can see a wrong character and `duplicateTargets` can see a collision, but no
 * rule can see that `parasite → 寄生蟲` should be 寄生體 on a card whose parasites
 * are not insects, or that `hive → 蜂巢` should be 蟲巢. That needs a reader who
 * knows what the card is about, which is what the background block and the
 * snippets are for.
 *
 * It is cheap where it counts: a 130-term card is four requests here against
 * thirty-six for the translation itself, so the judging can be given to a model
 * too expensive to write the whole card with.
 *
 * Nothing is written. The result is a list of findings for the viewer to offer,
 * one at a time, to somebody who can tell whether the model has a point.
 * Locked terms are skipped — locking already means "this one is settled", so it
 * doubles as the way to stop being asked about a finding you disagree with.
 */
export async function reviewTranslations(
  provider: Provider,
  fields: CardFields,
  terms: GlossaryTerm[],
  options: TranslateOptions & { onProgress?: ProgressFn },
): Promise<TermReview[]> {
  const decided = terms.filter((term) => !term.locked && isDecided(term));
  if (decided.length === 0) return [];

  const sections = cardSections(fields);
  const titles = entryTitles(fields);
  const bySource = new Map(decided.map((term) => [fold(term.source), term]));
  // Built here rather than taken from the caller, so a caller cannot forget it
  // and leave the reviewer judging names with no idea what the card is.
  const card = options.card ?? cardContext(fields);

  const batches = batchTerms(relatedFamilies(decided), REVIEW_BATCH_TERMS);

  const found: TermReview[] = [];
  const seen = new Set<string>();

  for (const [index, batch] of batches.entries()) {
    options.signal?.throwIfAborted();

    const listing = batch
      .map((term, i) => describeTerm(term, i + 1, sections, titles, true))
      .join('\n');

    const items = await chatJson<RawIssue>(
      provider,
      [
        { role: 'system', content: reviewPrompt(options.targetLang, card) },
        { role: 'user', content: `【要審的譯名】\n${listing}` },
      ],
      options,
      'issues',
      '檢查譯名',
    );

    for (const item of items) {
      const term = bySource.get(fold(asText(item.s)));
      if (!term || seen.has(fold(term.source))) continue;

      const suggestion = asText(item.t);
      const current = term.keepOriginal ? '' : term.target.trim();
      // A suggestion that is what the term already says is not a finding, and
      // presenting it as one costs the reader a decision for nothing.
      if (suggestion === '' || fold(suggestion) === fold(current)) continue;

      seen.add(fold(term.source));
      found.push({ source: term.source, current, suggestion, reason: asText(item.why) });
    }

    options.onProgress?.(index + 1, batches.length);
  }

  return found;
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
  /** The model had no room to answer in — this section is long, not blocked. */
  tooLong?: boolean;
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
      // A section too long to answer says as little about the other nineteen as
      // a blocked one does, so it does not vote for stopping either.
      const tooLong = failure?.tooLong ?? false;
      if (!filtered && !transient && !tooLong) fatalFailures++;
      return { ...base, error: describeError(error), filtered, transient, tooLong };
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
