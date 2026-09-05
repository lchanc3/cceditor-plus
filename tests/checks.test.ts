/**
 * Every case in the first describe block is taken verbatim from a real card
 * translated through this editor. They are the reason these checks exist.
 */

import { describe, expect, it } from 'vitest';

import { checkTranslation } from '../src/glossary';

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
    expect(kinds('<START>\na', '\na')).toEqual(['macro']);
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

  it('lists each offending character once', () => {
    const issue = checkTranslation('x', '这个这个', zhTW).find((i) => i.kind === 'script');
    expect(issue?.message).toContain('这、个');
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
