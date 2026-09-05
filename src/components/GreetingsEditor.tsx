import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';

import type { TaskStatus } from '../hooks/useTranslate';
import { formatCount } from '../lib/utils';
import { Banner, EmptyHint, TranslateButton } from './ui';

export function GreetingsEditor({
  greetings,
  status,
  errors,
  onChange,
  onAdd,
  onRemove,
  onMove,
  onTranslate,
  onCancel,
}: {
  greetings: string[];
  status: Record<string, TaskStatus>;
  errors: Record<string, string>;
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onTranslate: (index: number) => void;
  onCancel: (index: number) => void;
}) {
  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold tracking-wide text-gold">其他開場白</h3>
          <p className="mt-1 text-xs text-dim">主要開場白在「開場白」分頁。這裡是使用者可切換的備選。</p>
        </div>
        <button onClick={onAdd} className="btn-ghost shrink-0 px-3 text-sm">
          <Plus className="size-4" />
          新增
        </button>
      </header>

      {greetings.length === 0 ? (
        <EmptyHint>目前沒有其他開場白</EmptyHint>
      ) : (
        <ol className="space-y-6">
          {greetings.map((greeting, index) => {
            const key = `greeting:${index}`;
            return (
              <li key={index} id={`greeting-${index}`} className="scroll-mt-4 space-y-2">
                {/* Controls are always visible: on a touch screen there is no hover. */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-dim">#{index + 1}</span>
                  <div className="flex items-center gap-1">
                    <TranslateButton
                      status={status[key]}
                      onTranslate={() => onTranslate(index)}
                      onCancel={() => onCancel(index)}
                      disabled={greeting.trim() === ''}
                    />
                    <button
                      onClick={() => onMove(index, -1)}
                      disabled={index === 0}
                      className="btn-quiet"
                      aria-label="上移"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      onClick={() => onMove(index, 1)}
                      disabled={index === greetings.length - 1}
                      className="btn-quiet"
                      aria-label="下移"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button
                      onClick={() => onRemove(index)}
                      className="btn-quiet hover:text-red-400"
                      aria-label="移除這則開場白"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                {errors[key] && <Banner tone="error">{errors[key]}</Banner>}

                <div className="relative">
                  <textarea
                    rows={6}
                    className="field resize-y leading-relaxed"
                    value={greeting}
                    onChange={(event) => onChange(index, event.target.value)}
                    placeholder="輸入開場白內容…"
                  />
                  <span className="pointer-events-none absolute right-3 bottom-2 text-xs text-dim/60 tabular-nums">
                    {formatCount(greeting.length)} 字
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
