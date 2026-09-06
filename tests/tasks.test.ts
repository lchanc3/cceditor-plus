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
  reviewTranslations,
  translateKeywords,
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
    // Not a refusal — that is a different failure with a different message.
    const { provider, calls } = fake('這不是 JSON。', '{"terms":[{"s":"Elder"}]}');
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

describe('refusals that arrive as an ordinary 200', () => {
  const long =
    'The Order of the Sacred Shield keeps the cathedral, and its sisters walk the ' +
    'walls at every hour of the night, watching the swamp for what crawls out of it. ' +
    'The initiates are told nothing of what the matrons already know.';

  it('does not write a refusal into the card as though it were the translation', async () => {
    const { provider, calls } = fake("I'm sorry, but I can't help with that request.");

    await expect(translateText(provider, long, options)).rejects.toThrow(/拒絕翻譯/);

    // Not retried: a refusal refuses again, and each attempt costs a request.
    expect(calls).toHaveLength(1);
  });

  it('marks the refusal as filtered, so one section does not fail the run', async () => {
    const { provider } = fake('抱歉，我無法翻譯這段內容。');
    const error = await translateText(provider, long, options).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).filtered).toBe(true);
  });

  it('lets a short source translate into a short apology, which is not a refusal', async () => {
    // The guard that keeps this check from eating real work: a section whose
    // source apologises should come back apologising.
    const { provider } = fake('對不起，我來遲了。');
    await expect(translateText(provider, 'I am sorry, I am late.', options)).resolves.toBe(
      '對不起，我來遲了。',
    );
  });

  it('calls a refusal a refusal on the JSON tasks, not a format error', async () => {
    const { provider, calls } = fake("I'm sorry, I can't assist with this content.");
    const error = await extractTerms(provider, card({ description: 'A knight.' }), options).catch(
      (e) => e,
    );

    expect((error as Error).message).toContain('拒絕作答');
    expect((error as Error).message).not.toContain('格式不對');
    expect(calls).toHaveLength(1);
  });

  it('still calls malformed JSON a format error, and still retries it', async () => {
    const { provider, calls } = fake('{"nope": 1}', '{"terms":[{"s":"Ashfall","t":"燼落"}]}');
    const found = await extractTerms(provider, card({ description: 'Ashfall.' }), options);

    expect(found.map((term) => term.source)).toEqual(['Ashfall']);
    expect(calls.length).toBeGreaterThan(1);
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

  it('names the lorebook entry a term keys, which is what settles what it is', async () => {
    // The real failure: a bare `church` was translated as a building on a card
    // whose entry is called Church of the Eternal Light.
    const withBook = card({
      description: 'The church has stood for three centuries.',
      character_book: {
        name: '',
        extensions: {},
        entries: [
          {
            ...createEmptyLorebookEntry(0),
            comment: 'Church of the Eternal Light',
            keys: ['church', 'cathedral'],
            content: 'The faith of the realm.',
          },
          {
            ...createEmptyLorebookEntry(1),
            comment: 'Cathedral of Divine Protection',
            keys: ['cathedral'],
            content: 'A building of white marble.',
          },
        ],
      },
    });

    const { provider, calls } = fake('{"terms":[{"s":"church","t":"教會"}]}');
    await decideTranslations(
      provider,
      withBook,
      [term({ source: 'church' }), term({ source: 'cathedral' })],
      options,
    );

    const listed = user(calls[0]).split('\n');
    expect(listed.find((line) => line.includes('church'))).toContain(
      '世界書條目：Church of the Eternal Light',
    );

    // `cathedral` keys both entries, so it names neither. Attributing it to
    // whichever came first would be worse than saying nothing.
    expect(listed.find((line) => line.startsWith('2. cathedral'))).not.toContain('世界書條目');
  });

  it('keeps terms sharing a root in one request, however far apart they were', async () => {
    // The real failure: keziah was kept in the source language in one batch
    // while keziah's domain was translated in another, and no instruction could
    // have reconciled them because they were never seen together.
    const filler = Array.from({ length: 45 }, (_, i) => term({ source: `filler${i}` }));
    const glossary = [
      term({ source: "keziah's domain" }),
      ...filler,
      term({ source: 'keziah' }),
      term({ source: "keziah's den" }),
    ];

    const { provider, calls } = fake('{"terms":[]}');
    await decideTranslations(provider, card(), glossary, options);

    expect(calls.length).toBeGreaterThan(1);

    const carrying = calls.filter((call) => /(^|\n)\d+\. keziah/m.test(user(call)));
    expect(carrying).toHaveLength(1);

    const listing = user(carrying[0]);
    for (const source of ['keziah', "keziah's domain", "keziah's den"]) {
      expect(listing).toContain(source);
    }
  });

  it('does not drag plurals into the family, since they settle on their own', async () => {
    const filler = Array.from({ length: 45 }, (_, i) => term({ source: `filler${i}` }));
    const { provider, calls } = fake('{"terms":[]}');
    await decideTranslations(
      provider,
      card(),
      [term({ source: 'sister' }), ...filler, term({ source: 'sisters' })],
      options,
    );

    // `sister` does not match inside `sisters` — the glossary's matcher respects
    // word boundaries — so nothing reorders and the two stay where they were.
    const first = user(calls[0]);
    expect(first).toContain('1. sister（');
    expect(first).not.toContain('sisters');
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

describe('translateKeywords', () => {
  it('splits on either script’s separators', async () => {
    const { provider } = fake('蘋果, 樹、房子');
    expect(await translateKeywords(provider, ['apple', 'tree', 'house'], options)).toEqual([
      '蘋果',
      '樹',
      '房子',
    ]);
  });

  it('throws away a reply that restates the question instead of answering it', async () => {
    // What a confused endpoint returns. Every fragment of it is short enough to
    // pass for a keyword — the count is the only thing that tells prose apart
    // from an answer, and the whole-card run now reaches this path for every
    // key the glossary has no term for.
    const { provider } = fake('請將以下關鍵字清單翻譯成繁體中文，並以逗號分隔回傳。'.repeat(3));
    expect(await translateKeywords(provider, ['hive'], options)).toEqual([]);
  });

  it('throws away an answer with an explanation attached', async () => {
    const { provider } = fake('蜂巢, 說明：\n這個詞指的是蟲子的巢穴。');
    expect(await translateKeywords(provider, ['hive'], options)).toEqual([]);
  });

  it('throws away one long enough to be a sentence on its own', async () => {
    const { provider } = fake('這個關鍵字在這張卡的語境裡指的是蟲族聚居的巢穴而不是蜜蜂的窩'.repeat(2));
    expect(await translateKeywords(provider, ['hive'], options)).toEqual([]);
  });

  it('ignores blanks around the separators rather than counting them', async () => {
    const { provider } = fake('蘋果, 樹, ');
    expect(await translateKeywords(provider, ['apple', 'tree'], options)).toEqual(['蘋果', '樹']);
  });
});

describe('reviewTranslations', () => {
  const fields = card({
    name: 'Keziah',
    description: 'The hive answers to Keziah, and her parasites wear the shapes of men.',
  });

  it('has nothing to review until something has been decided', async () => {
    const { provider, calls } = fake('{"issues":[]}');
    const found = await reviewTranslations(
      provider,
      fields,
      [term({ source: 'hive' }), term({ source: 'parasite' })],
      options,
    );

    expect(found).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('leaves locked terms out, which is how a finding is refused for good', async () => {
    const { provider, calls } = fake('{"issues":[]}');
    await reviewTranslations(
      provider,
      fields,
      [term({ source: 'hive', target: '蜂巢', locked: true })],
      options,
    );

    expect(calls).toHaveLength(0);
  });

  it('shows the model what each name says now, and what the card is', async () => {
    const { provider, calls } = fake('{"issues":[]}');
    await reviewTranslations(
      provider,
      fields,
      [term({ source: 'hive', target: '蜂巢' }), term({ source: 'Keziah', keepOriginal: true })],
      options,
    );

    const listing = user(calls[0]);
    expect(listing).toContain('現在的譯名：蜂巢');
    expect(listing).toContain('現在的譯名：保留原文');
    // Judging 蜂巢 against 蟲巢 takes knowing what the card is about; the term
    // and its own translation say nothing either way.
    expect(listing).toContain('出現於：');
    expect(system(calls[0])).toContain('角色：Keziah');
    expect(system(calls[0])).toContain('parasites wear the shapes of men');
  });

  it('reports a name that should not have been kept in the source language', async () => {
    // A Latin-script name in the middle of Chinese prose breaks immersion, and
    // this is the case a rule cannot see: the term is decided, spelled right,
    // and used consistently.
    const { provider } = fake(
      '{"issues":[{"s":"Keziah","t":"凱齊亞","why":"RP 中夾著外文名會出戲。"}]}',
    );
    const [found] = await reviewTranslations(
      provider,
      fields,
      [term({ source: 'Keziah', keepOriginal: true })],
      options,
    );

    expect(found).toEqual({
      source: 'Keziah',
      current: '',
      suggestion: '凱齊亞',
      reason: 'RP 中夾著外文名會出戲。',
    });
  });

  it('drops a suggestion that is what the term already says', async () => {
    // Nothing to decide, so presenting it as a finding costs the reader a
    // decision for nothing — and teaches them to skip the next one.
    const { provider } = fake('{"issues":[{"s":"hive","t":"蜂巢","why":"看起來不錯。"}]}');
    const found = await reviewTranslations(
      provider,
      fields,
      [term({ source: 'hive', target: '蜂巢' })],
      options,
    );

    expect(found).toEqual([]);
  });

  it('drops findings about terms it never asked about, and repeats of one it did', async () => {
    const { provider } = fake(
      '{"issues":[{"s":"Invented","t":"憑空","why":"x"},{"s":"hive","t":"蟲巢","why":"這張卡的 hive 不是蜂。"},{"s":"hive","t":"巢穴","why":"y"}]}',
    );
    const found = await reviewTranslations(
      provider,
      fields,
      [term({ source: 'hive', target: '蜂巢' })],
      options,
    );

    expect(found).toHaveLength(1);
    expect(found[0].suggestion).toBe('蟲巢');
    expect(found[0].current).toBe('蜂巢');
  });

  it('reviews a whole glossary in a fraction of the requests translating it takes', async () => {
    const decided = Array.from({ length: 130 }, (_, i) =>
      term({ source: `Term${i}`, target: `譯${i}` }),
    );
    const { provider, calls } = fake('{"issues":[]}');

    await reviewTranslations(provider, fields, decided, options);
    // Four requests against the thirty-something a card this size costs to
    // translate, which is what lets an expensive model do the judging.
    expect(calls).toHaveLength(4);
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
