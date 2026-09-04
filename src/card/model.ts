/**
 * The lossless internal representation, plus normalisation (any spec -> model)
 * and serialisation (model -> any spec).
 *
 * The old code did `const finalData = data.data || data`, which threw away the
 * spec wrapper and every field it did not explicitly model. Anything a card
 * carried that this editor has no UI for — RisuAI extensions, Chub metadata,
 * future spec additions — was silently dropped on export. `extraRoot` and
 * `extraData` exist so that never happens.
 */

import {
  CardAsset,
  CharacterCardV3,
  ExportSpec,
  Lorebook,
  LorebookEntry,
  SpecVersion,
  TavernCardV1,
  TavernCardV2,
  V1_FIELDS,
  V1_LEGACY_ALIASES,
} from './spec';

export interface CardFields {
  // V1
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  // V2
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  character_book?: Lorebook;
  // V3
  assets?: CardAsset[];
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  group_only_greetings: string[];
  creation_date?: number;
  modification_date?: number;
}

export interface CardModel {
  /** Which spec the card was read as. Informational once imported. */
  sourceSpec: SpecVersion;
  fields: CardFields;
  /** Root-level keys we do not model (V2/V3 only), preserved verbatim. */
  extraRoot: Record<string, unknown>;
  /** `data`-level keys we do not model, preserved verbatim. */
  extraData: Record<string, unknown>;
}

/** Every key read into `fields`; anything else lands in `extraData`. */
const KNOWN_DATA_KEYS = new Set<string>([
  ...V1_FIELDS,
  ...Object.keys(V1_LEGACY_ALIASES),
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
  'extensions',
  'character_book',
  'assets',
  'nickname',
  'creator_notes_multilingual',
  'source',
  'group_only_greetings',
  'creation_date',
  'modification_date',
]);

/**
 * Root keys never copied into `extraRoot`. `spec`, `spec_version` and `data`
 * are regenerated; the rest are the flat V1 mirror SillyTavern writes alongside
 * `data`, which we regenerate too — keeping the originals would let a stale
 * copy of an edited field survive into the export.
 */
const REGENERATED_ROOT_KEYS = new Set<string>([
  'spec',
  'spec_version',
  'data',
  ...V1_FIELDS,
  ...Object.keys(V1_LEGACY_ALIASES),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => v != null).map(asString) : [];

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? { ...value } : {});

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

export function deepClone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** Drop keys whose value is `undefined`, so they do not survive as explicit nulls. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectSpec(raw: unknown): SpecVersion {
  if (!isRecord(raw)) return 'v1';
  const spec = asString(raw.spec).toLowerCase();
  if (spec === 'chara_card_v3') return 'v3';
  if (spec === 'chara_card_v2') return 'v2';
  // Some exporters omit `spec` but still nest under `data`. Treat that as V2,
  // upgraded to V3 when a V3-only field is present.
  if (isRecord(raw.data)) {
    const data = raw.data;
    const hasV3Field =
      'assets' in data ||
      'nickname' in data ||
      'group_only_greetings' in data ||
      'creator_notes_multilingual' in data ||
      'source' in data;
    return hasV3Field ? 'v3' : 'v2';
  }
  return 'v1';
}

// ---------------------------------------------------------------------------
// Lorebook
// ---------------------------------------------------------------------------

function normalizeLorebookEntry(raw: unknown, index: number): LorebookEntry {
  const source = isRecord(raw) ? raw : {};
  return {
    // Spread first so unknown keys survive, then overwrite with normalised ones.
    ...source,
    keys: asStringArray(source.keys),
    content: asString(source.content),
    extensions: asRecord(source.extensions),
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    insertion_order: asNumber(source.insertion_order) ?? index,
    use_regex: typeof source.use_regex === 'boolean' ? source.use_regex : false,
    ...(Array.isArray(source.secondary_keys)
      ? { secondary_keys: asStringArray(source.secondary_keys) }
      : {}),
  };
}

function normalizeLorebook(raw: unknown): Lorebook | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Array.isArray(raw.entries) ? raw.entries.map(normalizeLorebookEntry) : [];
  return { ...raw, entries, extensions: asRecord(raw.extensions) };
}

