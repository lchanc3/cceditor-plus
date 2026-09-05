/**
 * Two things are under test: digging JSON out of whatever a model actually said,
 * and the wiring that asks the endpoint for JSON in the first place.
 *
 * The second matters because the OpenAI-compatible provider points at servers
 * that disagree about `response_format` — the fallback has to be exercised, not
 * assumed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGeminiProvider } from '../src/ai/gemini';
import { parseJsonItems, parseJsonLoose } from '../src/ai/json';
import { createOpenAIProvider } from '../src/ai/openai';
import { ProviderError } from '../src/ai/types';

describe('parseJsonLoose', () => {
  it('parses a clean object or array', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('[1,2]')).toEqual([1, 2]);
    expect(parseJsonLoose('  \n {"a":1}\n  ')).toEqual({ a: 1 });
  });

  it('sees through a code fence', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores prose on either side', () => {
    expect(parseJsonLoose('好的，這是結果：\n{"a":1}\n希望有幫助！')).toEqual({ a: 1 });
  });

  it('steps over stray braces in a preamble', () => {
    expect(parseJsonLoose('Here {is} what you asked for: {"terms":[{"s":"X"}]}')).toEqual({
      terms: [{ s: 'X' }],
    });
  });

  it('is not confused by brackets inside strings', () => {
    const text = '{"note":"用 {{char}} 與 [方括號] 都可以","list":["}","]"]}';
    expect(parseJsonLoose(text)).toEqual({
      note: '用 {{char}} 與 [方括號] 都可以',
      list: ['}', ']'],
    });
  });

  it('handles escaped quotes and backslashes', () => {
    expect(parseJsonLoose('{"a":"她說「\\"好\\"」","p":"C:\\\\path\\\\"}')).toEqual({
      a: '她說「"好"」',
      p: 'C:\\path\\',
    });
  });

  it('keeps CJK content intact', () => {
    expect(parseJsonLoose('{"s":"Grand Maiden Elder","t":"聖女長老"}')).toEqual({
      s: 'Grand Maiden Elder',
      t: '聖女長老',
    });
  });

  it('repairs trailing commas', () => {
    expect(parseJsonLoose('{"a":1,}')).toEqual({ a: 1 });
    expect(parseJsonLoose('[1,2,]')).toEqual([1, 2]);
    expect(parseJsonLoose('{"a":[1,2,],"b":{"c":3,},}')).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(parseJsonLoose('{"a": 1 ,\n}')).toEqual({ a: 1 });
  });

  it('does not touch a comma that lives inside a string', () => {
    expect(parseJsonLoose('{"note":"先寫 a, } 再說","x":1,}')).toEqual({
      note: '先寫 a, } 再說',
      x: 1,
    });
  });

  it('reads deeply nested output', () => {
    const nested = { terms: [{ s: 'A', meta: { k: ['x', { deep: true }] } }] };
    expect(parseJsonLoose(JSON.stringify(nested))).toEqual(nested);
  });

  it.each([
    ['truncated output', '{"terms":[{"s":"A"'],
    ['mismatched brackets', '{"a":[1,2}'],
    ['plain prose', '抱歉，我無法完成這個要求。'],
    ['an empty response', '   '],
    ['a bare string', '"just a string"'],
    ['a bare number', '42'],
    ['null', 'null'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseJsonLoose(text)).toThrow(ProviderError);
  });

  it('throws a retryable error naming what came back', () => {
    try {
      parseJsonLoose('抱歉，我無法完成這個要求。', '抽取專有名詞');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      // Malformed output is usually fixed by asking again, so `chatWithRetry`
      // should be allowed to.
      expect((error as ProviderError).retryable).toBe(true);
      expect((error as ProviderError).message).toContain('抽取專有名詞');
      expect((error as ProviderError).message).toContain('抱歉，我無法完成這個要求。');
    }
  });

  it('keeps the error preview short and on one line', () => {
    const noise = `${'看起來像雜訊的很長前言。'.repeat(40)}`;
    const message = (() => {
      try {
        parseJsonLoose(noise);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(220);
    expect(message).toContain('…');
  });

  it('gives up rather than scanning an unbounded number of stray braces', () => {
    const strays = '{x} '.repeat(20);
    expect(() => parseJsonLoose(`${strays}{"a":1}`)).toThrow(ProviderError);
  });
});

describe('parseJsonItems', () => {
  it('accepts the wrapper object it asked for', () => {
    expect(parseJsonItems('{"terms":[{"s":"A"},{"s":"B"}]}', 'terms')).toEqual([
      { s: 'A' },
      { s: 'B' },
    ]);
  });

  it('accepts a bare array, which models return just as often', () => {
    expect(parseJsonItems('[{"s":"A"}]', 'terms')).toEqual([{ s: 'A' }]);
  });

  it('accepts an empty list', () => {
    expect(parseJsonItems('{"terms":[]}', 'terms')).toEqual([]);
  });

  it('rejects an object without the list', () => {
    expect(() => parseJsonItems('{"result":"none"}', 'terms')).toThrow(/terms/);
    expect(() => parseJsonItems('{"terms":"none"}', 'terms')).toThrow(/terms/);
  });
});

// ---------------------------------------------------------------------------
// JSON mode on the wire
// ---------------------------------------------------------------------------

/** Records each request body so the tests can assert on what was actually sent. */
function stubFetch(...responses: { status: number; body: unknown }[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, fetchMock };
}

