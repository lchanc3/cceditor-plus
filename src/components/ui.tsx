import { AlertCircle, Check, Languages, Loader2, X, XCircle } from 'lucide-react';
import { ReactNode, useEffect } from 'react';

import type { TaskStatus } from '../hooks/useTranslate';
import { cn } from '../lib/utils';

export function Banner({
  tone = 'error',
  children,
  onDismiss,
}: {
  tone?: 'error' | 'warn' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    error: 'border-red-500/40 bg-red-500/10 text-red-300',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    info: 'border-gold/30 bg-gold/5 text-gold',
  } as const;

  return (
    <div className={cn('flex items-start gap-3 rounded border px-4 py-3 text-sm', tones[tone])}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="tap -m-2 shrink-0 p-2 opacity-70 hover:opacity-100">
          <X className="size-4" />
          <span className="sr-only">關閉</span>
        </button>
      )}
    </div>
  );
}

/**
 * Translate control. Deliberately always visible — the previous build hid these
 * behind `group-hover`, which on a touch device means "never".
 */
export function TranslateButton({
  status,
  onTranslate,
  onCancel,
  label = '翻譯',
  disabled,
  className,
}: {
  status: TaskStatus | undefined;
  onTranslate: () => void;
  onCancel: () => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  if (status === 'running') {
    return (
      <button onClick={onCancel} className={cn('btn-quiet text-gold', className)}>
        <Loader2 className="size-3.5 animate-spin" />
        取消
      </button>
    );
  }

  return (
    <button
      onClick={onTranslate}
      disabled={disabled}
      className={cn('btn-quiet', status === 'error' && 'text-red-400', className)}
    >
      {status === 'error' ? (
        <XCircle className="size-3.5" />
      ) : status === 'done' ? (
        <Check className="size-3.5 text-gold" />
      ) : (
        <Languages className="size-3.5" />
      )}
      {status === 'error' ? '重試' : label}
    </button>
  );
}

/**
 * A bottom sheet on phones, a centred dialog from `sm` up. `max-h-[90dvh]` uses
 * dynamic viewport height so the mobile browser chrome cannot clip the footer.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Stop the page behind the sheet from scrolling with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:max-w-lg sm:rounded-lg"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg text-gold">{title}</h2>
          <button onClick={onClose} className="tap -m-2 p-2 text-dim hover:text-body">
            <X className="size-5" />
            <span className="sr-only">關閉</span>
          </button>
        </header>

        <div
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5"
          style={{ paddingBottom: footer ? undefined : 'max(1.25rem, env(safe-area-inset-bottom))' }}
        >
          {children}
        </div>

        {footer && (
          <footer
            className="flex justify-end gap-3 border-t border-line bg-ink/50 px-5 py-4"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-line-bright px-4 py-10 text-center text-sm text-dim">
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin', className)} />;
}
