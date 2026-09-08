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

export type IssueKind = 'untranslated' | 'macro' | 'structure' | 'script' | 'encoding' | 'note';

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

/** What a decoder leaves behind when the bytes for a character never arrived. */
const REPLACEMENT = '\uFFFD';

/**
 * Simplified characters and the traditional form each one should have been.
 *
 * Pairs rather than a bare list, for two reasons: the report can name the form
 * that was wanted, and anyone can check an entry by looking at it.
 *
 * The systematic radical families are covered in full, because those are where
 * the characters actually come from. What this is not is the complete 简化字总表
 * — that runs to some 2,300 characters, most of which will never appear in a
 * translation whose surrounding text is already traditional.
 *
 * The stricter constraint is the one below: a false alarm is worse than a miss.
 */
const AMBIGUOUS = [
  // Every one of these is correct traditional Chinese in its own right, even
  // though it is also the simplified form of something else. Flagging 皇后 or
  // 這里 as an error would train the reader to ignore the check.
  '后', // 皇后, but also simplified 後
  '台', // 台北, but also simplified 臺
  '里', // 公里, but also simplified 裏
  '只', // 只有, but also simplified 隻
  '干', // 干支, but also simplified 乾 / 幹
  '面', // 面對, but also simplified 麵
  '表', // 表面, but also simplified 錶
  '系', // 系統, but also simplified 係 / 繫
  '制', // 制度, but also simplified 製
  '划', // 划船, but also simplified 劃
  '松', // 松樹, but also simplified 鬆
  '谷', // 山谷, but also simplified 穀
  '丑', // 丑時, but also simplified 醜
  '斗', // 北斗, but also simplified 鬥
  '几', // 茶几, but also simplified 幾
  '卜', // 占卜, but also simplified 蔔
  '云', // 子曰詩云, but also simplified 雲
  '姜', // a surname, but also simplified 薑
  '借', // 借用, but also simplified 藉
  '帘', // 酒帘, but also simplified 簾
  '卷', // 卷軸, but also simplified 捲
  '曲', // 歌曲, but also simplified 麯
  '舍', // 宿舍, but also simplified 捨
  '胡', // 胡人, but also simplified 鬍
  '折', // 折斷, but also simplified 摺
  '布', // 布匹, but also simplified 佈
  '于', // a surname, but also simplified 於
  '余', // 余曰, but also simplified 餘
  '沈', // a surname, but also simplified 瀋
  '朴', // a surname, but also simplified 樸
  '克', // 克服, but also simplified 剋
  '困', // 困難, but also simplified 睏
  '御', // 御用, but also simplified 禦
  '采', // 風采, but also simplified 採
  '志', // 志向, but also simplified 誌
  '咸', // 咸豐, but also simplified 鹹
  '术', // 白术 the herb, but also simplified 術
  '涌', // 洶涌, but also simplified 湧
  '秋', // 秋天, but also simplified 鞦
  '辟', // 復辟, but also simplified 闢
  '冲', // a variant in its own right, but also simplified 沖 / 衝
];

