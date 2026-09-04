import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import type { CardFields } from '../card';
import type { TaskStatus } from '../hooks/useTranslate';
import { splitKeys } from '../state/cardStore';
import { TranslateButton } from './ui';

export function BasicEditor({
  fields,
  status,
  onChange,
  onTranslateNotes,
  onCancelNotes,
}: {
  fields: CardFields;
  status: TaskStatus | undefined;
  onChange: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void;
  onTranslateNotes: () => void;
  onCancelNotes: () => void;
}) {
  return (
    <div className="space-y-7">
      <TagEditor tags={fields.tags} onChange={(tags) => onChange('tags', tags)} />

      <section className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="character-version">
            版本
          </label>
          <input
            id="character-version"
            className="field text-sm"
            value={fields.character_version}
            onChange={(event) => onChange('character_version', event.target.value)}
            placeholder="1.0"
          />
        </div>
        <div>
          <label className="label" htmlFor="nickname">
            暱稱（V3）
          </label>
          <input
            id="nickname"
            className="field text-sm"
            value={fields.nickname ?? ''}
            onChange={(event) => onChange('nickname', event.target.value)}
            placeholder="選填"
          />
        </div>
      </section>

      <section className="space-y-3">
        <header className="flex items-center justify-between gap-2">
          <label className="label mb-0" htmlFor="creator-notes">
            作者備註
          </label>
          <TranslateButton
            status={status}
            onTranslate={onTranslateNotes}
            onCancel={onCancelNotes}
            disabled={fields.creator_notes.trim() === ''}
          />
        </header>
        <textarea
          id="creator-notes"
          rows={6}
          className="field resize-y leading-relaxed"
          value={fields.creator_notes}
          onChange={(event) => onChange('creator_notes', event.target.value)}
          placeholder="給使用者的說明、注意事項、推薦設定…"
        />
      </section>
    </div>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const added = splitKeys(draft).filter((tag) => !tags.includes(tag));
    if (added.length > 0) onChange([...tags, ...added]);
    setDraft('');
  };

  return (
    <section className="space-y-3">
      <span className="label">標籤</span>
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-field py-1 pr-1 pl-2.5 text-sm"
          >
            {tag}
            <button
              onClick={() => onChange(tags.filter((_, i) => i !== index))}
              className="tap -m-1 p-1 text-dim hover:text-red-400"
              aria-label={`移除標籤 ${tag}`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="field flex-1 text-sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          placeholder="輸入標籤後按 Enter，可用逗號分隔多個"
        />
        <button onClick={commit} disabled={draft.trim() === ''} className="btn-ghost px-3">
          <Plus className="size-4" />
          <span className="sr-only">新增標籤</span>
        </button>
      </div>
    </section>
  );
}
