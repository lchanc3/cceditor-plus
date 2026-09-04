/**
 * The tests that matter most: save a card, load it back, and check nothing moved.
 *
 * The previous editor failed this outright — it exported `{ data: card }` with
 * no `spec`, and its JSON importer read the root instead of `data`, so every
 * field came back undefined.
 */

import { describe, expect, it } from 'vitest';

import { CardModel, normalizeCard } from '../src/card/model';
import { readCardBytes } from '../src/card/read';
import { buildCardJson, buildCardPng } from '../src/card/write';
import { ExportSpec } from '../src/card/spec';
import { fixtureBytes, fixtureJson } from './helpers';

const encode = (text: string) => new TextEncoder().encode(text);

async function reimportJson(model: CardModel, spec: ExportSpec): Promise<CardModel> {
  const result = await readCardBytes(encode(buildCardJson(model, spec)), 'exported.json');
  return result.model;
}

/** Apply the kind of edits the UI makes, so we test a changed card, not a copy. */
function edit(model: CardModel): CardModel {
  return {
    ...model,
    fields: {
      ...model.fields,
      name: '編輯後的名字 ✦',
      description: '這是翻譯後的描述，保留 {{char}} 與 {{user}} 巨集。',
      alternate_greetings: [...model.fields.alternate_greetings, '新增的開場白'],
      tags: [...model.fields.tags, '新標籤'],
    },
  };
}

describe('JSON round trip', () => {
  const specs: ExportSpec[] = ['v1', 'v2', 'v3', 'max'];

  it.each(specs)('preserves the V1 core fields through a %s export', async (spec) => {
    const original = edit(normalizeCard(fixtureJson('v3-full.json')));
    const reloaded = await reimportJson(original, spec);

    // The exact failure mode of the old build: these came back undefined.
    expect(reloaded.fields.name).toBe(original.fields.name);
    expect(reloaded.fields.description).toBe(original.fields.description);
    expect(reloaded.fields.personality).toBe(original.fields.personality);
    expect(reloaded.fields.scenario).toBe(original.fields.scenario);
    expect(reloaded.fields.first_mes).toBe(original.fields.first_mes);
    expect(reloaded.fields.mes_example).toBe(original.fields.mes_example);
  });

  it.each(['v2', 'v3', 'max'] as ExportSpec[])('preserves V2 fields through a %s export', async (spec) => {
    const original = edit(normalizeCard(fixtureJson('v3-full.json')));
    const reloaded = await reimportJson(original, spec);

    expect(reloaded.fields.alternate_greetings).toEqual(original.fields.alternate_greetings);
    expect(reloaded.fields.tags).toEqual(original.fields.tags);
    expect(reloaded.fields.creator).toBe(original.fields.creator);
    expect(reloaded.fields.character_version).toBe(original.fields.character_version);
    expect(reloaded.fields.creator_notes).toBe(original.fields.creator_notes);
    expect(reloaded.fields.system_prompt).toBe(original.fields.system_prompt);
    expect(reloaded.fields.extensions).toEqual(original.fields.extensions);
    expect(reloaded.fields.character_book).toEqual(original.fields.character_book);
  });

  it.each(['v3', 'max'] as ExportSpec[])('preserves V3-only fields through a %s export', async (spec) => {
    const original = normalizeCard(fixtureJson('v3-full.json'));
    const reloaded = await reimportJson(original, spec);

    expect(reloaded.fields.nickname).toBe(original.fields.nickname);
    expect(reloaded.fields.assets).toEqual(original.fields.assets);
    expect(reloaded.fields.source).toEqual(original.fields.source);
    expect(reloaded.fields.group_only_greetings).toEqual(original.fields.group_only_greetings);
    expect(reloaded.fields.creator_notes_multilingual).toEqual(
      original.fields.creator_notes_multilingual,
    );
    expect(reloaded.fields.creation_date).toBe(original.fields.creation_date);
  });

  it.each(['v2', 'v3', 'max'] as ExportSpec[])('preserves unmodelled fields through a %s export', async (spec) => {
    const original = normalizeCard(fixtureJson('v3-full.json'));
    const reloaded = await reimportJson(original, spec);
    expect(reloaded.extraData.risu_extra).toEqual(original.extraData.risu_extra);
  });

  it('is idempotent — exporting twice yields identical bytes', async () => {
    const original = normalizeCard(fixtureJson('v3-full.json'));
    const first = buildCardJson(original, 'max');
    const second = buildCardJson(await reimportJson(original, 'max'), 'max');
    expect(second).toBe(first);
  });

  it('survives five consecutive save/load cycles unchanged', async () => {
    let model = edit(normalizeCard(fixtureJson('v3-full.json')));
    const snapshot = buildCardJson(model, 'max');
    for (let i = 0; i < 5; i++) model = await reimportJson(model, 'max');
    expect(buildCardJson(model, 'max')).toBe(snapshot);
  });

  it('round-trips a V1 card without inventing content', async () => {
    const original = normalizeCard(fixtureJson('v1-basic.json'));
    const reloaded = await reimportJson(original, 'v1');
    expect(reloaded.fields.name).toBe(original.fields.name);
    expect(reloaded.fields.alternate_greetings).toEqual([]);
  });
});

