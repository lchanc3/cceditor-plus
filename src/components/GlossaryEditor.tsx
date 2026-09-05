import { ChevronDown, Download, Lock, Plus, Trash2, Unlock, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import type { GlossaryTerm, TermKind, TermUsage, TranslationMeta } from '../glossary';
import { DECIDE_KEY, EXTRACT_KEY, TaskProgress, TaskStatus } from '../hooks/useTranslate';
import { cn } from '../lib/utils';
import { Banner, EmptyHint, TranslateButton } from './ui';

const KIND_LABELS: Record<TermKind, string> = {
  person: '人物',
  place: '地點',
  org: '組織',
  item: '物品',
  title: '稱謂',
  concept: '概念',
  other: '其他',
};

/** Where a translation came from, which is also what a later AI pass may not overwrite. */
const ORIGIN_LABELS: Record<GlossaryTerm['origin'], string> = {
  'lore-key': '世界書',
  name: '角色名',
  ai: 'AI',
  manual: '手動',
  import: '匯入',
};

export function GlossaryEditor({
  meta,
  usage,
  conflicts,
  unapplied,
  status,
  errors,
  progress,
  onSeed,
  onExtract,
  onDecide,
  onCancel,
  onPatch,
  onAdd,
  onRemove,
  onClear,
  onStyleNotes,
  onImport,
  onExport,
  onJump,
}: {
  meta: TranslationMeta;
  usage: TermUsage[];
  conflicts: { target: string; sources: string[] }[];
  /** Terms a finished translation did not honour, by term source. */
  unapplied: Set<string>;
  status: Record<string, TaskStatus>;
  errors: Record<string, string>;
  progress: Record<string, TaskProgress>;
  onSeed: () => void;
  onExtract: () => void;
  onDecide: () => void;
  onCancel: (key: string) => void;
  onPatch: (index: number, patch: Partial<GlossaryTerm>) => void;
  onAdd: (source: string) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onStyleNotes: (notes: string) => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onJump: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const terms = meta.glossary;

  const undecided = useMemo(
    () => terms.filter((term) => !term.keepOriginal && term.target.trim() === '').length,
    [terms],
  );

  // Filtering keeps the original index, because that is what every action takes.
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return usage
      .map((entry, index) => ({ ...entry, index }))
      .filter(({ term }) => {
        if (pendingOnly && (term.keepOriginal || term.target.trim() !== '')) return false;
        if (needle === '') return true;
        return (
          term.source.toLowerCase().includes(needle) ||
          term.target.toLowerCase().includes(needle) ||
          term.aliases.some((alias) => alias.toLowerCase().includes(needle))
        );
      });
  }, [usage, query, pendingOnly]);

  const commitDraft = () => {
    if (draft.trim()) onAdd(draft.trim());
    setDraft('');
  };

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div>
          <h3 className="text-sm font-bold tracking-wide text-gold">詞彙 / 世界觀</h3>
          <p className="mt-1 text-xs leading-relaxed text-dim">
            這裡決定的譯名會套用到每一次翻譯，也會成為世界書的觸發關鍵字。
            詞彙表跟著角色卡一起儲存，下次開啟同一張卡時會自動還原。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onSeed} className="btn-quiet">
            <Plus className="size-3.5" />
            從世界書帶入
          </button>
          <TranslateButton
            status={status[EXTRACT_KEY]}
            onTranslate={onExtract}
            onCancel={() => onCancel(EXTRACT_KEY)}
            label="AI 掃描專有名詞"
          />
          <TranslateButton
            status={status[DECIDE_KEY]}
            onTranslate={onDecide}
            onCancel={() => onCancel(DECIDE_KEY)}
            label="AI 決定譯名"
            disabled={undecided === 0}
          />
          <Progress progress={progress[EXTRACT_KEY] ?? progress[DECIDE_KEY]} />
        </div>
      </header>

      {[EXTRACT_KEY, DECIDE_KEY].map(
        (key) => errors[key] && <Banner key={key} tone="error">{errors[key]}</Banner>,
      )}

      {conflicts.length > 0 && (
        <Banner tone="warn">
          <div className="space-y-1">
            <p>以下譯名對應到多個原文，世界書關鍵字會變得無法區分：</p>
            {conflicts.map((conflict) => (
              <p key={conflict.target}>
                <span className="text-gold">{conflict.target}</span> ← {conflict.sources.join('、')}
              </p>
            ))}
          </div>
        </Banner>
      )}

      <div>
        <label className="label" htmlFor="style-notes">
          文風要求
        </label>
        <textarea
          id="style-notes"
          rows={2}
          value={meta.styleNotes}
          onChange={(event) => onStyleNotes(event.target.value)}
          placeholder="例如：第二人稱用「你」不用「您」；長老稱主角為「孩子」；旁白用書面語。"
          className="field resize-y text-sm leading-relaxed"
        />
        <p className="mt-1 text-xs text-dim">
          詞彙表管專有名詞，這裡管語氣與人稱——兩者一起送給 AI，減少每次翻譯的落差。
        </p>
      </div>

      {terms.length === 0 ? (
        <EmptyHint>
          還沒有任何詞彙。先按「從世界書帶入」把作者標好的關鍵字收進來，再用 AI 補其餘的專有名詞。
        </EmptyHint>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋原文或譯名…"
              className="field min-w-40 flex-1 text-sm"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-dim">
              <input
                type="checkbox"
                checked={pendingOnly}
                onChange={(event) => setPendingOnly(event.target.checked)}
                className="size-4 accent-[#d4af37]"
              />
              只看未決定（{undecided}）
            </label>
          </div>

          {rows.length === 0 ? (
            <EmptyHint>沒有符合條件的詞彙。</EmptyHint>
          ) : (
            <ul className="space-y-2">
              {rows.map(({ term, hits, total, index }) => (
                <TermRow
                  key={`${term.source}-${index}`}
                  term={term}
                  hits={hits}
                  total={total}
                  unapplied={unapplied.has(term.source)}
                  onPatch={(patch) => onPatch(index, patch)}
                  onRemove={() => onRemove(index)}
                  onJump={onJump}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft();
            }
          }}
          onBlur={commitDraft}
          placeholder="手動新增一個詞（Enter）"
          className="field min-w-40 flex-1 text-sm"
        />
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImport(file);
            // Reset so re-picking the same file fires again.
            event.target.value = '';
          }}
        />
        <button onClick={() => fileInput.current?.click()} className="btn-quiet">
          <Upload className="size-3.5" />
          匯入
        </button>
        <button onClick={onExport} disabled={terms.length === 0} className="btn-quiet">
          <Download className="size-3.5" />
          匯出
        </button>
        <button
          onClick={onClear}
          disabled={terms.length === 0}
          className="btn-quiet hover:text-red-400"
        >
          <Trash2 className="size-3.5" />
          清空
        </button>
      </div>
    </div>
  );
}

