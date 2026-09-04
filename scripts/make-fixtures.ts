/**
 * Generates the committed test fixtures.
 *
 * These are real files, not stubs: genuine PNGs with genuine `chara` / `ccv3`
 * tEXt chunks, and JSON in each spec's exact envelope. Content is deliberately
 * awkward — CJK, emoji, {{char}}/{{user}} macros, a lorebook, nested extensions
 * and fields no spec defines — so the round-trip tests have something to lose.
 *
 * Run with: npm run fixtures
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { concatBytes, crc32, latin1Encode, uint32BE, utf8Encode, utf8ToBase64 } from '../src/card/binary';
import { PNG_SIGNATURE } from '../src/card/png';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (enough for a fixture image; no dependencies)
// ---------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = latin1Encode(type);
  return concatBytes(
    uint32BE(data.length),
    typeBytes,
    data,
    uint32BE(crc32(concatBytes(typeBytes, data))),
  );
}

/** A tiny RGB gradient, so the fixture PNGs are real decodable images. */
function makePng(width = 32, height = 48): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set(uint32BE(width), 0);
  ihdr.set(uint32BE(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // 10..12 = compression / filter / interlace, all 0

  const raw = new Uint8Array(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 255) / width;
      raw[p++] = (y * 255) / height;
      raw[p++] = 0x37;
    }
  }

  return concatBytes(
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  );
}

function pngWithText(entries: { keyword: string; text: string }[]): Uint8Array {
  const base = makePng();
  // Re-emit with the text chunks slotted in right after IHDR (offset 8 + 25).
  const ihdrEnd = 8 + 25;
  const textChunks = entries.map((e) =>
    // Keyword is always ASCII. The text is written as UTF-8, which is what
    // tools that embed raw JSON actually do (the spec would say Latin-1, but
    // Latin-1 cannot represent CJK at all).
    chunk('tEXt', concatBytes(latin1Encode(e.keyword), new Uint8Array([0]), utf8Encode(e.text))),
  );
  return concatBytes(base.subarray(0, ihdrEnd), ...textChunks, base.subarray(ihdrEnd));
}

// ---------------------------------------------------------------------------
// Card content
// ---------------------------------------------------------------------------

const lorebook = {
  name: '星穹世界書',
  description: '關於這個世界的設定',
  scan_depth: 4,
  token_budget: 512,
  recursive_scanning: false,
  extensions: { risu_customArgs: { depth: 2 } },
  entries: [
    {
      keys: ['星穹', 'starlight'],
      secondary_keys: ['夜空'],
      content: '{{char}} 出生於星穹之城，那裡的夜空永遠燃燒著藍色的火焰。',
      comment: '世界觀核心',
      constant: false,
      selective: true,
      insertion_order: 10,
      enabled: true,
      position: 'before_char',
      use_regex: false,
      case_sensitive: false,
      id: 1,
      extensions: { depth: 4, probability: 100 },
    },
    {
      keys: ['劍', 'sword'],
      content: '她的佩劍名為「霜語」，只有在 {{user}} 面前才會出鞘。',
      insertion_order: 20,
      enabled: true,
      use_regex: false,
      extensions: {},
      // A key no spec defines — must survive the round trip.
      risu_hidden_note: 'keep me',
    },
  ],
};

const v1Card = {
  name: '莉茲貝特 · 星語者 🌟',
  description: '{{char}} 是一位來自星穹之城的占星師，說話時總帶著一絲慵懶。',
  personality: '慵懶、聰慧、對 {{user}} 格外溫柔',
  scenario: '在一座漂浮於雲海之上的天文台裡，{{char}} 與 {{user}} 初次相遇。',
  first_mes: '「哦？這麼晚還有訪客……」她放下手中的星盤，抬眼看向 {{user}}。',
  mes_example: '<START>\n{{user}}: 你在看什麼？\n{{char}}: 「在看你什麼時候才願意抬頭。」',
};