/** Simplified, then the traditional form, two characters at a time. */
const PAIRS =
  // 訁
  '计計订訂讣訃认認讥譏讨討让讓讪訕讫訖训訓议議讯訊记記讲講讳諱讴謳讶訝讷訥许許讹訛论論讼訟讽諷' +
  '设設访訪诀訣证證评評诅詛识識诈詐诉訴诊診诋詆词詞译譯诓誆试試诗詩诘詰诙詼诚誠诛誅话話诞誕' +
  '诠詮诡詭询詢诣詣该該详詳诧詫语語诫誡误誤诰誥诱誘诲誨诳誑说說诵誦请請诸諸诺諾读讀诽誹课課' +
  '诿諉谀諛谁誰调調谄諂谅諒谆諄谈談谊誼谋謀谍諜谎謊谏諫谐諧谑謔谒謁谓謂谕諭谗讒谘諮谙諳谚諺' +
  '谛諦谜謎谟謨谢謝谣謠谤謗谦謙谨謹谩謾谬謬谭譚谱譜谴譴谶讖誉譽' +
  // 釒
  '钉釘钊釗钓釣钙鈣钝鈍钞鈔钟鐘钠鈉钢鋼钥鑰钦欽钧鈞钩鈎钮鈕钱錢钳鉗钻鑽铁鐵铃鈴铅鉛铆鉚铜銅' +
  '铝鋁铠鎧铡鍘铭銘铲鏟银銀铸鑄铺鋪链鏈销銷锁鎖锄鋤锅鍋锈鏽锋鋒锐銳错錯锚錨锡錫锣鑼锤錘锥錐' +
  '锦錦键鍵锯鋸锰錳锻鍛镀鍍镇鎮镊鑷镜鏡镑鎊镖鏢镰鐮镶鑲铂鉑针針' +
  // 糹
  '纠糾红紅纣紂纤纖约約级級纪紀纫紉纬緯纯純纱紗纲綱纳納纵縱纷紛纸紙纹紋纺紡纽紐线線练練组組' +
  '绅紳细細织織终終绊絆绍紹绎繹经經绑綁绒絨结結绕繞绘繪给給绚絢络絡绝絕绞絞统統绢絹绣繡继繼' +
  '绩績绪緒续續绮綺绰綽绳繩维維绵綿绶綬绷繃绸綢综綜绽綻绿綠缀綴缄緘缅緬缆纜缉緝缎緞缓緩缔締' +
  '缕縷编編缘緣缚縛缜縝缝縫缠纏缤繽缨纓缩縮缪繆缭繚缰韁缴繳' +
  // 貝
  '贝貝贞貞负負贡貢财財责責贤賢败敗账賬货貨质質贩販贪貪贫貧贯貫贮貯贰貳贱賤贴貼贵貴贷貸贸貿' +
  '费費贺賀贼賊贾賈贿賄赁賃赂賂资資赈賑赊賒赋賦赌賭赎贖赏賞赐賜赔賠赖賴赘贅赚賺赛賽赝贗赞贊' +
  '赠贈赡贍赢贏赣贛员員贬貶购購' +
  // 車
  '车車轧軋轨軌轩軒转轉轮輪软軟轰轟轴軸轻輕载載轿轎较較辄輒辅輔辆輛辈輩辉輝辐輻辑輯输輸辖轄' +
  '辗輾辙轍辘轆轼軾辕轅' +
  // 門
  '门門闪閃闭閉问問闯闖闲閒间間闷悶闸閘闹鬧闺閨闻聞闽閩阀閥阁閣阅閱阎閻阐闡阔闊阑闌阙闕关關联聯' +
  // 馬
  '马馬驮馱驯馴驰馳驱驅驳駁驴驢驶駛驹駒驻駐驼駝驾駕骂罵骄驕骆駱骇駭骋騁验驗骏駿骑騎骗騙骚騷' +
  '骤驟骡騾惊驚妈媽码碼蚂螞玛瑪吗嗎' +
  // 鳥 · 魚
  '鸟鳥鸠鳩鸡雞鸣鳴鸦鴉鸭鴨鸯鴦鸳鴛鸽鴿鹅鵝鹉鵡鹊鵲鹏鵬鹤鶴鹦鸚鹰鷹鸥鷗鸵鴕鹃鵑鸿鴻鹭鷺鸾鸞' +
  '鱼魚鲁魯鲍鮑鲜鮮鲤鯉鲨鯊鲸鯨鳃鰓鳍鰭鳞鱗鲈鱸鳄鱷鲫鯽鲷鯛鳖鱉' +
  // 見 · 頁 · 風 · 飠
  '见見观觀规規觅覓视視觉覺览覽亲親现現觐覲' +
  '页頁顶頂顷頃项項顺順须須顽頑顾顧顿頓颂頌预預领領颇頗颈頸颊頰颐頤频頻颓頹颖穎颗顆题題颜顏' +
  '额額颠顛颤顫颧顴类類颁頒' +
  '风風飒颯飓颶飘飄飙飆' +
  '饥飢饭飯饮飲饰飾饱飽饲飼饵餌饶饒饺餃饼餅饿餓馆館馈饋馒饅饷餉' +
  // 韋 · 龍 · 齊 · 東 · 專 · 義
  '韦韋违違围圍韩韓韧韌卫衛' +
  '龙龍垄壟拢攏笼籠聋聾咙嚨陇隴宠寵庞龐袭襲' +
  '齐齊剂劑济濟挤擠脐臍' +
  '东東冻凍陈陳栋棟拣揀' +
  '专專传傳砖磚团團' +
  '义義仪儀蚁蟻' +
  // Standalone, by rough frequency
  '个個们們这這来來过過时時发發会會对對应應当當种種样樣还還实實进進国國点點热熱爱愛学學写寫' +
  '无無书書长長飞飛产產业業务務严嚴与與为為乐樂习習乡鄉亚亞从從仅僅仓倉伟偉伤傷体體众眾优優' +
  '儿兒兰蘭兴興军軍农農净淨动動劳勞势勢医醫卖賣单單参參双雙变變号號叶葉响響启啟声聲备備复復' +
  '头頭夺奪奋奮妆妝娱娛婴嬰孙孫宁寧宝寶审審层層岁歲岛島币幣师師帮幫带帶帐帳广廣庆慶库庫归歸' +
  '录錄彻徹忆憶忧憂怀懷态態总總恋戀恳懇惧懼惨慘战戰户戶扑撲执執扩擴扫掃扬揚担擔拟擬拥擁择擇' +
  '挂掛挥揮损損换換据據摆擺敌敵数數断斷显顯晓曉机機权權杀殺条條构構枪槍柜櫃标標树樹桥橋检檢' +
  '楼樓欢歡汉漢汤湯沟溝浅淺测測浏瀏渐漸渔漁湿濕满滿滨濱滚滾灭滅灯燈灵靈烦煩烧燒营營犹猶状狀' +
  '独獨狮獅猪豬献獻环環疗療疯瘋痒癢皱皺盘盤睐睞矫矯硕碩确確碍礙礼禮祷禱离離秃禿积積称稱稳穩' +
  '穷窮窃竊竖豎笔筆笋筍筑築简簡箫簫签簽篮籃紧緊罗羅罚罰罢罷羁羈翘翹耻恥聂聶职職肠腸肤膚肿腫' +
  '胀脹脑腦脓膿脸臉腊臘腻膩舰艦艰艱艳艷节節芦蘆苏蘇苹蘋茎莖荐薦荡蕩药藥莱萊萝蘿蒋蔣蓝藍蔷薔' +
  '虏虜虑慮虾蝦蚀蝕蜡蠟蝇蠅蝉蟬补補袄襖装裝赶趕趋趨跃躍践踐踌躊蹑躡辞辭边邊达達迁遷运運连連' +
  '迟遲适適选選逊遜递遞逻邏遗遺邓鄧邮郵郑鄭邻鄰酝醞释釋队隊阶階阳陽阴陰陆陸险險隐隱难難雏雛' +
  '杂雜电電霉黴静靜卤滷麦麥齿齒龄齡龈齦龟龜别別却卻处處尔爾万萬汇匯尽盡历歷钟鐘须鬚' +
  // Added from a real card's own vocabulary, where the gaps showed. Twenty of
  // its glossary terms contain 聖 and its lead is called 凱齊亞, yet neither 圣
  // nor 凯 was here. The 兌 family came from 蛻變 typed as 蜕變, which nothing
  // caught — in a 譯名, where it would have been pinned into every prompt.
  '圣聖华華兽獸剑劍丽麗凤鳳凯凱髅髏触觸渊淵洁潔虚虛禅禪坛壇庙廟兑兌悦悅脱脫蜕蛻';