describe('PNG round trip', () => {
  it('reads back the card it just wrote', async () => {
    const source = await readCardBytes(fixtureBytes('v2-chara.png'));
    const edited = edit(source.model);
    const png = buildCardPng(edited, source.imageBytes!);

    const reloaded = await readCardBytes(png);
    expect(reloaded.model.fields.name).toBe(edited.fields.name);
    expect(reloaded.model.fields.character_book).toEqual(edited.fields.character_book);
  });

  it('writes both chunks, and the reader picks ccv3', async () => {
    const source = await readCardBytes(fixtureBytes('v2-chara.png'));
    const reloaded = await readCardBytes(buildCardPng(source.model, source.imageBytes!));
    expect(reloaded.origin).toBe('ccv3');
    expect(reloaded.model.sourceSpec).toBe('v3');
  });

  it('leaves a V2-only reader with correct data in the chara chunk', async () => {
    const { parseChunks, readTextChunks, findTextChunk } = await import('../src/card/png');
    const { base64ToUtf8 } = await import('../src/card/binary');

    const source = await readCardBytes(fixtureBytes('v2-chara.png'));
    const edited = edit(source.model);
    const png = buildCardPng(edited, source.imageBytes!);

    const chara = findTextChunk(await readTextChunks(parseChunks(png)), 'chara');
    const parsed = JSON.parse(base64ToUtf8(chara!.text));
    expect(parsed.spec).toBe('chara_card_v2');
    expect(parsed.data.name).toBe(edited.fields.name);
  });

  it('survives repeated PNG saves without accumulating chunks', async () => {
    const { parseChunks } = await import('../src/card/png');
    const source = await readCardBytes(fixtureBytes('v2v3-dual-chunk.png'));

    let png = source.imageBytes!;
    for (let i = 0; i < 4; i++) {
      const loaded = await readCardBytes(png);
      png = buildCardPng(loaded.model, loaded.imageBytes!);
    }

    const textChunks = parseChunks(png).filter((c) => c.type === 'tEXt');
    expect(textChunks).toHaveLength(2); // exactly one chara + one ccv3
  });

  it('does not corrupt the image on repeated saves', async () => {
    const { parseChunks } = await import('../src/card/png');
    const idat = (bytes: Uint8Array) =>
      parseChunks(bytes)
        .filter((c) => c.type === 'IDAT')
        .map((c) => c.data);

    const source = await readCardBytes(fixtureBytes('v3-ccv3.png'));
    const once = buildCardPng(source.model, source.imageBytes!);
    const twice = buildCardPng((await readCardBytes(once)).model, once);
    expect(idat(twice)).toEqual(idat(source.imageBytes!));
  });
});

describe('cross-format round trip', () => {
  it('carries a PNG card into JSON and back with no loss', async () => {
    const fromPng = await readCardBytes(fixtureBytes('v3-ccv3.png'));
    const asJson = await readCardBytes(encode(buildCardJson(fromPng.model, 'max')), 'x.json');
    expect(asJson.model.fields).toEqual(fromPng.model.fields);
    expect(asJson.model.extraData).toEqual(fromPng.model.extraData);
  });

  it('carries a JSON card into PNG and back with no loss', async () => {
    const fromJson = normalizeCard(fixtureJson('v3-full.json'));
    const png = buildCardPng(fromJson, fixtureBytes('no-card-data.png'));
    const reloaded = await readCardBytes(png);
    expect(reloaded.model.fields).toEqual(fromJson.fields);
  });
});
