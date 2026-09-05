import { ProviderError } from './types';

/** How the common endpoints word a content-policy rejection in an error body. */
const CONTENT_POLICY = /content[_ -]?(?:filter|policy)|responsible ?ai|safety/i;

/** HTTP statuses worth retrying: rate limits and transient server errors. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // A browser fetch that rejects outright is nearly always CORS or an
    // unreachable host; the status-code path below never gets a chance to run.
    throw new ProviderError(
      `${context}連線失敗。請確認網址正確、服務正在執行，且該端點允許瀏覽器跨來源請求（CORS）。`,
      { retryable: true, cause: error },
    );
  }

  const body = await response.text();

  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    const detail = extractError(body);
    throw new ProviderError(`${context}失敗（HTTP ${response.status}）：${detail}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      // Azure OpenAI and several proxies report a blocked prompt as a 400
      // rather than a finish_reason. Recognising it keeps one blocked section
      // from being mistaken for a broken endpoint and stopping a whole run.
      filtered: response.status === 400 && CONTENT_POLICY.test(detail),
    });
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProviderError(`${context}回應不是有效的 JSON。`);
  }
}

/**
 * `Retry-After` in either of the forms RFC 9110 allows: a count of seconds, or
 * an HTTP date. Honouring it beats guessing, since the server knows when its
 * window rolls over.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300) * 1000;

  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 300_000);
}

/** Pull the human-readable part out of the many error envelopes in the wild. */
function extractError(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    /* fall through to the raw body */
  }
  return body.slice(0, 300) || '（沒有錯誤內容）';
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