/** Built once: every simplified character mapped to what it should have been. */
const TRADITIONAL_FOR = (() => {
  const map = new Map<string, string>();
  const ambiguous = new Set(AMBIGUOUS);
  for (let i = 0; i + 1 < PAIRS.length; i += 2) {
    const simplified = PAIRS[i];
    if (ambiguous.has(simplified)) continue;
    if (!map.has(simplified)) map.set(simplified, PAIRS[i + 1]);
  }
  return map;
})();

/** Exposed so a test can hold the table to its own rules. */
export const simplifiedTable = (): ReadonlyMap<string, string> => TRADITIONAL_FOR;

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

/**
 * A target language written in Han characters, where a section that came back
 * in the source language is visible by script alone.
 */
const wantsHan = (targetLang: string): boolean =>
  /中文|漢語|汉语|國語|国语|粵語|粤语|華語|华语|zh/i.test(targetLang);

const HAN = /\p{Script=Han}/gu;
const LATIN = /[A-Za-z]/g;

/** Below this share of the letters, a 中文 translation did not happen. */
const HAN_SHARE_FLOOR = 0.15;

/**
 * Under this many letters of prose there was nothing to translate, so a section
 * that came back identical is not evidence of anything.
 */
const MIN_PROSE_LETTERS = 20;

/**
 * What the share needs before it is worth reading, being the fuzzier of the
 * two. A heading or a stat block can sit under any share honestly; on the card
 * this was measured against, every echoed entry ran past a thousand characters
 * and the lowest real translation still came in at 65% Han.
 */
const MIN_SHARE_LETTERS = 120;

/** Traditional Chinese under any of the names the settings offer. */
export const wantsTraditional = (targetLang: string): boolean => /繁體|繁体|zh-?(?:tw|hant|hk)/i.test(targetLang);

