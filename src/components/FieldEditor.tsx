import type { TaskStatus } from '../hooks/useTranslate';
import { formatCount } from '../lib/utils';
import { Banner, TranslateButton } from './ui';

export function FieldEditor({
  title,
  hint,
  value,
  placeholder,
  status,
  error,
  onChange,
  onTranslate,
  onCancel,
  minRows = 12,
}: {
  title: string;
  hint?: string;
  value: string;
  placeholder?: string;
  status: TaskStatus | undefined;
  error?: string;
  onChange: (value: string) => void;
  onTranslate: () => void;
  onCancel: () => void;
  minRows?: number;
}) {
  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold tracking-wide text-gold">{title}</h3>
          {hint && <p className="mt-1 text-xs text-dim">{hint}</p>}
        </div>
        <TranslateButton
          status={status}
          onTranslate={onTranslate}
          onCancel={onCancel}
          disabled={value.trim() === ''}
          label="一鍵翻譯"
        />
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="relative">
        <textarea
          value={value}
          rows={minRows}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? '內容為空…'}
          className="field resize-y font-normal leading-relaxed"
          style={{ minHeight: `${minRows * 1.6}rem` }}
        />
        <span className="pointer-events-none absolute right-3 bottom-2 text-xs text-dim/60 tabular-nums">
          {formatCount(value.length)} 字
        </span>
      </div>
    </section>
  );
}
