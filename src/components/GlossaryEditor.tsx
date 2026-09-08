import { ChevronDown, Download, KeyRound, Lock, Plus, Trash2, Unlock, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TermReview } from '../ai';
import type { GlossaryTerm, ScriptSlip, TermKind, TermUsage, TranslationMeta } from '../glossary';
import {
  DECIDE_KEY,
  EXTRACT_KEY,
  REVIEW_KEY,
  TaskProgress,
  TaskStatus,
} from '../hooks/useTranslate';
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
  scriptSlips,
  unapplied,
  reviews,
  reviewNotice,
  status,
  errors,
  progress,
  onSeed,
  onExtract,
  onDecide,
  onReview,
  onTakeReview,
  onDismissReview,
  onCancel,
  onPatch,
  onAdd,
  onRemove,
  onClear,
  onStyleNotes,
  onImport,
  onExport,
  onApplyKeys,
  keysNotice,
  onJump,
}: {
  meta: TranslationMeta;
  usage: TermUsage[];
  conflicts: { target: string; sources: string[] }[];
  /** Decided translations that contain a simplified character. */
  scriptSlips: ScriptSlip[];
  /** Terms a finished translation did not honour, by term source. */
  unapplied: Set<string>;
  /** Open findings from the review pass, by term source. */
  reviews: Map<string, TermReview>;
  /** What the last review run concluded, including that it found nothing. */
  reviewNotice: string;
  status: Record<string, TaskStatus>;
  errors: Record<string, string>;
  progress: Record<string, TaskProgress>;
  onSeed: () => void;
  onExtract: () => void;
  onDecide: () => void;
  onReview: () => void;
  onTakeReview: (index: number, suggestion: string) => void;
  onDismissReview: (source: string) => void;
  onCancel: (key: string) => void;
  onPatch: (index: number, patch: Partial<GlossaryTerm>) => void;
  onAdd: (source: string) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onStyleNotes: (notes: string) => void;
  onImport: (file: File) => void;
  onExport: () => void;
  /** Push the agreed translations into the lorebook keys, without retranslating. */
  onApplyKeys: () => void;
  keysNotice: string;
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
  const decided = terms.length - undecided;

  /**
   * What the review pass would actually look at. Locked terms are left out
   * because the pass skips them — which is also how somebody stops being asked
   * about a finding they disagree with.
   */
  const reviewable = useMemo(
    () =>
      terms.filter((term) => !term.locked && (term.keepOriginal || term.target.trim() !== ''))
        .length,
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
  const slipped = useMemo(() => new Set(scriptSlips.map((slip) => slip.source)), [scriptSlips]);

  /**
   * How badly a term wants looking at. 0 is undecided — it contributes nothing
   * to a translation until somebody settles it. 1 is decided but questioned by
   * one of the checks, or by the review pass. 2 is everything else.
   */
  const attentionOf = useCallback(
    (term: GlossaryTerm): 0 | 1 | 2 => {
      if (!term.keepOriginal && term.target.trim() === '') return 0;
      if (reviews.has(term.source) || slipped.has(term.source) || unapplied.has(term.source)) {
        return 1;
      }
      return 2;
    },
    [reviews, slipped, unapplied],
  );

  /**
   * The order rows are shown in — a snapshot, not a live sort.
   *
   * Sorting live would move a row out from under the cursor the instant a
   * translation was typed into it, which is the one thing a list edited in
   * place must never do. So the order is recomputed only while nothing inside
   * the list holds focus: on load, after a seed or an AI pass, and as soon as
   * the field being edited is left.
   *
   * Within the groups that need attention the tie-break is how often the term
   * occurs. A blank with fifty-seven occurrences is a different problem from a
   * blank with none, and a list that presents them as equals has not helped.
   * Terms with nothing wrong keep the order they were seeded in, since that
   * follows the lorebook and is easier to scan than any ranking.
   */
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState<number[]>([]);

  const ranked = useMemo(
    () =>
      [...rows]
        .sort((a, b) => {
          const rank = attentionOf(a.term);
          const byAttention = rank - attentionOf(b.term);
          if (byAttention !== 0) return byAttention;
          return rank === 2 ? a.index - b.index : b.total - a.total;
        })
        .map((row) => row.index),
    [rows, attentionOf],
  );

  useEffect(() => {
    if (!editing) setOrder(ranked);
  }, [editing, ranked]);

  const shown = useMemo(() => {
    const at = new Map(order.map((index, position) => [index, position]));
    return [...rows].sort((a, b) => (at.get(a.index) ?? Infinity) - (at.get(b.index) ?? Infinity));
  }, [rows, order]);


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
          <TranslateButton
            status={status[REVIEW_KEY]}
            onTranslate={onReview}
            onCancel={() => onCancel(REVIEW_KEY)}
            label="AI 檢查譯名"
            disabled={reviewable === 0}
          />
          <Progress
            progress={progress[EXTRACT_KEY] ?? progress[DECIDE_KEY] ?? progress[REVIEW_KEY]}
          />
        </div>

        <p className="text-xs leading-relaxed text-dim">
          {reviewNotice ||
            '「檢查譯名」會把已決定的譯名連同它在卡片裡的上下文送給 AI，請它挑出指錯東西或會被讀錯的譯名——簡體字與重複那類規則抓得到的，上面的提示已經在管。建議一條條給，採不採用都可以；鎖起來的詞不會被檢查。'}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onApplyKeys} disabled={decided === 0} className="btn-quiet">
            <KeyRound className="size-3.5" />
            套用譯詞到世界書關鍵字
          </button>
          {keysNotice && <span className="text-xs text-dim">{keysNotice}</span>}
        </div>
        <p className="text-xs leading-relaxed text-dim">
          世界書的關鍵字是拿去比對讀者輸入的文字，所以譯後的條目需要譯詞當關鍵字才會被觸發。
          原本的關鍵字一律保留，只是額外附加。整卡翻譯時會自動做這件事；這顆按鈕是給已經翻好的卡補做用的。
        </p>
      </header>

      {[EXTRACT_KEY, DECIDE_KEY, REVIEW_KEY].map(
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

      {scriptSlips.length > 0 && (
        <Banner tone="warn">
          <div className="space-y-1">
            <p>
              以下譯名裡有簡體字。譯名會被釘進每一次翻譯，也會成為世界書關鍵字，所以錯字會跟著擴散出去：
            </p>
            {scriptSlips.map((slip) => (
              <p key={slip.source}>
                <span className="text-dim">{slip.source} → </span>
                <span className="text-gold">{slip.target}</span>
                <span className="text-dim">
                  {' '}
                  （{slip.found.map((bad) => `${bad.had} 應為 ${bad.wanted}`).join('、')}）
                </span>
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
            <ul
              className="space-y-2"
              onFocusCapture={() => setEditing(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
              }}
            >
              {shown.map(({ term, hits, total, entryTitle, snippet, index }) => (
                <TermRow
                  key={`${term.source}-${index}`}
                  term={term}
                  hits={hits}
                  total={total}
                  entryTitle={entryTitle}
                  snippet={snippet}
                  unapplied={unapplied.has(term.source)}
                  slipped={slipped.has(term.source)}
                  review={reviews.get(term.source)}
                  attention={attentionOf(term)}
                  onPatch={(patch) => onPatch(index, patch)}
                  onRemove={() => onRemove(index)}
                  onTakeReview={(suggestion) => onTakeReview(index, suggestion)}
                  onDismissReview={() => onDismissReview(term.source)}
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
  entryTitle,
  snippet,
  unapplied,
  slipped,
  review,
  attention,
  onPatch,
  onRemove,
  onTakeReview,
  onDismissReview,
  onJump,
}: {
  term: GlossaryTerm;
  hits: { path: string; label: string; count: number }[];
  total: number;
  /** The entry this term keys and the first place it is used — what the model was told. */
  entryTitle: string | undefined;
  snippet: string | undefined;
  unapplied: boolean;
  /** The translation contains a simplified character. */
  slipped: boolean;
  /** What the review pass said about this name, while it still applies. */
  review: TermReview | undefined;
  /** 0 undecided, 1 questioned, 2 fine — what the row is tinted by. */
  attention: 0 | 1 | 2;
  onPatch: (patch: Partial<GlossaryTerm>) => void;
  onRemove: () => void;
  onTakeReview: (suggestion: string) => void;
  onDismissReview: () => void;
  onJump: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li
      className={cn(
        'rounded border p-3',
        attention === 0
          ? 'border-amber-500/50 bg-amber-500/5'
          : attention === 1
            ? 'border-amber-500/30 bg-field/60'
            : 'border-line bg-field/60',
      )}
    >
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
        {entryTitle && (
          <span className="truncate text-dim" title={`這個詞是「${entryTitle}」這條世界書的關鍵字`}>
            {entryTitle}
          </span>
        )}
        {slipped && (
          <span className="text-amber-300" title="譯名裡有簡體字">
            簡體
          </span>
        )}
        {unapplied && (
          <span className="text-amber-300" title="上一次翻譯的結果裡沒有出現這個譯名">
            未套用
          </span>
        )}
      </div>

      {/*
        Shown in the row rather than collected into a list at the top: taking a
        suggestion means changing this term's translation, and a finding parked
        somewhere else would make the reader find the row first. The ranking
        already floats the questioned rows up here.
      */}
      {review && (
        <div className="mt-2.5 rounded border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
          <p className="text-body">
            {review.current === '' ? '這個詞現在保留原文，建議譯成 ' : '建議改成 '}
            <span className="text-gold">{review.suggestion}</span>
          </p>
          {review.reason && <p className="mt-1 leading-relaxed text-dim">{review.reason}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => onTakeReview(review.suggestion)} className="btn-quiet">
              採用
            </button>
            {/* No `title` here: it shadows the visible label as the button's
                accessible name, and what it would have said — that locking is
                what silences a finding for good — the header already says. */}
            <button onClick={onDismissReview} className="btn-quiet">
              忽略
            </button>
          </div>
        </div>
      )}

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

          {/*
            The line the naming pass was given about this term, shown to the
            person who has to decide whether to trust what came back. Judging
            `parasite => 寄生體` against `parasite => 寄生蟲` takes the card in
            your head otherwise, and nobody reading a 150-term list has that.
          */}
          {snippet && (
            <div>
              <span className="label text-xs">出現於</span>
              <p className="rounded border border-line bg-surface px-2 py-1.5 text-xs leading-relaxed text-dim">
                {snippet}
              </p>
            </div>
          )}

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
                    title={hit.path}
                  >
                    {hit.label}
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
