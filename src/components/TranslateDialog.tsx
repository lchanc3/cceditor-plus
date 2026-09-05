import { Languages } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { CardSection, GlossaryReadiness, SectionGroup } from '../glossary';
import { sectionGroup } from '../glossary';
import { Banner, Modal } from './ui';

/**
 * The order they appear in, and why each is or is not on by default.
 *
 * The two that default to off are the ones a translation can quietly break.
 * They are offered rather than hidden, because a translator working entirely
 * in one language may well want them.
 */
const GROUPS: {
  id: SectionGroup;
  label: string;
  hint?: string;
  defaultOn: boolean;
}[] = [
  { id: 'core', label: '角色描述、性格、場景、開場白、對話範例', defaultOn: true },
  { id: 'greetings', label: '其他開場白', defaultOn: true },
  { id: 'lore', label: '世界書內容', defaultOn: true },
  { id: 'notes', label: '作者備註', hint: '給讀者看的說明，不會進入對話。', defaultOn: true },
  {
    id: 'name',
    label: '角色名稱',
    hint: '{{char}} 的來源。翻譯它會連帶改變卡片上每一處巨集展開的結果。',
    defaultOn: false,
  },
  {
    id: 'directives',
    label: '系統提示、歷史後指示',
    hint: '寫給模型看的指令，不是給讀者看的文字。翻譯後可能失效。',
    defaultOn: false,
  },
];

export const defaultGroups = (): Record<SectionGroup, boolean> =>
  Object.fromEntries(GROUPS.map((group) => [group.id, group.defaultOn])) as Record<
    SectionGroup,
    boolean
  >;

export function TranslateDialog({
  open,
  sections,
  readiness,
  onClose,
  onStart,
  onOpenGlossary,
}: {
  open: boolean;
  sections: CardSection[];
  readiness: GlossaryReadiness;
  onClose: () => void;
  onStart: (paths: string[]) => void;
  onOpenGlossary: () => void;
}) {
  const [enabled, setEnabled] = useState(defaultGroups);

  const counts = useMemo(() => {
    const tally = {} as Record<SectionGroup, number>;
    for (const section of sections) {
      const group = sectionGroup(section.path);
      tally[group] = (tally[group] ?? 0) + 1;
    }
    return tally;
  }, [sections]);

  const chosen = useMemo(
    () => sections.filter((section) => enabled[sectionGroup(section.path)]).map((s) => s.path),
    [sections, enabled],
  );

  // Entries that would come back translated but keep only their source-language
  // keys — the failure that leaves a lorebook silently dead.
  const uncovered = readiness.entriesWithKeys - readiness.entriesCovered;
  const willTranslateLore = enabled.lore && (counts.lore ?? 0) > 0;

  return (
    <Modal open={open} title="翻譯整張卡片" onClose={onClose}>
      {readiness.terms === 0 ? (
        <Banner tone="warn">
          <div className="space-y-2">
            <p>
              詞彙表是空的，這次翻譯會逐段獨立進行——同一個專有名詞在不同段落可能被翻成不同名字。
            </p>
            {willTranslateLore && uncovered > 0 && (
              <p>
                而且 <span className="text-gold">{uncovered}</span> 條世界書的關鍵字不會加上譯詞。
                關鍵字是拿去比對讀者輸入的文字的，條目翻成中文、關鍵字留在原文，這些條目就再也不會被觸發。
              </p>
            )}
            <button onClick={onOpenGlossary} className="btn-quiet px-0">
              先去「詞彙」分頁 →
            </button>
          </div>
        </Banner>
      ) : readiness.undecided > 0 ? (
        <Banner tone="warn">
          <div className="space-y-2">
            <p>
              詞彙表有 <span className="text-gold">{readiness.undecided}</span> 個詞還沒決定譯名，
              這次翻譯不會用到它們（已決定的 {readiness.decided} 個會照常套用）。
            </p>
            {willTranslateLore && uncovered > 0 && (
              <p>
                另有 <span className="text-gold">{uncovered}</span> 條世界書的關鍵字拿不到譯詞，
                翻譯後將無法被觸發。
              </p>
            )}
            <button onClick={onOpenGlossary} className="btn-quiet px-0">
              先去「詞彙」分頁按「AI 決定譯名」→
            </button>
          </div>
        </Banner>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="label">要翻譯的部分</legend>
        {GROUPS.map((group) => {
          const count = counts[group.id] ?? 0;
          return (
            <label
              key={group.id}
              className={`flex gap-3 rounded border p-3 transition-colors ${
                count === 0
                  ? 'border-line opacity-40'
                  : enabled[group.id]
                    ? 'cursor-pointer border-gold bg-gold/5'
                    : 'cursor-pointer border-line hover:border-line-bright'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[#d4af37]"
                checked={enabled[group.id] && count > 0}
                disabled={count === 0}
                onChange={(event) =>
                  setEnabled((prev) => ({ ...prev, [group.id]: event.target.checked }))
                }
              />
              <span className="min-w-0">
                <span className="block text-sm">
                  {group.label}
                  <span className="ml-2 text-xs text-dim tabular-nums">{count} 段</span>
                </span>
                {group.hint && (
                  <span className="mt-1 block text-xs leading-relaxed text-dim">{group.hint}</span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="btn-ghost px-4">
          取消
        </button>
        <button
          onClick={() => onStart(chosen)}
          disabled={chosen.length === 0}
          className="btn-primary px-4"
        >
          <Languages className="size-4" />
          翻譯 {chosen.length} 段
        </button>
      </div>
    </Modal>
  );
}
