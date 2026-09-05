/**
 * Deterministic checks on a finished translation.
 *
 * Every one of these ran against a real translated card and caught something a
 * person would otherwise have shipped: a macro the model invented, a simplified
 * character in a 繁體中文 translation, and a translator's note written into the
 * character's description.
 *
 * They share the timing constraint with `unappliedTerms`: answering any of them
 * needs the source and the translation side by side, and translating in place
 * destroys the source. So they run as a translation lands, never afterwards.
 *
 * All of them report rather than repair. Rewriting finished prose to satisfy a
 * heuristic is how a translation acquires a broken sentence.
 */

export type IssueKind = 'macro' | 'structure' | 'script' | 'note';

export interface TranslationIssue {
  kind: IssueKind;
  message: string;
  /** A short excerpt of the offending text, where there is one to show. */
  excerpt?: string;
}

/**
 * Anything the engine substitutes at runtime, which a translation must carry
 * through unchanged and in the same number.
 */
const MACRO = /\{\{[^{}\n]{1,40}\}\}|<START>/gi;

/**
 * A sampling of characters that exist only in the simplified set, weighted
 * towards the ones that actually turn up in machine translation. Not a
 * conversion table — a leak detector. Missing a character costs nothing;
 * listing one that is valid traditional would cost a false alarm, so anything
 * shared by both scripts is deliberately absent.
 */
const SIMPLIFIED_ONLY =
  '个们这来过时现发后会说对应当种样还让实进国东车马鸟龙点热爱见觉学写词语关门问间无书长风飞产业务严' +
  '与为义乐习乡亚亲从仅仓传伟伤体众优儿兰兴军农净划动劳势医卖单卫参双变号叶吗员响启声备复头夺奋' +
  '妆娱婴孙宁宝宠审层岁岛币师帮带帐广庆库归录彻忆忧怀态总恋恳惊惧惨战户扑执扩扫扬担拟拥择挂挤挥' +
  '损换据摆敌数断显晓机权杀条来构枪柜标栋树桥检楼欢汉汤沟没浅测济浏渐渔湿满滨滚灭灯灵烦烧热爱';

const NOTE_PATTERNS: { re: RegExp; message: string }[] = [
  {
    // The real case: 「（meticuloso 應為 meticulous 的筆誤，此處譯為「一絲不苟」）」
    re: /[（(][^）)]{0,80}(?:應為|应为|譯為|译为|譯註|译注|譯者註|原文為|原文是)[^）)]{0,80}[）)]/,
    message: '譯文裡有夾註，看起來是模型自己加的翻譯說明。',
  },
  {
    re: /(?:譯註|譯者註|译注|translator['’]s note)\s*[:：]/i,
    message: '譯文裡有標明的譯註。',
  },
];

function countMacros(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.match(MACRO) ?? []) {
    const key = match.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const countOf = (text: string, char: string): number => text.split(char).length - 1;

/** A little context around the first occurrence, flattened onto one line. */
function excerptAround(text: string, index: number, width = 20): string {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** Traditional Chinese under any of the names the settings offer. */
const wantsTraditional = (targetLang: string): boolean => /繁體|繁体|zh-?(?:tw|hant|hk)/i.test(targetLang);

export function checkTranslation(
  source: string,
  translated: string,
  options: { targetLang?: string } = {},
): TranslationIssue[] {
  const issues: TranslationIssue[] = [];
  if (translated.trim() === '') return issues;

  // --- macros ---------------------------------------------------------------
  const before = countMacros(source);
  const after = countMacros(translated);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(key) ?? 0;
    const to = after.get(key) ?? 0;
    if (from === to) continue;
    issues.push({
      kind: 'macro',
      message:
        to === 0
          ? `${key} 在譯文中消失了（原文有 ${from} 個）。`
          : `${key} 的數量從 ${from} 變成 ${to}，模型${to > from ? '多加了' : '漏掉了'}。`,
    });
  }

  // --- structure ------------------------------------------------------------
  const sourceLines = countOf(source, '\n');
  const translatedLines = countOf(translated.replace(/\r\n/g, '\n'), '\n');
  if (sourceLines !== translatedLines) {
    issues.push({
      kind: 'structure',
      message: `換行數量從 ${sourceLines} 變成 ${translatedLines}，段落結構可能被改動。`,
    });
  }

  // --- script ---------------------------------------------------------------
  if (wantsTraditional(options.targetLang ?? '')) {
    const found = [...new Set([...translated].filter((ch) => SIMPLIFIED_ONLY.includes(ch)))];
    if (found.length > 0) {
      issues.push({
        kind: 'script',
        message: `譯文裡有簡體字：${found.join('、')}`,
        excerpt: excerptAround(translated, translated.indexOf(found[0])),
      });
    }
  }

  // --- translator's notes ---------------------------------------------------
  for (const { re, message } of NOTE_PATTERNS) {
    const match = re.exec(translated);
    // A note that was already in the source is the author's, not the model's.
    if (!match || re.test(source)) continue;
    issues.push({ kind: 'note', message, excerpt: excerptAround(translated, match.index, 30) });
    break;
  }

  return issues;
}
