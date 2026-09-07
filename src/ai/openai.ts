/**
 * Any OpenAI-compatible chat-completions endpoint: OpenAI itself, OpenRouter,
 * DeepSeek, Groq, one-api, LM Studio, Ollama, and so on.
 *
 * Plain `fetch` again — the official SDK needs `dangerouslyAllowBrowser` to run
 * client-side at all, and adds weight for two endpoints we can call directly.
 */

import { PARAMETER_REJECTED, joinUrl, requestJson } from './http';
import {
  ChatMessage,
  ChatOptions,
  ModelInfo,
  OpenAISettings,
  Provider,
  ProviderError,
  ReasoningLevel,
} from './types';

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

interface ModelListResponse {
  data?: { id: string; name?: string }[];
  /** Some local servers return a bare array instead of the OpenAI envelope. */
  models?: { id?: string; name?: string }[];
}

/**
 * `reasoning_effort`, for the models that have one.
 *
 * `off` becomes `minimal` rather than nothing: the value that switches
 * reasoning off outright is spelled differently across model generations, and
 * asking for the least of it is understood by more of them.
 */
const REASONING_EFFORT: Record<Exclude<ReasoningLevel, 'auto'>, string> = {
  off: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/** Which optional parameters a single attempt carries. */
interface Attempt {
  json: boolean;
  reasoning: boolean;
}

/**
 * Send, dropping one optional parameter at a time as the endpoint refuses them.
 *
 * Two of them are optional now, and the servers in the wild disagree about
 * both: OpenAI returns 400 for `response_format` without the word JSON in the
 * prompt, LM Studio and Ollama return 400 or 422 for any parameter they have
 * never heard of, and every model that does not reason rejects
 * `reasoning_effort`. The retry costs a round trip on a genuinely bad request,
 * which is the right trade against failing outright on servers that have
 * implemented neither.
 *
 * The reasoning hint is dropped first because losing it costs only quality,
 * whereas losing JSON mode costs a parse — and the tolerant reader in `json.ts`
 * has to cope with prose anyway. A refusal is remembered for the life of the
 * provider so a whole-card run learns it once rather than once per section.
 */
async function sendWithParameterFallback<T>(
  send: (attempt: Attempt) => Promise<T>,
  wanted: Attempt,
  onRefused: (attempt: Attempt) => void,
): Promise<T> {
  const attempts: Attempt[] = [wanted];
  if (wanted.reasoning) attempts.push({ json: wanted.json, reasoning: false });
  if (wanted.json) attempts.push({ json: false, reasoning: false });

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const result = await send(attempt);
      // Only what a *successful* attempt left out counts as refused. A failure
      // never says which parameter it was about, and remembering the wrong one
      // would give up a hint the endpoint was perfectly happy with.
      if (attempt !== wanted) onRefused(attempt);
      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      if (!(error instanceof ProviderError)) throw error;
      // A 400 that is really a blocked prompt would fail again without the
      // parameter, so it is not worth a second round trip.
      if (error.filtered) throw error;
      const { status } = error.options;
      if (status === undefined || !PARAMETER_REJECTED.has(status)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function createOpenAIProvider(
  settings: OpenAISettings,
  reasoning: ReasoningLevel = 'auto',
): Provider {
  const baseUrl = settings.baseUrl.trim() || 'https://api.openai.com/v1';
  const apiKey = settings.apiKey.trim();
  const effort = reasoning === 'auto' ? undefined : REASONING_EFFORT[reasoning];

  /**
   * Set once the endpoint has been shown not to accept `reasoning_effort`, so a
   * 37-section card pays for that discovery once instead of thirty-seven times.
   * Changing the model or the endpoint builds a new provider, so the lesson is
   * unlearnt as soon as it might no longer hold.
   */
  let effortRefused = false;

  // Local servers (LM Studio, Ollama) accept requests with no key at all, so an
  // empty key is not an error here — only a missing base URL is.
  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  });

  return {
    id: 'openai',

    async listModels(signal) {
      const data = await requestJson<ModelListResponse>(
        joinUrl(baseUrl, 'models'),
        { method: 'GET', headers: headers(), signal },
        '取得模型清單',
      );

      const raw = data.data ?? data.models ?? [];
      const models: ModelInfo[] = raw
        .map((model) => ({ id: model.id ?? model.name ?? '', label: model.name }))
        .filter((model) => model.id !== '');

      if (models.length === 0) {
        throw new ProviderError('端點回應成功，但沒有列出任何模型。請手動輸入模型名稱。');
      }
      return models.sort((a, b) => a.id.localeCompare(b.id));
    },

    async chat(messages: ChatMessage[], options: ChatOptions = {}) {
      if (!settings.model.trim()) {
        throw new ProviderError('尚未選擇模型。請在「API 設定」中選擇或輸入模型名稱。');
      }

      const send = (attempt: Attempt) =>
        requestJson<ChatCompletion>(
          joinUrl(baseUrl, 'chat/completions'),
          {
            method: 'POST',
            headers: headers(),
            signal: options.signal,
            body: JSON.stringify({
              model: settings.model,
              messages,
              ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options.topP !== undefined ? { top_p: options.topP } : {}),
              ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
              ...(attempt.json ? { response_format: { type: 'json_object' } } : {}),
              ...(attempt.reasoning && effort ? { reasoning_effort: effort } : {}),
            }),
          },
          '翻譯請求',
        );

      const data = await sendWithParameterFallback(
        send,
        { json: options.json === true, reasoning: effort !== undefined && !effortRefused },
        (attempt) => {
          if (!attempt.reasoning) effortRefused = true;
        },
      );

      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';

      if (!text.trim()) {
        const reason = choice?.finish_reason;
        throw new ProviderError(
          reason === 'content_filter'
            ? '內容被服務端的過濾器攔截，未回傳翻譯結果。'
            : `模型沒有回傳內容${reason ? `（finish_reason: ${reason}）` : ''}。`,
          { retryable: reason !== 'content_filter', filtered: reason === 'content_filter' },
        );
      }
      return text;
    },
  };
}
