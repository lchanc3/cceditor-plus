/**
 * What actually goes out on the wire.
 *
 * These tests drive the tasks against a scripted provider and assert on the
 * messages they build — the prompt is the product here, so it is the thing worth
 * pinning down.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CardFields, createEmptyCard, createEmptyLorebookEntry } from '../src/card';
import {
  decideTranslations,
  extractTerms,
  translateText,
} from '../src/ai/tasks';
import { ChatMessage, ChatOptions, Provider, ProviderError } from '../src/ai/types';
import { GlossaryTerm } from '../src/glossary';

interface Call {
  messages: ChatMessage[];
  options: ChatOptions;
}

/** Replays `replies` in order, repeating the last one once it runs out. */
function fake(...replies: string[]) {
  const calls: Call[] = [];
  let index = 0;

  const provider: Provider = {
    id: 'openai',
    async chat(messages, options = {}) {
      calls.push({ messages, options });
      return replies[Math.min(index++, replies.length - 1)] ?? '';
    },
    async listModels() {
      return [];
    },
  };

  return { provider, calls };
}

const system = (call: Call) => call.messages.find((m) => m.role === 'system')?.content ?? '';
const user = (call: Call) => call.messages.find((m) => m.role === 'user')?.content ?? '';

function card(overrides: Partial<CardFields> = {}): CardFields {
  return { ...createEmptyCard().fields, ...overrides };
}

function term(partial: Partial<GlossaryTerm> & { source: string }): GlossaryTerm {
  return {
    target: '',
    aliases: [],
    kind: 'other',
    origin: 'ai',
    locked: false,
    keepOriginal: false,
    ...partial,
  };
}

const options = { targetLang: '繁體中文' };

afterEach(() => {
  vi.useRealTimers();
});

describe('translateText prompt', () => {
  it('keeps the original instructions', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Hello.', options);

    expect(system(calls[0])).toContain('翻譯成繁體中文');
    expect(system(calls[0])).toContain('{{char}}');
    expect(system(calls[0])).toContain('只允許輸出純粹的翻譯內容');
    expect(user(calls[0])).toContain('Hello.');
  });

  it('adds no glossary block when there is no glossary', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Hello.', options);
    expect(system(calls[0])).not.toContain('術語表');
  });

  it('sends only the terms the text actually contains', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'The Grand Maiden Elder spoke.', {
      ...options,
      glossary: [
        term({ source: 'Grand Maiden Elder', target: '聖女長老' }),
        term({ source: 'Ashfall Keep', target: '燼落堡' }),
      ],
    });

    // The whole point of filtering: a 200-term card must not produce a
    // 200-line prompt for every field.
    expect(system(calls[0])).toContain('Grand Maiden Elder => 聖女長老');
    expect(system(calls[0])).not.toContain('Ashfall Keep');
  });

  it('omits the block entirely when nothing matches', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'A quiet day.', {
      ...options,
      glossary: [term({ source: 'Ashfall Keep', target: '燼落堡' })],
    });
    expect(system(calls[0])).not.toContain('術語表');
  });

  it('marks kept-original terms rather than giving them a translation', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Kaelen arrived.', {
      ...options,
      glossary: [term({ source: 'Kaelen', keepOriginal: true })],
    });
    expect(system(calls[0])).toContain('Kaelen => 保留原文');
  });

  it('leaves undecided terms out of the prompt', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Emberwright rose.', {
      ...options,
      glossary: [term({ source: 'Emberwright' })],
    });
    expect(system(calls[0])).not.toContain('術語表');
  });

  it('passes style notes through', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Hello.', { ...options, styleNotes: '第二人稱用「你」。' });
    expect(system(calls[0])).toContain('【文風要求】');
    expect(system(calls[0])).toContain('第二人稱用「你」。');
  });
});

