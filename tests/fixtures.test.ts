/**
 * Runs every fixture on disk through parse + round-trip, including whatever the
 * user dropped into tests/fixtures/local (gitignored). Adding a card there is
 * the fastest way to check that this editor handles your own cards correctly.
 */

import { describe, expect, it } from 'vitest';

import { readCardBytes } from '../src/card/read';
import { buildCardJson, buildCardPng } from '../src/card/write';
import { ExportSpec } from '../src/card/spec';
import { discoverCardFixtures, LOCAL_FIXTURE_DIR } from './helpers';

const fixtures = discoverCardFixtures();
const encode = (text: string) => new TextEncoder().encode(text);

describe('fixture discovery', () => {
  it('found the committed fixtures', () => {
    expect(fixtures.filter((f) => !f.local).length).toBeGreaterThanOrEqual(8);
  });

  it('reports how many local cards are being tested', () => {
    const local = fixtures.filter((f) => f.local);
    // Not an assertion about count — local/ is empty in a fresh clone.
    console.log(
      local.length > 0
        ? `  ${local.length} local card(s) under test: ${local.map((f) => f.name).join(', ')}`
        : `  no local cards found. Drop your own cards into ${LOCAL_FIXTURE_DIR} to test them.`,
    );
    expect(Array.isArray(local)).toBe(true);
  });
});

describe.each(fixtures)('$name', (fixture) => {
  it('parses into a card with a name', async () => {
    const result = await readCardBytes(fixture.bytes, fixture.name);
    expect(result.model.fields.name, 'card parsed but has no name').toBeTruthy();
  });

  it('reports a plausible source spec', async () => {
    const result = await readCardBytes(fixture.bytes, fixture.name);
    expect(['v1', 'v2', 'v3']).toContain(result.model.sourceSpec);
  });

  it.each(['v2', 'v3', 'max'] as ExportSpec[])('survives a %s JSON round trip', async (spec) => {
    const source = await readCardBytes(fixture.bytes, fixture.name);
    const reloaded = await readCardBytes(encode(buildCardJson(source.model, spec)), 'out.json');

    expect(reloaded.model.fields.name).toBe(source.model.fields.name);
    expect(reloaded.model.fields.description).toBe(source.model.fields.description);
    expect(reloaded.model.fields.first_mes).toBe(source.model.fields.first_mes);
    expect(reloaded.model.fields.alternate_greetings).toEqual(
      source.model.fields.alternate_greetings,
    );
    expect(reloaded.model.fields.character_book).toEqual(source.model.fields.character_book);
  });

  it('re-exports byte-identically the second time (stable output)', async () => {
    const source = await readCardBytes(fixture.bytes, fixture.name);
    const first = buildCardJson(source.model, 'max');
    const reloaded = await readCardBytes(encode(first), 'out.json');
    expect(buildCardJson(reloaded.model, 'max')).toBe(first);
  });

  it('survives a PNG round trip when it carries an image', async () => {
    const source = await readCardBytes(fixture.bytes, fixture.name);
    if (!source.imageBytes) return; // JSON fixture, nothing to embed into

    const png = buildCardPng(source.model, source.imageBytes);
    const reloaded = await readCardBytes(png);
    expect(reloaded.model.fields.name).toBe(source.model.fields.name);
    expect(reloaded.model.fields.character_book).toEqual(source.model.fields.character_book);
  });
});
