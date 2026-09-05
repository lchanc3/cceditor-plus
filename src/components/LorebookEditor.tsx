import { ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import type { Lorebook, LorebookEntry } from '../card';
import type { TaskStatus } from '../hooks/useTranslate';
import type { KeyField } from '../state/cardStore';
import { cn } from '../lib/utils';
import { Banner, EmptyHint, TranslateButton } from './ui';

export function LorebookEditor({
  book,
  status,
  errors,
  onPatchBook,
  onAdd,
  onRemove,
  onPatch,
  onAddKeys,
  onRemoveKey,
  onTranslate,
  onCancel,
}: {
  book: Lorebook | undefined;
  status: Record<string, TaskStatus>;
  errors: Record<string, string>;
  onPatchBook: (patch: Partial<Lorebook>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onPatch: (index: number, patch: Partial<LorebookEntry>) => void;
  onAddKeys: (index: number, field: KeyField, raw: string) => void;
  onRemoveKey: (index: number, field: KeyField, keyIndex: number) => void;
  onTranslate: (index: number) => void;
  onCancel: (index: number) => void;
}) {
  const entries = book?.entries ?? [];

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold tracking-wide text-gold">世界書</h3>
          <p className="mt-1 text-xs text-dim">翻譯條目時會保留原本的關鍵字，並額外附加譯詞。</p>
        </div>
        <button onClick={onAdd} className="btn-ghost shrink-0 px-3 text-sm">
          <Plus className="size-4" />
          新增條目
        </button>
      </header>

      <div>
        <label className="label" htmlFor="book-name">
          世界書名稱
        </label>
        <input
          id="book-name"
          className="field text-sm"
          value={book?.name ?? ''}
          onChange={(event) => onPatchBook({ name: event.target.value })}
          placeholder="選填"
        />
      </div>

      {entries.length === 0 ? (
        <EmptyHint>此卡片沒有內建世界書</EmptyHint>
      ) : (
        <ul className="space-y-4">
          {entries.map((entry, index) => (
            <EntryCard
              key={index}
              index={index}
              entry={entry}
              status={status[`lore:${index}`]}
              error={errors[`lore:${index}`]}
              onRemove={() => onRemove(index)}
              onPatch={(patch) => onPatch(index, patch)}
              onAddKeys={(field, raw) => onAddKeys(index, field, raw)}
              onRemoveKey={(field, keyIndex) => onRemoveKey(index, field, keyIndex)}
              onTranslate={() => onTranslate(index)}
              onCancel={() => onCancel(index)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryCard({
  index,
  entry,
  status,
  error,
  onRemove,
  onPatch,
  onAddKeys,
  onRemoveKey,
  onTranslate,
  onCancel,
}: {
  index: number;
  entry: LorebookEntry;
  status: TaskStatus | undefined;
  error?: string;
  onRemove: () => void;
  onPatch: (patch: Partial<LorebookEntry>) => void;
  onAddKeys: (field: KeyField, raw: string) => void;
  onRemoveKey: (field: KeyField, keyIndex: number) => void;
  onTranslate: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li
      id={`lore-${index}`}
      className="scroll-mt-4 rounded border border-line bg-field/60 p-3 sm:p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-dim">#{index + 1}</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-dim">
            <input
              type="checkbox"
              checked={entry.enabled}
              onChange={(event) => onPatch({ enabled: event.target.checked })}
              className="size-4 accent-[#d4af37]"
            />
            啟用
          </label>
          {entry.comment && <span className="truncate text-dim/70">{entry.comment}</span>}
        </div>

        <div className="flex items-center gap-1">
          <TranslateButton
            status={status}
            onTranslate={onTranslate}
            onCancel={onCancel}
            label="翻譯"
            disabled={entry.content.trim() === ''}
          />
          <button
            onClick={() => setOpen((value) => !value)}
            className="btn-quiet"
            aria-expanded={open}
            aria-label="展開進階設定"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </button>
          <button onClick={onRemove} className="btn-quiet hover:text-red-400" aria-label="刪除條目">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      {error && <div className="mb-3"><Banner tone="error">{error}</Banner></div>}

      <KeyList
        label="關鍵字"
        keys={entry.keys}
        onAdd={(raw) => onAddKeys('keys', raw)}
        onRemove={(keyIndex) => onRemoveKey('keys', keyIndex)}
      />
      <KeyList
        label="次要關鍵字"
        dashed
        keys={entry.secondary_keys ?? []}
        onAdd={(raw) => onAddKeys('secondary_keys', raw)}
        onRemove={(keyIndex) => onRemoveKey('secondary_keys', keyIndex)}
      />

      <textarea
        rows={5}
        className="field mt-3 resize-y text-sm leading-relaxed"
        value={entry.content}
        onChange={(event) => onPatch({ content: event.target.value })}
        placeholder="世界書內容…"
      />

      {open && (
        <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
          <div>
            <label className="label text-xs">備註 (comment)</label>
            <input
              className="field text-sm"
              value={entry.comment ?? ''}
              onChange={(event) => onPatch({ comment: event.target.value })}
            />
          </div>
          <div>
            <label className="label text-xs">插入順序</label>
            <input
              type="number"
              className="field text-sm"
              value={entry.insertion_order}
              onChange={(event) => onPatch({ insertion_order: Number(event.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="label text-xs">位置</label>
            <select
              className="field text-sm"
              value={String(entry.position ?? 'before_char')}
              onChange={(event) => onPatch({ position: event.target.value })}
            >
              <option value="before_char">before_char</option>
              <option value="after_char">after_char</option>
            </select>
          </div>
          <div className="flex flex-wrap items-end gap-4 text-sm text-dim">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={entry.constant ?? false}
                onChange={(event) => onPatch({ constant: event.target.checked })}
                className="size-4 accent-[#d4af37]"
              />
              常駐
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={entry.use_regex}
                onChange={(event) => onPatch({ use_regex: event.target.checked })}
                className="size-4 accent-[#d4af37]"
              />
              正規表示式
            </label>
          </div>
        </div>
      )}
    </li>
  );
}

function KeyList({
  label,
  keys,
  dashed,
  onAdd,
  onRemove,
}: {
  label: string;
  keys: string[];
  dashed?: boolean;
  onAdd: (raw: string) => void;
  onRemove: (index: number) => void;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    if (draft.trim()) onAdd(draft);
    setDraft('');
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 text-xs font-bold text-dim">{label}</span>
      {keys.map((key, index) => (
        <span
          key={`${key}-${index}`}
          className={cn(
            'inline-flex items-center gap-1 rounded border bg-surface py-0.5 pr-0.5 pl-2 text-xs text-gold',
            dashed ? 'border-dashed border-line-bright' : 'border-line',
          )}
        >
          {key}
          <button
            onClick={() => onRemove(index)}
            className="tap -m-1 p-1 text-dim hover:text-red-400"
            aria-label={`移除 ${key}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        className="min-w-28 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-body outline-none focus:border-gold"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="+ 新增（Enter）"
      />
    </div>
  );
}
