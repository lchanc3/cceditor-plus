/**
 * Every case in the first describe block is taken verbatim from a real card
 * translated through this editor. They are the reason these checks exist.
 */

import { describe, expect, it } from 'vitest';

import { checkTranslation, simplifiedTable } from '../src/glossary';

const zhTW = { targetLang: '繁體中文' };
const kinds = (source: string, translated: string, options = zhTW) =>
  checkTranslation(source, translated, options).map((issue) => issue.kind);

describe('what a real translated card actually contained', () => {
  it('catches the translator note the model wrote into the description', () => {
    const source = 'Hardworking and talented, she meticulously prepares for roles.';
    const translated =
      '她努力且有天分，為角色做了 meticuloso（ meticuloso 應為 meticulous 的筆誤，此處譯為「一絲不苟」）的準備。';

    const issues = checkTranslation(source, translated, zhTW);
    const note = issues.find((issue) => issue.kind === 'note');
    expect(note).toBeDefined();
    expect(note?.excerpt).toContain('應為');
  });

  it('catches the simplified character that leaked into the dialogue examples', () => {
    const source = 'She pulls out a small bento box.';
    const translated = '她伸手進包包裡拿出一个小便當盒。';

    const issue = checkTranslation(source, translated, zhTW).find((i) => i.kind === 'script');
    expect(issue?.message).toContain('个');
    expect(issue?.excerpt).toContain('小便當盒');
  });

  it('catches the extra {{user}} the model invented', () => {
    // Four in the source, five in the translation: the model replaced a pronoun
    // with a macro on its own initiative.
    const source = 'She noticed {{user}}. {{user}} became her confidant. Rely on {{user}}. Admiring {{user}} talent.';
    const translated =
      '她注意到了 {{user}}。因為茜向 {{user}} 吐露了掙扎。{{user}} 成為了她的知己。依賴 {{user}}。欣賞著 {{user}} 的天分。';

    const issue = checkTranslation(source, translated, zhTW).find((i) => i.kind === 'macro');
    expect(issue?.message).toContain('{{user}}');
    expect(issue?.message).toContain('多加了');
  });

  it('passes the parts of that card that were fine', () => {
    // Macros and paragraph structure held throughout mes_example.
    const source = '{{user}}: You are a genius.\n{{char}}: *She wipes a tear.*\n— Really?';
    const translated = '{{user}}: 你是個天才。\n{{char}}: *她拭去一滴淚。*\n— 真的嗎？';
    expect(checkTranslation(source, translated, zhTW)).toEqual([]);
  });
});

describe('macro checks', () => {
  it('reports a macro that vanished', () => {
    const issue = checkTranslation('Hello {{char}}!', '哈囉！', zhTW)[0];
    expect(issue.kind).toBe('macro');
    expect(issue.message).toContain('消失');
  });

  it('counts each macro separately', () => {
    expect(kinds('{{char}} {{user}}', '{{char}} {{char}}')).toEqual(['macro', 'macro']);
  });

  it('watches <START> as well', () => {
    // Same line count either side, so only the macro check should fire.
    expect(kinds('<START>\na', '開始\na')).toEqual(['macro']);
  });

  it('ignores case, the way the engine does', () => {
    expect(checkTranslation('{{Char}} said', '{{char}} 說', zhTW)).toEqual([]);
  });

  it('is not fooled by braces that are not macros', () => {
    expect(checkTranslation('a { b } c', 'a { b } c', zhTW)).toEqual([]);
  });
});

describe('structure check', () => {
  it('reports a changed paragraph count', () => {
    expect(kinds('a\nb\nc', '甲\n乙')).toEqual(['structure']);
  });

  it('ignores a trailing newline the output trim removed', () => {
    // `cleanOutput` strips surrounding whitespace from every translation, so
    // without this a source ending in a newline flagged every single section —
    // seventeen of eighteen lorebook entries on a real card, all spurious.
    expect(checkTranslation('a\nb\n', '甲\n乙', zhTW)).toEqual([]);
    expect(checkTranslation('\n\na\nb\n\n', '甲\n乙', zhTW)).toEqual([]);
  });

  it('still reports paragraphs that were actually merged', () => {
    expect(kinds('a\n\nb\n\nc', '甲 乙 丙')).toEqual(['structure']);
  });

  it('treats CRLF as one break, since SillyTavern rewrites line endings', () => {
    // A card that has been through SillyTavern comes back with CRLF throughout;
    // that is not a structural change.
    expect(checkTranslation('a\nb', '甲\r\n乙', zhTW)).toEqual([]);
  });
});

