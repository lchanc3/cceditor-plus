import { CheckCircle2, RotateCcw, X } from 'lucide-react';

import type { SectionResult } from '../ai';
import type { TranslationIssue } from '../glossary';
import { cn } from '../lib/utils';

export interface RunReport {
  results: SectionResult[];
  issues: Record<string, TranslationIssue[]>;
}

const ISSUE_LABELS: Record<TranslationIssue['kind'], string> = {
  macro: '巨集',
  structure: '結構',
  script: '字體',
  note: '夾註',
};

/**
 * What the last translation run did.
 *
 * Failures are listed rather than thrown away, because partial success is the
 * normal outcome: character cards trip content filters routinely, and nineteen
 * good translations should not be lost to the twentieth. The retry button is
 * limited to what failed — re-running everything would translate the finished
 * sections a second time, which costs tokens and degrades them.
 */
export function TranslateReport({
  report,
  onRetry,
  onDismiss,
  onJump,
}: {
  report: RunReport;
  onRetry: (paths: string[]) => void;
  onDismiss: () => void;
  onJump: (path: string) => void;
}) {
  const { results, issues } = report;
  const done = results.filter((r) => r.text !== undefined);
  const failed = results.filter((r) => r.error !== undefined && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const flagged = results.filter((r) => (issues[r.path]?.length ?? 0) > 0);

  const tone = failed.length > 0 ? 'error' : flagged.length > 0 ? 'warn' : 'ok';
  const tones = {
    error: 'border-red-500/40 bg-red-500/10',
    warn: 'border-amber-500/40 bg-amber-500/10',
    ok: 'border-gold/30 bg-gold/5',
  } as const;

  const retryable = [...failed, ...skipped].map((r) => r.path);

  return (
    <div className={cn('rounded border px-4 py-3 text-sm', tones[tone])}>
      <div className="flex items-start gap-3">
        {tone === 'ok' && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-gold" />}

        <div className="min-w-0 flex-1 space-y-3">
          <p className="font-bold">
            翻譯完成：{done.length} 段成功
            {failed.length > 0 && `，${failed.length} 段失敗`}
            {skipped.length > 0 && `，${skipped.length} 段未嘗試`}
            {flagged.length > 0 && `，${flagged.length} 段有疑慮`}
          </p>

          {skipped.length > 0 && (
            <p className="text-xs text-dim">
              連續的錯誤看起來會影響每一段（金鑰、模型名稱或連線問題），因此提前停止，沒有把剩下的請求送出去。
            </p>
          )}

          {failed.length > 0 && (
            <ul className="space-y-1.5">
              {failed.map((result) => (
                <li key={result.path} className="text-xs">
                  <button
                    onClick={() => onJump(result.path)}
                    className="text-gold underline underline-offset-2"
                  >
                    {result.label}
                  </button>
                  <span className="text-dim">
                    {result.filtered ? '（內容過濾）' : ''} — {result.error}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {flagged.length > 0 && (
            <div className="space-y-1.5">
              {flagged.map((result) => (
                <div key={result.path} className="text-xs">
                  <button
                    onClick={() => onJump(result.path)}
                    className="text-gold underline underline-offset-2"
                  >
                    {result.label}
                  </button>
                  <ul className="mt-1 ml-3 space-y-1 text-dim">
                    {issues[result.path].map((issue, i) => (
                      <li key={i}>
                        <span className="text-amber-300">[{ISSUE_LABELS[issue.kind]}]</span>{' '}
                        {issue.message}
                        {issue.excerpt && (
                          <span className="mt-0.5 block text-dim/70">{issue.excerpt}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="text-xs text-dim/70">
                這些是自動檢查的結果，譯文沒有被自動改動——請自行判斷是否要修。
              </p>
            </div>
          )}

          {retryable.length > 0 && (
            <button onClick={() => onRetry(retryable)} className="btn-quiet">
              <RotateCcw className="size-3.5" />
              只重試這 {retryable.length} 段
            </button>
          )}
        </div>

        <button onClick={onDismiss} className="tap -m-2 shrink-0 p-2 opacity-70 hover:opacity-100">
          <X className="size-4" />
          <span className="sr-only">關閉</span>
        </button>
      </div>
    </div>
  );
}
