/**
 * Getting JSON back out of a chat model.
 *
 * Asking an endpoint for strict JSON (`responseMimeType` on Gemini,
 * `response_format` on OpenAI) helps, but it is not something we can rely on:
 * the OpenAI-compatible endpoint may be LM Studio, Ollama, or somebody's proxy,
 * and those variously honour the flag, ignore it, or reject the request. So the
 * parser here assumes the worst — prose around the JSON, a ``` fence, a trailing
 * comma — and digs the value out anyway.
 *
 * Deliberately not attempted: quote and bracket repair. A model that produced
 * unbalanced brackets produced truncated output, and guessing at the missing
 * half invents data rather than recovering it. Those cases throw, and the
 * request is retried instead.
 */

import { ProviderError } from './types';

/** Enough attempts to skip stray braces in a preamble, few enough to stay cheap. */
const MAX_CANDIDATES = 12;

/**
 * Index of the bracket closing the one at `start`, or -1 if it never closes.
 * String-aware, so punctuation inside a translated string cannot unbalance it.
 */
function matchBalanced(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i;
    }
  }

  return -1;
}

/**
 * Drop commas that sit right before a closing bracket. Models emit them
 * constantly and `JSON.parse` refuses them; nothing is lost by removing them.
 */
function dropTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ',') {
      let next = i + 1;
      while (next < json.length && /\s/.test(json[next])) next++;
      if (json[next] === '}' || json[next] === ']') continue;
    }

    out += char;
  }

  return out;
}

function tryParse(candidate: string): { ok: true; value: unknown } | { ok: false } {
  for (const text of [candidate, dropTrailingCommas(candidate)]) {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      /* try the repaired form, then give up on this candidate */
    }
  }
  return { ok: false };
}

/**
 * Every plausible JSON value in `text`, best first: the whole string, then each
 * balanced bracket pair from the left. A ``` fence needs no special handling —
 * it is just prose either side of the value.
 */
function* candidates(text: string): Generator<string> {
  const trimmed = text.trim();
  if (trimmed !== '') yield trimmed;

  let attempts = 0;
  for (let i = 0; i < text.length && attempts < MAX_CANDIDATES; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    attempts++;
    const end = matchBalanced(text, i);
    if (end !== -1) yield text.slice(i, end + 1);
  }
}

/** A short, single-line excerpt of what came back, for the error message. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '（空白回應）';
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Parse a JSON object or array out of a model response.
 *
 * Throws a retryable `ProviderError` when nothing parses — a second attempt at
 * the same prompt usually succeeds, so this plugs into the existing retry.
 */
export function parseJsonLoose<T = unknown>(text: string, context = 'AI 回應'): T {
  for (const candidate of candidates(text)) {
    const result = tryParse(candidate);
    // A bare string or number is not what any caller here asked for; keep looking.
    if (result.ok && typeof result.value === 'object' && result.value !== null) {
      return result.value as T;
    }
  }

  throw new ProviderError(
    `${context}不是有效的 JSON。模型回傳的是：${preview(text)}`,
    { retryable: true },
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A list of items, however the model chose to wrap it.
 *
 * Asked for `{"terms": [...]}`, models return a bare `[...]` often enough that
 * treating it as a failure would throw away perfectly good output. Both are
 * accepted; anything else is not.
 */
export function parseJsonItems<T = unknown>(
  text: string,
  key: string,
  context = 'AI 回應',
): T[] {
  const parsed = parseJsonLoose(text, context);

  if (Array.isArray(parsed)) return parsed as T[];
  if (isRecord(parsed) && Array.isArray(parsed[key])) return parsed[key] as T[];

  throw new ProviderError(
    `${context}的格式不對，找不到 "${key}" 清單。模型回傳的是：${preview(text)}`,
    { retryable: true },
  );
}
