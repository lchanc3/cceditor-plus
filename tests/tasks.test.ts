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
  cardContext,
  createRateGate,
  decideTranslations,
  extractTerms,
  sectionContext,
  translateCard,
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

  it('tells the model whose card this is', async () => {
    // A lorebook entry arrives on its own; without this the model has no idea
    // what world it is translating for.
    const { provider, calls } = fake('譯文');
    const fields = card({
      name: 'Kaelen',
      nickname: 'The Ashen',
      description: 'A knight sworn to the fallen keep of Ashfall.',
      character_book: {
        name: '',
        extensions: {},
        entries: [
          { ...createEmptyLorebookEntry(0), keys: ['keep', 'fortress'], content: 'It is old.' },
        ],
      },
    });

    await translateText(provider, 'It is old.', {
      ...options,
      card: cardContext(fields, 'lore:0'),
      section: sectionContext(fields, 'lore:0'),
    });

    const prompt = system(calls[0]);
    expect(prompt).toContain('角色：Kaelen（又稱 The Ashen）');
    expect(prompt).toContain('A knight sworn to the fallen keep of Ashfall.');
    expect(prompt).toContain('本段內容是：世界書 #1（keep）');
    expect(prompt).toContain('觸發關鍵字：keep、fortress');
    // Without this the background comes back as part of the answer.
    expect(prompt).toContain('絕對不要翻譯或輸出這一段');
  });

  it('does not repeat the description back when translating the description', async () => {
    const { provider, calls } = fake('譯文');
    const fields = card({ name: 'Kaelen', description: 'A knight of Ashfall.' });

    await translateText(provider, fields.description, {
      ...options,
      card: cardContext(fields, 'description'),
      section: sectionContext(fields, 'description'),
    });

    expect(system(calls[0])).toContain('角色：Kaelen');
    expect(system(calls[0])).not.toContain('設定摘要');
  });

  it('adds no background block when there is nothing to say', async () => {
    const { provider, calls } = fake('譯文');
    await translateText(provider, 'Hello.', { ...options, card: cardContext(card()) });
    expect(system(calls[0])).not.toContain('卡片背景');
  });

  it('truncates a long description rather than sending all of it', async () => {
    const { provider, calls } = fake('譯文');
    const fields = card({ name: 'X', description: 'a'.repeat(2000) });

    await translateText(provider, 'Hello.', { ...options, card: cardContext(fields) });
    const prompt = system(calls[0]);
    expect(prompt).toContain('…');
    expect(prompt.length).toBeLessThan(1200);
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

describe('createRateGate', () => {
  it('spaces requests out to the allowance, before anything is refused', async () => {
    // Reacting to a 429 is too late: the quota is already spent and the window
    // takes a minute to roll over.
    vi.useFakeTimers();
    const gate = createRateGate(10); // one every 6s
    const at: number[] = [];

    const run = (async () => {
      for (let i = 0; i < 3; i++) {
        await gate.wait();
        at.push(Date.now());
      }
    })();

    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    expect(at[1] - at[0]).toBe(6_000);
    expect(at[2] - at[1]).toBe(6_000);
  });

  it('lets concurrent callers queue rather than all going at once', async () => {
    vi.useFakeTimers();
    const gate = createRateGate(60); // one per second
    const at: number[] = [];

    const all = Promise.all(
      [0, 1, 2].map(async () => {
        await gate.wait();
        at.push(Date.now());
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await all;

    expect(new Set(at).size).toBe(3);
  });

  it('does not pace at all when the allowance is unset', async () => {
    const gate = createRateGate(0);
    const started = Date.now();
    await gate.wait();
    await gate.wait();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('still absorbs a rejection on top of the pacing', async () => {
    vi.useFakeTimers();
    const gate = createRateGate(0);
    gate.pause(5_000);

    let done = false;
    const waiting = gate.wait().then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await waiting;
    expect(done).toBe(true);
  });
});

describe('translateCard', () => {
  /** Replies by looking at what was sent, since pooled sections finish out of order. */
  function byContent(reply: (content: string) => string) {
    const seen: string[] = [];
    const provider: Provider = {
      id: 'openai',
      async chat(messages) {
        const content = messages.find((m) => m.role === 'user')?.content ?? '';
        seen.push(content);
        return reply(content);
      },
      async listModels() {
        return [];
      },
    };
    return { provider, seen };
  }

  const blocked = () => {
    throw new ProviderError('內容被過濾器攔截。', { filtered: true, retryable: false });
  };
  const brokenKey = () => {
    throw new ProviderError('金鑰無效。', { status: 400, retryable: false });
  };

  const fields = card({
    description: 'DESC',
    first_mes: 'FIRST',
    mes_example: 'EXAMPLE',
    alternate_greetings: ['GREET0', 'GREET1'],
    character_book: {
      name: '',
      extensions: {},
      entries: [
        { ...createEmptyLorebookEntry(0), keys: ['k'], content: 'LORE0' },
        { ...createEmptyLorebookEntry(1), keys: ['k'], content: 'LORE1' },
      ],
    },
  });

  // 3 plain fields + 2 greetings + 2 lore entries.
  const SECTION_COUNT = 7;

  it('translates every section and labels each result', async () => {
    const { provider } = byContent((content) => `譯:${content.match(/"""\n(.*)\n"""/s)?.[1]}`);
    const results = await translateCard(provider, fields, options);

    expect(results).toHaveLength(SECTION_COUNT);
    expect(results.map((r) => r.path)).toEqual([
      'description',
      'first_mes',
      'mes_example',
      'greeting:0',
      'greeting:1',
      'lore:0',
      'lore:1',
    ]);
    expect(results.find((r) => r.path === 'greeting:1')?.text).toBe('譯:GREET1');
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it('keeps the other sections when one is blocked', async () => {
    // The whole point: a card that trips a filter on one entry must not lose
    // the six translations that worked.
    const { provider } = byContent((content) => {
      if (content.includes('LORE0')) blocked();
      return '譯文';
    });

    const results = await translateCard(provider, fields, options);
    const failed = results.filter((r) => r.error !== undefined);

    expect(failed.map((r) => r.path)).toEqual(['lore:0']);
    expect(failed[0].filtered).toBe(true);
    expect(results.filter((r) => r.text !== undefined)).toHaveLength(SECTION_COUNT - 1);
  });

  it('never stops for filtered sections, however many there are', async () => {
    // A card whose every section trips the filter still gets every section
    // attempted — being blocked says nothing about the next one.
    let attempts = 0;
    const provider: Provider = {
      id: 'openai',
      async chat() {
        attempts++;
        return blocked();
      },
      async listModels() {
        return [];
      },
    };

    const results = await translateCard(provider, fields, { ...options, concurrency: 1 });

    expect(attempts).toBe(SECTION_COUNT);
    expect(results.every((r) => r.filtered)).toBe(true);
    expect(results.some((r) => r.skipped)).toBe(false);
  });

  it('does not stop for rate limits, however many sections are throttled', async () => {
    // The case that motivated this: a free Gemini tier is measured in requests
    // per minute, so a long card gets throttled halfway through. Treating that
    // as a broken endpoint discarded every section that had not run yet.
    let attempts = 0;
    const provider: Provider = {
      id: 'openai',
      async chat() {
        attempts++;
        // retryAfterMs 0 keeps the test quick; the classification is the point.
        throw new ProviderError('已達速率上限。', {
          status: 429,
          retryable: true,
          retryAfterMs: 0,
        });
      },
      async listModels() {
        return [];
      },
    };

    const results = await translateCard(provider, fields, { ...options, concurrency: 1 });

    expect(results.some((r) => r.skipped)).toBe(false);
    expect(results.every((r) => r.transient)).toBe(true);
    // Five attempts per section rather than three: being throttled earns more
    // patience than a hiccup does.
    expect(attempts).toBe(SECTION_COUNT * 5);
  });

  it('still stops for a connection that never reached a server', async () => {
    // Retryable, but with no status — nothing answered, so nothing will.
    let attempts = 0;
    const provider: Provider = {
      id: 'openai',
      async chat() {
        attempts++;
        throw new ProviderError('連線失敗。', { retryable: true });
      },
      async listModels() {
        return [];
      },
    };

    vi.useFakeTimers();
    const running = translateCard(provider, fields, { ...options, concurrency: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    const results = await running;

    expect(results.filter((r) => r.skipped).length).toBeGreaterThan(0);
    expect(results.some((r) => r.transient)).toBe(false);
    // Two sections, three attempts each, then the run gives up.
    expect(attempts).toBe(6);
  });

  it('stops after two failures that are not about the content', async () => {
    // A bad key fails every section identically; spending twenty requests to
    // discover that is pure waste.
    const { provider, seen } = byContent(brokenKey);
    const results = await translateCard(provider, fields, { ...options, concurrency: 1 });

    expect(seen).toHaveLength(2);
    expect(results.filter((r) => r.skipped)).toHaveLength(SECTION_COUNT - 2);
    expect(results[2].error).toContain('沒有嘗試');
  });

  it('tolerates a single non-filtered failure', async () => {
    const { provider } = byContent((content) => {
      if (content.includes('FIRST')) brokenKey();
      return '譯文';
    });

    const results = await translateCard(provider, fields, { ...options, concurrency: 1 });
    expect(results.filter((r) => r.skipped)).toHaveLength(0);
    expect(results.filter((r) => r.text !== undefined)).toHaveLength(SECTION_COUNT - 1);
  });

  it('retries only the paths it is given', async () => {
    const { provider, seen } = byContent(() => '譯文');
    const results = await translateCard(provider, fields, {
      ...options,
      only: ['lore:0', 'greeting:1'],
    });

    expect(seen).toHaveLength(2);
    expect(results.map((r) => r.path)).toEqual(['greeting:1', 'lore:0']);
  });

  it('reports progress as sections finish', async () => {
    const { provider } = byContent(() => '譯文');
    const steps: number[] = [];
    await translateCard(provider, fields, {
      ...options,
      concurrency: 1,
      onProgress: (done) => steps.push(done),
    });
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('does nothing for a card with no translatable text', async () => {
    const { provider, seen } = byContent(() => '譯文');
    expect(await translateCard(provider, card(), options)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('pins the glossary into each section it applies to', async () => {
    const systems: string[] = [];
    const provider: Provider = {
      id: 'openai',
      async chat(messages) {
        systems.push(messages.find((m) => m.role === 'system')?.content ?? '');
        return '譯文';
      },
      async listModels() {
        return [];
      },
    };

    await translateCard(provider, card({ description: 'The Elder rules.', first_mes: 'Hello.' }), {
      ...options,
      glossary: [term({ source: 'Elder', target: '長老' })],
    });

    expect(systems[0]).toContain('Elder => 長老');
    expect(systems[1]).not.toContain('術語表');
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
