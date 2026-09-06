/**
 * An OpenAI-compatible endpoint that fails on purpose.
 *
 * The failure paths that matter most — a content filter, a rate limit — cannot
 * be triggered on demand against a real provider. Gemini's safety categories
 * are turned all the way down precisely so filtering is rare, and a rate limit
 * arrives when it arrives. This serves the same shapes deterministically, so
 * the UI can be exercised without gambling on a live endpoint.
 *
 *   npm run mock
 *
 * Then point the OpenAI-compatible provider at http://localhost:4545/v1 and put
 * a marker word into whichever field should misbehave:
 *
 *   FILTERME   finish_reason: content_filter   (a blocked section)
 *   RATEME     429 with Retry-After: 5         (throttling, then success)
 *   BOOMME     500                             (a transient server error)
 *   DEADME     401                             (fatal — should stop the run)
 *   SLOWME     a 20s reply                     (for testing cancellation) *   MOJIME     a reply peppered with U+FFFD     (characters the model destroyed)
 *
 * The glossary passes that work from a numbered term listing — deciding names
 * and reviewing them — are answered in their own JSON shape, so the whole
 * seed → decide → review → translate flow can be walked without a real key.
 *
 * Anything else comes back as a fake translation, so a card with one FILTERME
 * lore entry produces exactly the partial-success case worth looking at.
 *
 * RATEME succeeds on the third attempt, so the backoff can be seen working
 * rather than only the giving-up path.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4545);

/** How many times each throttled body has been seen, so it can recover. */
const rateAttempts = new Map<string, number>();
const RATE_SUCCEEDS_ON = 3;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reply that is obviously not a real translation, but is the right shape. */
function fakeTranslation(content: string): string {
  const inner = content.match(/"""\n([\s\S]*)\n"""/)?.[1] ?? content;
  // Keep macros and line structure, so the post-translation checks see a clean
  // result unless the card itself is odd.
  return inner
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `【譯】${line}`))
    .join('\n');
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = req.url ?? '';

  if (url.endsWith('/models')) {
    send(res, 200, { data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] });
    return;
  }

  if (!url.includes('/chat/completions')) {
    send(res, 404, { error: { message: `no route for ${url}` } });
    return;
  }

  const raw = await readBody(req);
  const parsed = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
  const content = parsed.messages?.map((m) => m.content).join('\n') ?? '';
  const label = content.slice(0, 60).replace(/\s+/g, ' ');

  if (content.includes('DEADME')) {
    console.log(`401  ${label}`);
    send(res, 401, { error: { message: 'Incorrect API key provided.' } });
    return;
  }

  if (content.includes('RATEME')) {
    const key = content.slice(0, 200);
    const seen = (rateAttempts.get(key) ?? 0) + 1;
    rateAttempts.set(key, seen);

    if (seen < RATE_SUCCEEDS_ON) {
      console.log(`429  attempt ${seen}  ${label}`);
      send(
        res,
        429,
        { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } },
        { 'Retry-After': '5' },
      );
      return;
    }
    console.log(`200  after ${seen} attempts  ${label}`);
  }

  if (content.includes('BOOMME')) {
    console.log(`500  ${label}`);
    send(res, 500, { error: { message: 'internal error' } });
    return;
  }

  if (content.includes('FILTERME')) {
    console.log(`filter  ${label}`);
    // A finish_reason rather than an HTTP error, which is how OpenAI reports it.
    send(res, 200, {
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
    });
    return;
  }

  if (content.includes('MOJIME')) {
    console.log(`mojibake  ${label}`);
    // A reply that is otherwise perfectly good, with the occasional character
    // replaced by U+FFFD. This is not hypothetical: one 55,000-character card
    // came back from a live endpoint carrying forty-nine of them, and every
    // check in `checks.ts` passed all thirty-six of its sections. The encoding
    // check exists because of that run, and this marker is how it gets
    // exercised without waiting for a model to corrupt something again.
    const text = [...fakeTranslation(content)]
      .map((ch, i) => (i > 0 && i % 40 === 0 && ch.trim() !== '' ? '�' : ch))
      .join('');
    send(res, 200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
    return;
  }

  if (content.includes('SLOWME')) {
    console.log(`slow  ${label}`);
    await wait(20_000);
  }

  // Lorebook keys are asked about by number and answered by number. The generic
  // reply — the prompt, echoed back — is exactly the malformed answer the real
  // parser is built to reject, so this path could not be walked at all without
  // answering it in its own shape.
  if (content.includes('【待翻譯關鍵字】')) {
    // Only the listing, never the system prompt: its rules are a numbered list
    // too, and a mock that answers those is answering its own instructions.
    const listing = parsed.messages?.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const numbered = [...listing.matchAll(/^(\d+)\. (.+)$/gm)];

    console.log(`keys  ${numbered.length}: ${numbered.map((m) => m[2]).join(' ')}`);
    send(res, 200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              keys: numbered.map((match) => ({ i: Number(match[1]), t: `譯${match[2]}` })),
            }),
          },
          finish_reason: 'stop',
        },
      ],
    });
    return;
  }

  // The listing-based glossary passes want JSON, and a fake translation of the
  // prompt is not JSON — so without this the mock can exercise everything
  // except the flow that most needs walking end to end.
  const listed = [...content.matchAll(/^\d+\. (.+?)（/gm)].map((match) => match[1]);

  if (listed.length > 0 && content.includes('【待決定的詞】')) {
    console.log(`decide  ${listed.length} term(s)`);
    send(res, 200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              terms: listed.map((source) => ({ s: source, t: `譯${source}` })),
            }),
          },
          finish_reason: 'stop',
        },
      ],
    });
    return;
  }

  if (listed.length > 0 && content.includes('【要審的譯名】')) {
    // Every third one, so the reply exercises both halves of the pass: the
    // findings, and the terms it deliberately says nothing about.
    const issues = listed
      .filter((_, index) => index % 3 === 0)
      .map((source) => ({ s: source, t: `改${source}`, why: `${source} 在這張卡裡不是這個意思。` }));

    console.log(`review  ${issues.length} of ${listed.length}`);
    send(res, 200, {
      choices: [{ message: { content: JSON.stringify({ issues }) }, finish_reason: 'stop' }],
    });
    return;
  }

  console.log(`200  ${label}`);
  send(res, 200, {
    choices: [{ message: { content: fakeTranslation(content) }, finish_reason: 'stop' }],
  });
});

server.listen(PORT, () => {
  console.log(`mock endpoint on http://localhost:${PORT}/v1`);
  console.log('markers: FILTERME RATEME BOOMME DEADME SLOWME');
});
