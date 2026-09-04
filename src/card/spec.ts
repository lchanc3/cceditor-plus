/**
 * Character card specification types.
 *
 * V1  https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md
 * V2  https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
 * V3  https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
 */

export type SpecVersion = 'v1' | 'v2' | 'v3';

/** Output flavours offered by the exporter. */
export type ExportSpec = SpecVersion | 'max';

export const SPEC_LABELS: Record<ExportSpec, string> = {
  v1: 'V1（最舊，僅 6 個欄位）',
  v2: 'V2（chara_card_v2）',
  v3: 'V3（chara_card_v3）',
  max: 'Max（V1+V2+V3 合併，相容性最高）',
};

// ---------------------------------------------------------------------------
// V1
// ---------------------------------------------------------------------------

export interface TavernCardV1 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
}

/**
 * Legacy TavernAI field names, still found on genuinely old cards. Mapped onto
 * the modern V1 names on import.
 */
export const V1_LEGACY_ALIASES: Record<string, keyof TavernCardV1> = {
  char_name: 'name',
  char_persona: 'description',
  world_scenario: 'scenario',
  char_greeting: 'first_mes',
  example_dialogue: 'mes_example',
};

export const V1_FIELDS: (keyof TavernCardV1)[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
];

// ---------------------------------------------------------------------------
// Lorebook (shared by V2 and V3; V3 adds use_regex and requires more fields)
// ---------------------------------------------------------------------------

export interface LorebookEntry {
  keys: string[];
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  /** V3 addition. */
  use_regex: boolean;
  case_sensitive?: boolean;
  constant?: boolean;
  name?: string;
  priority?: number;
  id?: number | string;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  position?: 'before_char' | 'after_char' | string;
  /** Anything the spec does not name is preserved verbatim. */
  [key: string]: unknown;
}

export interface Lorebook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, unknown>;
  entries: LorebookEntry[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// V2
// ---------------------------------------------------------------------------

export interface TavernCardV2Data {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: Lorebook;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TavernCardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: TavernCardV2Data;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// V3
// ---------------------------------------------------------------------------

export interface CardAsset {
  type: string;
  uri: string;
  name: string;
  ext: string;
}

export interface CharacterCardV3Data extends TavernCardV2Data {
  assets?: CardAsset[];
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  group_only_greetings: string[];
  creation_date?: number;
  modification_date?: number;
}

export interface CharacterCardV3 {
  spec: 'chara_card_v3';
  spec_version: '3.0';
  data: CharacterCardV3Data;
  [key: string]: unknown;
}

/**
 * The default asset every V3 card is supposed to carry when it has an avatar.
 * SPEC_V3: "if the array is empty, the application should treat it as
 * `[{type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png'}]`".
 */
export const DEFAULT_V3_ICON_ASSET: CardAsset = {
  type: 'icon',
  uri: 'ccdefault:',
  name: 'main',
  ext: 'png',
};

// ---------------------------------------------------------------------------
// PNG chunk keywords
// ---------------------------------------------------------------------------

/** V1/V2 payload. `character_card` is an alternate spelling seen in the wild. */
export const V2_CHUNK_KEYWORDS = ['chara', 'character_card'] as const;
/** V3 payload. Per SPEC_V3, when both are present `ccv3` MUST win. */
export const V3_CHUNK_KEYWORD = 'ccv3';

/** Every keyword we own and therefore rewrite on export. */
export const MANAGED_CHUNK_KEYWORDS = [...V2_CHUNK_KEYWORDS, V3_CHUNK_KEYWORD];