/** Genuinely old TavernAI cards use these names instead. */
const v1LegacyCard = {
  char_name: '古老的旅人',
  char_persona: '一位沉默寡言的旅行者。',
  personality: '沉默',
  world_scenario: '荒野的岔路口。',
  char_greeting: '「……」他只是點了點頭。',
  example_dialogue: '<START>\n{{user}}: 你好\n{{char}}: 「嗯。」',
};

const v2Data = {
  ...v1Card,
  creator_notes: '請保留 {{char}} 與 {{user}} 標籤。',
  system_prompt: '你正在扮演 {{char}}。',
  post_history_instructions: '保持角色語氣。',
  alternate_greetings: [
    '「又是你啊。」她笑了笑，沒有回頭。',
    '「今晚的星象……有點不太對勁。」',
  ],
  character_book: lorebook,
  tags: ['fantasy', '占星', 'female'],
  creator: 'test-fixture',
  character_version: '1.2.0',
  extensions: {
    talkativeness: '0.5',
    fav: false,
    depth_prompt: { prompt: '記得她討厭甜食。', depth: 4, role: 'system' },
  },
};

const v3Data = {
  ...v2Data,
  assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
  nickname: '莉茲',
  creator_notes_multilingual: { en: 'Keep the {{char}} macros.', 'zh-TW': '請保留巨集。' },
  source: ['https://example.invalid/cards/lisbeth'],
  group_only_greetings: ['「兩位一起來？真難得。」'],
  creation_date: 1700000000,
  modification_date: 1700009999,
  // Unmodelled data-level key — must survive the round trip.
  risu_extra: { emotion_pack: 'lisbeth-v1' },
};

const v2Card = { spec: 'chara_card_v2', spec_version: '2.0', data: v2Data };
const v3Card = { spec: 'chara_card_v3', spec_version: '3.0', data: v3Data };

/** What SillyTavern actually writes: the V2 envelope plus a flat V1 mirror. */
const v2CardWithRootMirror = {
  ...v1Card,
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: v2Data,
  avatar: 'none',
  create_date: '2024-1-1 @00h 00m 00s 000ms',
  talkativeness: '0.5',
  fav: false,
};

// ---------------------------------------------------------------------------

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2), 'utf-8');
  console.log('  ' + name);
}

function writePng(name: string, entries: { keyword: string; text: string }[]): void {
  writeFileSync(join(OUT, name), pngWithText(entries));
  console.log('  ' + name);
}

mkdirSync(OUT, { recursive: true });
console.log('writing fixtures to tests/fixtures');

writeJson('v1-basic.json', v1Card);
writeJson('v1-legacy-tavernai.json', v1LegacyCard);
writeJson('v2-full.json', v2Card);
writeJson('v3-full.json', v3Card);
writeJson('v2-with-root-mirror.json', v2CardWithRootMirror);

writePng('v2-chara.png', [{ keyword: 'chara', text: utf8ToBase64(JSON.stringify(v2Card)) }]);
writePng('v3-ccv3.png', [{ keyword: 'ccv3', text: utf8ToBase64(JSON.stringify(v3Card)) }]);
// Both chunks present: ccv3 must win, and the V2 chunk here is deliberately
// stale so a reader that picks the wrong one fails the test loudly.
writePng('v2v3-dual-chunk.png', [
  {
    keyword: 'chara',
    text: utf8ToBase64(JSON.stringify({ ...v2Card, data: { ...v2Data, name: 'STALE V2 NAME' } })),
  },
  { keyword: 'ccv3', text: utf8ToBase64(JSON.stringify(v3Card)) },
]);
// Raw (non-base64) JSON in the chunk — off-spec, but tools do it.
writePng('v2-chara-raw-json.png', [{ keyword: 'chara', text: JSON.stringify(v2Card) }]);
// A plain image with no card data at all, for the error path.
writeFileSync(join(OUT, 'no-card-data.png'), makePng());
console.log('  no-card-data.png');

console.log('done');