export function checkTranslation(
  source: string,
  translated: string,
  options: { targetLang?: string } = {},
): TranslationIssue[] {
  const issues: TranslationIssue[] = [];
  if (translated.trim() === '') return issues;

  // --- untranslated ---------------------------------------------------------
  //
  // The one every other check here is blind to. A model that declines by
  // handing back its input scores perfectly on all five: the macros match, the
  // newlines match, there are no simplified characters, no U+FFFD, no note. A
  // real card came back with ten of its seventeen lorebook entries echoed byte
  // for byte — 987 characters in, 987 out — and the report called all
  // twenty-four sections a success. Which also cost them the retry: a section
  // recorded as translated is never one of the few a retry spends itself on.
  //
  // Two shapes, because the echo is not always the whole thing — one entry came
  // back with its heading translated and its body untouched, another with its
  // category labels translated and the list untouched. Equality is exact and
  // holds for any language. The share is what catches the partial ones, and it
  // only holds where the target language is written in Han: an English section
  // returned in English is invisible to this file, and saying so is cheaper
  // than a rule that pretends otherwise.
  //
  // Both are gated on the source having had something to translate. A section
  // that is a stat line or a bare macro comes back identical because that is
  // the correct translation of it, and macros are substituted rather than
  // translated, so they are not counted as prose.
  const sourceProse = source.trim().replace(MACRO, ' ');
  const proseLetters =
    (sourceProse.match(LATIN) ?? []).length + (sourceProse.match(HAN) ?? []).length;

  if (proseLetters >= MIN_PROSE_LETTERS) {
    if (source.trim() === translated.trim()) {
      issues.push({
        kind: 'untranslated',
        message: '譯文與原文逐字相同——模型把原文原封退了回來，這一段沒有被翻譯。',
      });
    } else if (proseLetters >= MIN_SHARE_LETTERS && wantsHan(options.targetLang ?? '')) {
      const han = (translated.match(HAN) ?? []).length;
      const latin = (translated.match(LATIN) ?? []).length;
      const share = han + latin === 0 ? 1 : han / (han + latin);

      if (share < HAN_SHARE_FLOOR) {
        issues.push({
          kind: 'untranslated',
          message: `譯文只有 ${Math.round(share * 100)}% 是中文，其餘仍是原文——這一段大概只有標題被翻到。`,
          excerpt: excerptAround(translated, 0, 30),
        });
      }
    }
  }

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
  //
  // Both sides are trimmed first. `cleanOutput` strips surrounding whitespace
  // from every translation, so a source ending in a newline always came back
  // exactly one short — which flagged seventeen of eighteen lorebook entries on
  // a real card while telling the reader nothing. Only breaks *inside* the text
  // are structure.
  const sourceLines = countOf(source.trim(), '\n');
  const translatedLines = countOf(translated.replace(/\r\n/g, '\n').trim(), '\n');
  if (sourceLines !== translatedLines) {
    issues.push({
      kind: 'structure',
      message: `換行數量從 ${sourceLines} 變成 ${translatedLines}，段落結構可能被改動。`,
    });
  }

  // --- script ---------------------------------------------------------------
  if (wantsTraditional(options.targetLang ?? '')) {
    const found = [...new Set([...translated].filter((ch) => TRADITIONAL_FOR.has(ch)))];
    if (found.length > 0) {
      issues.push({
        kind: 'script',
        // Naming the form that was wanted turns a complaint into a correction.
        message: `譯文裡有簡體字：${found
          .map((ch) => `${ch}（應為 ${TRADITIONAL_FOR.get(ch)}）`)
          .join('、')}`,
        excerpt: excerptAround(translated, translated.indexOf(found[0])),
      });
    }
  }

  // --- encoding -------------------------------------------------------------
  //
  // The cheapest check in this file and the one that has caught the most. A
  // single card came back carrying forty-nine replacement characters — one per
  // 370 — spread through the greetings, the lorebook and the description, while
  // every other check passed all thirty-six of its sections.
  //
  // Nothing here produced them: `http.ts` reads a response with one
  // `response.text()`, so there is no chunk boundary for a multi-byte character
  // to be split on. They arrive from the model, or from whatever sits between.
  //
  // Unlike the script check there is nothing to weigh, which is why this one has
  // no exceptions list: U+FFFD is never a character anybody meant to write, so a
  // hit is never a false alarm. What it replaced can only be recovered from the
  // source, which is why this reports rather than repairs — and why the source's
  // own are subtracted, so a card that arrived damaged is not blamed on the
  // translation.
  const lostBefore = countOf(source, REPLACEMENT);
  const lostAfter = countOf(translated, REPLACEMENT);
  if (lostAfter > lostBefore) {
    issues.push({
      kind: 'encoding',
      message: `譯文裡有 ${lostAfter - lostBefore} 個無法辨識的字元（U+FFFD），模型或端點把字吐壞了。原字已經不在譯文裡，要對照原文才補得回來。`,
      excerpt: excerptAround(translated, translated.indexOf(REPLACEMENT)),
    });
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
