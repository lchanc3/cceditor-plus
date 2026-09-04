import { ProviderError } from './types';

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
    throw new ProviderError(`${context}失敗（HTTP ${response.status}）：${extractError(body)}`, {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
    });
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProviderError(`${context}回應不是有效的 JSON。`);
  }
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