/** A book with no name and no entries is noise; CCEditor strips it on export too. */
function isEmptyLorebook(book: Lorebook | undefined): boolean {
  return !book || (!book.name && book.entries.length === 0);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalizeCard(raw: unknown): CardModel {
  const root = isRecord(raw) ? raw : {};
  const sourceSpec = detectSpec(root);
  // V2/V3 keep the character under `data`; V1 is the root object itself.
  const data = isRecord(root.data) ? root.data : root;

  // Prefer `data`, fall back to the root, then to the legacy TavernAI alias.
  // Real cards are inconsistent about which of the three they populate.
  const pick = (key: string): unknown => {
    if (data[key] !== undefined) return data[key];
    if (root[key] !== undefined) return root[key];
    for (const [alias, target] of Object.entries(V1_LEGACY_ALIASES)) {
      if (target !== key) continue;
      if (data[alias] !== undefined) return data[alias];
      if (root[alias] !== undefined) return root[alias];
    }
    return undefined;
  };

  const book = normalizeLorebook(pick('character_book'));
  const assets = pick('assets');
  const multilingual = pick('creator_notes_multilingual');
  const nickname = pick('nickname');
  const source = pick('source');
  const creationDate = asNumber(pick('creation_date'));
  const modificationDate = asNumber(pick('modification_date'));

  const fields: CardFields = {
    name: asString(pick('name')),
    description: asString(pick('description')),
    personality: asString(pick('personality')),
    scenario: asString(pick('scenario')),
    first_mes: asString(pick('first_mes')),
    mes_example: asString(pick('mes_example')),
    creator_notes: asString(pick('creator_notes')),
    system_prompt: asString(pick('system_prompt')),
    post_history_instructions: asString(pick('post_history_instructions')),
    alternate_greetings: asStringArray(pick('alternate_greetings')),
    tags: asStringArray(pick('tags')),
    creator: asString(pick('creator')),
    character_version: asString(pick('character_version')),
    extensions: asRecord(pick('extensions')),
    group_only_greetings: asStringArray(pick('group_only_greetings')),
    ...(book ? { character_book: book } : {}),
    ...(Array.isArray(assets) ? { assets: deepClone(assets) as CardAsset[] } : {}),
    ...(nickname !== undefined ? { nickname: asString(nickname) } : {}),
    ...(isRecord(multilingual)
      ? { creator_notes_multilingual: asRecord(multilingual) as Record<string, string> }
      : {}),
    ...(Array.isArray(source) ? { source: asStringArray(source) } : {}),
    ...(creationDate !== undefined ? { creation_date: creationDate } : {}),
    ...(modificationDate !== undefined ? { modification_date: modificationDate } : {}),
  };

  const extraData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_DATA_KEYS.has(key)) extraData[key] = deepClone(value);
  }

  const extraRoot: Record<string, unknown> = {};
  if (data !== root) {
    for (const [key, value] of Object.entries(root)) {
      if (!REGENERATED_ROOT_KEYS.has(key)) extraRoot[key] = deepClone(value);
    }
  }

  return { sourceSpec, fields, extraRoot, extraData };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

function v1Body(fields: CardFields): TavernCardV1 {
  return {
    name: fields.name,
    description: fields.description,
    personality: fields.personality,
    scenario: fields.scenario,
    first_mes: fields.first_mes,
    mes_example: fields.mes_example,
  };
}

/**
 * Required V2/V3 fields are always emitted, with empty defaults when unset. The
 * specs mark them required, and importers (SillyTavern included) cope far better
 * with an empty string than with an absent key.
 */
function v2Data(model: CardModel): TavernCardV2['data'] {
  const { fields } = model;
  return compact({
    ...model.extraData,
    ...v1Body(fields),
    creator_notes: fields.creator_notes,
    system_prompt: fields.system_prompt,
    post_history_instructions: fields.post_history_instructions,
    alternate_greetings: fields.alternate_greetings,
    tags: fields.tags,
    creator: fields.creator,
    character_version: fields.character_version,
    extensions: fields.extensions,
    character_book: isEmptyLorebook(fields.character_book) ? undefined : fields.character_book,
  }) as TavernCardV2['data'];
}

function v3Data(model: CardModel): CharacterCardV3['data'] {
  const { fields } = model;
  return compact({
    ...v2Data(model),
    group_only_greetings: fields.group_only_greetings,
    assets: fields.assets,
    nickname: fields.nickname,
    creator_notes_multilingual: fields.creator_notes_multilingual,
    source: fields.source,
    creation_date: fields.creation_date,
    modification_date: fields.modification_date,
  }) as CharacterCardV3['data'];
}

export function toSpecV1(model: CardModel): TavernCardV1 {
  return deepClone(v1Body(model.fields));
}

export function toSpecV2(model: CardModel): TavernCardV2 {
  return deepClone({
    ...model.extraRoot,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: v2Data(model),
  } as TavernCardV2);
}

export function toSpecV3(model: CardModel): CharacterCardV3 {
  return deepClone({
    ...model.extraRoot,
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: v3Data(model),
  } as CharacterCardV3);
}

/**
 * "Max compatible": one object that a V1, a V2 and a V3 reader can all consume.
 *
 * Mirrors `toMaxCompatibleSpec()` in @lenml/char-card-reader, which is
 * `mergeObjects(toSpecV1(), toSpecV2(), toSpecV3())`. Because our V3 data is a
 * strict superset of our V2 data, that merge reduces to "the flat V1 fields at
 * the root, plus the V3 envelope". A V1-only reader finds what it needs at the
 * root; anything newer sees `spec` and reads `data`.
 */
export function toMaxCompatible(model: CardModel): Record<string, unknown> {
  return deepClone({
    ...model.extraRoot,
    ...v1Body(model.fields),
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: v3Data(model),
  });
}

export function serializeCard(model: CardModel, spec: ExportSpec): Record<string, unknown> {
  switch (spec) {
    case 'v1':
      return toSpecV1(model) as unknown as Record<string, unknown>;
    case 'v2':
      return toSpecV2(model) as unknown as Record<string, unknown>;
    case 'v3':
      return toSpecV3(model) as unknown as Record<string, unknown>;
    case 'max':
      return toMaxCompatible(model);
  }
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

export function createEmptyCard(): CardModel {
  return {
    sourceSpec: 'v3',
    fields: {
      name: '',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
      group_only_greetings: [],
    },
    extraRoot: {},
    extraData: {},
  };
}

export function createEmptyLorebookEntry(index: number): LorebookEntry {
  return {
    keys: [],
    content: '',
    extensions: {},
    enabled: true,
    insertion_order: index,
    use_regex: false,
  };
}