describe('extractTerms', () => {
  it('asks for JSON at a low temperature', async () => {
    const { provider, calls } = fake('{"terms":[]}');
    await extractTerms(provider, card({ description: 'x' }), options);

    expect(calls[0].options.json).toBe(true);
    expect(calls[0].options.temperature).toBe(0.1);
  });

  it('sends nothing at all for an empty card', async () => {
    const { provider, calls } = fake('{"terms":[]}');
    expect(await extractTerms(provider, card(), options)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns undecided terms attributed to the model', async () => {
    const { provider } = fake('{"terms":[{"s":"Ashfall Keep","k":"place","a":["the Keep"]}]}');
    const found = await extractTerms(provider, card({ description: 'x' }), options);

    expect(found).toEqual([
      term({ source: 'Ashfall Keep', kind: 'place', aliases: ['the Keep'], origin: 'ai' }),
    ]);
  });

  it('falls back to a safe kind and drops an alias that repeats the source', async () => {
    const { provider } = fake('{"terms":[{"s":"Elder","k":"weapon","a":["elder","the Elder"]}]}');
    const [found] = await extractTerms(provider, card({ description: 'x' }), options);

    expect(found.kind).toBe('other');
    expect(found.aliases).toEqual(['the Elder']);
  });

  it('splits a long card into several requests and merges the results', async () => {
    const fields = card({ description: 'a'.repeat(3000), first_mes: 'b'.repeat(3000) });
    const { provider, calls } = fake(
      '{"terms":[{"s":"Elder"}]}',
      '{"terms":[{"s":"elder"},{"s":"Ashfall Keep"}]}',
    );

    const steps: number[] = [];
    const found = await extractTerms(provider, fields, {
      ...options,
      onProgress: (done, total) => steps.push(done / total),
    });

    expect(calls).toHaveLength(2);
    // Case-insensitive merge across batches, first spelling kept.
    expect(found.map((t) => t.source)).toEqual(['Elder', 'Ashfall Keep']);
    expect(steps).toEqual([0.5, 1]);
  });

  it('retries malformed JSON, then succeeds', async () => {
    const { provider, calls } = fake('抱歉，我無法完成。', '{"terms":[{"s":"Elder"}]}');
    const found = await extractTerms(provider, card({ description: 'x' }), options);

    expect(calls).toHaveLength(2);
    expect(found.map((t) => t.source)).toEqual(['Elder']);
  });

  it('gives up after three attempts', async () => {
    vi.useFakeTimers();
    const { provider, calls } = fake('這不是 JSON。');

    const failing = extractTerms(provider, card({ description: 'x' }), options);
    const assertion = expect(failing).rejects.toThrow(ProviderError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(calls).toHaveLength(3);
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = fake('{"terms":[]}');

    await expect(
      extractTerms(provider, card({ description: 'x' }), { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('decideTranslations', () => {
  const fields = card({
    description: 'In the west, the Grand Maiden Elder rules Ashfall Keep without mercy.',
  });

  it('does nothing when every term is already decided', async () => {
    const { provider, calls } = fake('{"terms":[]}');
    const decided = await decideTranslations(
      provider,
      fields,
      [term({ source: 'Elder', target: '長老' })],
      options,
    );

    expect(decided).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('leaves locked terms alone even when undecided', async () => {
    const { provider, calls } = fake('{"terms":[]}');
    await decideTranslations(provider, fields, [term({ source: 'Elder', locked: true })], options);
    expect(calls).toHaveLength(0);
  });

  it('shows the model where the term is used', async () => {
    const { provider, calls } = fake('{"terms":[{"s":"Grand Maiden Elder","t":"聖女長老"}]}');
    await decideTranslations(provider, fields, [term({ source: 'Grand Maiden Elder' })], options);

    expect(user(calls[0])).toContain('Grand Maiden Elder');
    expect(user(calls[0])).toContain('出現於：');
    expect(user(calls[0])).toContain('rules Ashfall Keep');
  });

  it('carries already-decided terms as a must-reuse list', async () => {
    const { provider, calls } = fake('{"terms":[{"s":"Ashfall Keep","t":"燼落堡"}]}');
    await decideTranslations(
      provider,
      fields,
      [
        term({ source: 'Grand Maiden Elder', target: '聖女長老', origin: 'manual' }),
        term({ source: 'Kaelen', keepOriginal: true }),
        term({ source: 'Ashfall Keep' }),
      ],
      options,
    );

    // This is what stops a second run drifting away from the first.
    expect(system(calls[0])).toContain('Grand Maiden Elder => 聖女長老');
    expect(system(calls[0])).toContain('Kaelen => 保留原文');

    // Only the undecided term is asked about. It is checked against the numbered
    // list rather than the whole message, because a decided term can still show
    // up inside another term's context snippet.
    const listed = user(calls[0])
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('Ashfall Keep');
  });

  it('records a decision to keep the original', async () => {
    const { provider } = fake('{"terms":[{"s":"Kaelen","keep":true}]}');
    const [decided] = await decideTranslations(
      provider,
      fields,
      [term({ source: 'Kaelen' })],
      options,
    );

    expect(decided.keepOriginal).toBe(true);
    expect(decided.target).toBe('');
    expect(decided.origin).toBe('ai');
  });

  it('drops terms that were never asked about', async () => {
    const { provider } = fake(
      '{"terms":[{"s":"Invented","t":"憑空"},{"s":"Ashfall Keep","t":"燼落堡"}]}',
    );
    const decided = await decideTranslations(
      provider,
      fields,
      [term({ source: 'Ashfall Keep' })],
      options,
    );

    expect(decided.map((t) => t.source)).toEqual(['Ashfall Keep']);
  });

  it('drops duplicates and entries with no decision in them', async () => {
    const { provider } = fake(
      '{"terms":[{"s":"Ashfall Keep","t":"燼落堡"},{"s":"Ashfall Keep","t":"灰堡"},{"s":"Elder"}]}',
    );
    const decided = await decideTranslations(
      provider,
      fields,
      [term({ source: 'Ashfall Keep' }), term({ source: 'Elder' })],
      options,
    );

    expect(decided).toHaveLength(1);
    expect(decided[0].target).toBe('燼落堡');
  });

  it('splits a large glossary across requests', async () => {
    const pending = Array.from({ length: 45 }, (_, i) => term({ source: `Term${i}` }));
    const { provider, calls } = fake('{"terms":[]}');

    await decideTranslations(provider, fields, pending, options);
    expect(calls).toHaveLength(2);
  });
});

describe('lorebook entries feed the same pipeline', () => {
  it('extracts from lore content as its own labelled section', async () => {
    const fields = card({
      character_book: {
        name: '',
        extensions: {},
        entries: [
          {
            ...createEmptyLorebookEntry(0),
            keys: ['Emberwright'],
            comment: '公會',
            content: 'The Emberwright guild forges in secret.',
          },
        ],
      },
    });

    const { provider, calls } = fake('{"terms":[{"s":"Emberwright","k":"org"}]}');
    await extractTerms(provider, fields, options);

    expect(user(calls[0])).toContain('世界書 #1（公會）');
    expect(user(calls[0])).toContain('forges in secret');
  });
});