const completion = (text: string) => ({ choices: [{ message: { content: text } }] });
const generated = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

const openai = () =>
  createOpenAIProvider({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI-compatible JSON mode', () => {
  it('asks for JSON when told to', async () => {
    const { bodies } = stubFetch({ status: 200, body: completion('{"a":1}') });
    await openai().chat([{ role: 'user', content: 'hi' }], { json: true });
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
  });

  it('does not ask for JSON otherwise', async () => {
    const { bodies } = stubFetch({ status: 200, body: completion('hello') });
    await openai().chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0].response_format).toBeUndefined();
  });

  it('retries without the parameter when the endpoint rejects it', async () => {
    // What LM Studio, Ollama and assorted proxies do with an unknown parameter.
    const { bodies, fetchMock } = stubFetch(
      { status: 400, body: { error: { message: 'unknown parameter: response_format' } } },
      { status: 200, body: completion('{"a":1}') },
    );

    const text = await openai().chat([{ role: 'user', content: 'hi' }], { json: true });

    expect(text).toBe('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0].response_format).toBeDefined();
    expect(bodies[1].response_format).toBeUndefined();
    // The rest of the request has to survive the retry unchanged.
    expect(bodies[1].model).toBe('m');
    expect(bodies[1].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it.each([401, 403, 404, 429, 500])('does not retry on HTTP %i', async (status) => {
    const { fetchMock } = stubFetch({ status, body: { error: { message: 'nope' } } });

    await expect(openai().chat([{ role: 'user', content: 'hi' }], { json: true })).rejects.toThrow(
      ProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the second failure when the fallback fails too', async () => {
    const { fetchMock } = stubFetch(
      { status: 400, body: { error: { message: 'first' } } },
      { status: 400, body: { error: { message: 'model not found' } } },
    );

    await expect(
      openai().chat([{ role: 'user', content: 'hi' }], { json: true }),
    ).rejects.toThrow(/model not found/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Gemini JSON mode', () => {
  const gemini = () => createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });

  it('sets the response mime type when told to', async () => {
    const { bodies } = stubFetch({ status: 200, body: generated('{"a":1}') });
    await gemini().chat([{ role: 'user', content: 'hi' }], { json: true });
    expect(
      (bodies[0].generationConfig as Record<string, unknown>).responseMimeType,
    ).toBe('application/json');
  });

  it('leaves it unset otherwise', async () => {
    const { bodies } = stubFetch({ status: 200, body: generated('hello') });
    await gemini().chat([{ role: 'user', content: 'hi' }]);
    expect(
      (bodies[0].generationConfig as Record<string, unknown>).responseMimeType,
    ).toBeUndefined();
  });
});