function Progress({ progress }: { progress: TaskProgress | undefined }) {
  if (!progress) return null;
  return (
    <span className="text-xs text-dim tabular-nums">
      {progress.done} / {progress.total}
    </span>
  );
}

function TermRow({
  term,
  hits,
  total,
  unapplied,
  onPatch,
  onRemove,
  onJump,
}: {
  term: GlossaryTerm;
  hits: { path: string; count: number }[];
  total: number;
  unapplied: boolean;
  onPatch: (patch: Partial<GlossaryTerm>) => void;
  onRemove: () => void;
  onJump: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded border border-line bg-field/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-32 flex-1 truncate text-sm text-body" title={term.source}>
          {term.source}
        </span>

        <input
          value={term.keepOriginal ? '' : term.target}
          onChange={(event) => onPatch({ target: event.target.value })}
          disabled={term.locked || term.keepOriginal}
          placeholder={term.keepOriginal ? '保留原文' : '譯名'}
          className="field min-w-32 flex-1 text-sm disabled:opacity-50"
        />

        <button
          onClick={() => onPatch({ locked: !term.locked })}
          className={cn('btn-quiet', term.locked && 'text-gold')}
          aria-pressed={term.locked}
          title={term.locked ? '已鎖定，AI 不會更動' : '鎖定後 AI 不會更動'}
        >
          {term.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          <span className="sr-only">鎖定</span>
        </button>
        <button
          onClick={() => setOpen((value) => !value)}
          className="btn-quiet"
          aria-expanded={open}
          aria-label="展開細節"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        <button onClick={onRemove} className="btn-quiet hover:text-red-400" aria-label="刪除詞彙">
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
        <span>{ORIGIN_LABELS[term.origin]}</span>
        <span>{KIND_LABELS[term.kind]}</span>
        <span className="tabular-nums">{total} 處</span>
        {unapplied && (
          <span className="text-amber-300" title="上一次翻譯的結果裡沒有出現這個譯名">
            未套用
          </span>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label text-xs">類型</label>
              <select
                className="field text-sm"
                value={term.kind}
                onChange={(event) => onPatch({ kind: event.target.value as TermKind })}
              >
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label text-xs">別名（逗號分隔）</label>
              <input
                className="field text-sm"
                value={term.aliases.join(', ')}
                onChange={(event) =>
                  onPatch({
                    aliases: event.target.value
                      .split(',')
                      .map((alias) => alias.trim())
                      .filter((alias) => alias !== ''),
                  })
                }
                placeholder="the Elder, Elders"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-dim">
            <input
              type="checkbox"
              checked={term.keepOriginal}
              onChange={(event) => onPatch({ keepOriginal: event.target.checked })}
              className="size-4 accent-[#d4af37]"
            />
            保留原文，不要翻譯
          </label>

          <div>
            <span className="label text-xs">出現位置</span>
            {hits.length === 0 ? (
              <p className="text-xs text-dim">
                內文中沒有出現。世界書關鍵字本身不計入，所以剛帶入的詞可能是 0 處。
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {hits.map((hit) => (
                  <button
                    key={hit.path}
                    onClick={() => onJump(hit.path)}
                    className="rounded border border-line bg-surface px-2 py-1 text-xs text-gold hover:border-gold"
                  >
                    {hit.path}
                    <span className="ml-1 text-dim tabular-nums">×{hit.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