describe('script check', () => {
  it('only applies when traditional Chinese was asked for', () => {
    expect(kinds('x', '这个', { targetLang: '简体中文' })).toEqual([]);
    expect(kinds('x', '这个', { targetLang: '繁體中文' })).toEqual(['script']);
    expect(kinds('x', '这个', { targetLang: 'English' })).toEqual([]);
  });

  it.each(['繁體中文', '繁体中文', 'zh-TW', 'zh-Hant'])('recognises %s', (targetLang) => {
    expect(kinds('x', '这个', { targetLang })).toEqual(['script']);
  });

  it('says nothing about a clean traditional translation', () => {
    expect(checkTranslation('The elder spoke.', '長老開口了。她說：「來吧。」', zhTW)).toEqual([]);
  });

  it('names the form that was wanted', () => {
    const issue = checkTranslation('x', '这个', zhTW).find((i) => i.kind === 'script');
    expect(issue?.message).toContain('这（應為 這）');
    expect(issue?.message).toContain('个（應為 個）');
  });

  it('lists each offending character once', () => {
    const issue = checkTranslation('x', '这个这个', zhTW).find((i) => i.kind === 'script');
    expect(issue?.message.match(/这/g)).toHaveLength(1);
  });

  it('covers the systematic radical families', () => {
    // These are where simplified characters actually come from, so a gap here
    // matters far more than a gap in the long tail.
    for (const text of ['说话', '钱银', '红线', '财货', '转轮', '问间', '骑马', '鸡鸭', '鱼鲜', '观见', '页顶', '风飘', '饭饮', '围韩', '龙笼', '齐剂']) {
      expect(kinds('x', text)).toContain('script');
    }
  });
});

describe('the simplified table itself', () => {
  const table = simplifiedTable();

  it('never lists a character that is valid traditional Chinese', () => {
    // A false alarm on 皇后 or 公里 would teach the reader to ignore the check,
    // which costs more than missing a rare character ever could.
    for (const [text, why] of [
      ['皇后與太后', '后'],
      ['台北', '台'],
      ['公里', '里'],
      ['只有一個', '只'],
      ['天干地支', '干'],
      ['面對面', '面'],
      ['表面', '表'],
      ['系統', '系'],
      ['制度', '制'],
      ['划船', '划'],
      ['松樹', '松'],
      ['山谷', '谷'],
      ['丑時', '丑'],
      ['北斗', '斗'],
      ['茶几', '几'],
      ['占卜', '卜'],
      ['詩云', '云'],
      ['宿舍', '舍'],
      ['借用', '借'],
      ['折斷', '折'],
      ['布匹', '布'],
      ['風采', '采'],
      ['志向', '志'],
      ['克服', '克'],
      ['困難', '困'],
      ['御用', '御'],
      ['秋天', '秋'],
    ] as const) {
      expect(table.has(why)).toBe(false);
      expect(checkTranslation('x', text, zhTW)).toEqual([]);
    }
  });

  it('maps every entry to a different character', () => {
    for (const [simplified, traditional] of table) {
      expect(simplified).not.toBe(traditional);
      expect(simplified).toHaveLength(1);
      expect(traditional).toHaveLength(1);
    }
  });

  it('never treats a traditional form as simplified as well', () => {
    // Otherwise a correct translation would be flagged for the very character
    // the table says to use.
    for (const traditional of table.values()) {
      expect(table.has(traditional)).toBe(false);
    }
  });

  it('is large enough to be worth calling a table', () => {
    expect(table.size).toBeGreaterThan(500);
  });
});

describe('translator note check', () => {
  it('leaves a note the author wrote alone', () => {
    // The pattern appears in the source too, so it is the card's own text.
    const source = '（原文為古語）The elder spoke.';
    const translated = '（原文為古語）長老開口了。';
    expect(kinds(source, translated)).toEqual([]);
  });

  it('reports at most one note per section', () => {
    const translated = '甲（應為乙）丙（此處譯為丁）';
    expect(kinds('a b', translated).filter((k) => k === 'note')).toHaveLength(1);
  });

  it('ignores ordinary parentheses', () => {
    expect(checkTranslation('Akane (18) smiled.', '茜（18 歲）笑了。', zhTW)).toEqual([]);
  });
});

describe('edge cases', () => {
  it('says nothing about an empty translation', () => {
    expect(checkTranslation('{{char}} hello', '', zhTW)).toEqual([]);
  });

  it('needs no target language', () => {
    expect(checkTranslation('{{char}}', '{{char}}')).toEqual([]);
  });
});
