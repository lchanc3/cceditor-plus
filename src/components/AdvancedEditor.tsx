import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import type { CardFields } from '../card';
import { splitKeys } from '../state/cardStore';

/**
 * The V2/V3 fields the old editor had no UI for at all. They were preserved on
 * import but there was no way to see or change them.
 */
export function AdvancedEditor({
  fields,
  onChange,
}: {
  fields: CardFields;
  onChange: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void;
}) {
  return (
    <div className="space-y-7">
      <section className="space-y-2">
        <label className="label" htmlFor="system-prompt">
          系統提示詞 (system_prompt)
        </label>
        <p className="text-xs text-dim">會覆蓋前端的預設主提示詞。留空表示不覆蓋。</p>
        <textarea
          id="system-prompt"
          rows={5}
          className="field resize-y leading-relaxed"
          value={fields.system_prompt}
          onChange={(event) => onChange('system_prompt', event.target.value)}
        />
      </section>

      <section className="space-y-2">
        <label className="label" htmlFor="post-history">
          歷史後指令 (post_history_instructions)
        </label>
        <p className="text-xs text-dim">插入在對話歷史之後，通常用來強化角色一致性（Jailbreak 欄位）。</p>
        <textarea
          id="post-history"
          rows={5}
          className="field resize-y leading-relaxed"
          value={fields.post_history_instructions}
          onChange={(event) => onChange('post_history_instructions', event.target.value)}
        />
      </section>

      <section className="space-y-3">
        <span className="label">群組專用開場白（V3）</span>
        <p className="-mt-1 text-xs text-dim">只有在群組聊天中才會出現的開場白。</p>
        {fields.group_only_greetings.map((greeting, index) => (
          <div key={index} className="flex gap-2">
            <textarea
              rows={2}
              className="field flex-1 resize-y text-sm"
              value={greeting}
              onChange={(event) => {
                const next = [...fields.group_only_greetings];
                next[index] = event.target.value;
                onChange('group_only_greetings', next);
              }}
            />
            <button
              onClick={() =>
                onChange(
                  'group_only_greetings',
                  fields.group_only_greetings.filter((_, i) => i !== index),
                )
              }
              className="btn-quiet self-start hover:text-red-400"
              aria-label="移除"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange('group_only_greetings', [...fields.group_only_greetings, ''])}
          className="btn-ghost px-3 text-sm"
        >
          <Plus className="size-4" />
          新增群組開場白
        </button>
      </section>

      <ListField
        label="來源 (source, V3)"
        hint="這張卡的原始出處網址，可填多筆。"
        values={fields.source ?? []}
        placeholder="https://…"
        onChange={(values) => onChange('source', values)}
      />

      <section className="space-y-2">
        <span className="label">擴充欄位 (extensions)</span>
        <p className="text-xs text-dim">
          前端專屬設定，例如 talkativeness、depth_prompt。內容原樣保留，除非你在這裡改動。
        </p>
        <JsonField
          value={fields.extensions}
          onChange={(value) => onChange('extensions', value)}
        />
      </section>
    </div>
  );
}

function ListField({
  label,
  hint,
  values,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const added = splitKeys(draft).filter((value) => !values.includes(value));
    if (added.length > 0) onChange([...values, ...added]);
    setDraft('');
  };

  return (
    <section className="space-y-2">
      <span className="label">{label}</span>
      {hint && <p className="-mt-1 text-xs text-dim">{hint}</p>}
      <ul className="space-y-1.5">
        {values.map((value, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate rounded border border-line bg-field px-3 py-2">
              {value}
            </span>
            <button
              onClick={() => onChange(values.filter((_, i) => i !== index))}
              className="btn-quiet hover:text-red-400"
              aria-label="移除"
            >
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          className="field flex-1 text-sm"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <button onClick={commit} disabled={draft.trim() === ''} className="btn-ghost px-3">
          <Plus className="size-4" />
          <span className="sr-only">新增</span>
        </button>
      </div>
    </section>
  );
}

/** Edits a raw JSON object, refusing to commit anything that will not parse. */
function JsonField({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState('');

  return (
    <div className="space-y-2">
      <textarea
        rows={8}
        spellCheck={false}
        className="field resize-y font-mono text-sm leading-relaxed"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text || '{}');
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              setError('必須是一個 JSON 物件。');
              return;
            }
            setError('');
            onChange(parsed as Record<string, unknown>);
          } catch (parseError) {
            setError(`JSON 格式錯誤：${(parseError as Error).message}`);
          }
        }}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
