/**
 * Any OpenAI-compatible chat-completions endpoint: OpenAI itself, OpenRouter,
 * DeepSeek, Groq, one-api, LM Studio, Ollama, and so on.
 *
 * Plain `fetch` again — the official SDK needs `dangerouslyAllowBrowser` to run
 * client-side at all, and adds weight for two endpoints we can call directly.
 */

import { joinUrl, requestJson } from './http';
import { ChatMessage, ChatOptions, ModelInfo, OpenAISettings, Provider, ProviderError } from './types';

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

interface ModelListResponse {
  data?: { id: string; name?: string }[];
  /** Some local servers return a bare array instead of the OpenAI envelope. */
  models?: { id?: string; name?: string }[];
}

/**
 * Statuses that mean "this endpoint did not like a parameter", as opposed to
 * "this request was wrong". OpenAI itself returns 400 when `response_format` is
 * used without the word JSON in the prompt; LM Studio, Ollama and assorted
 * proxies return 400 or 422 for the parameter simply being unknown to them.
 */
const PARAMETER_REJECTED = new Set([400, 422]);

/**
 * Try the request with `response_format`, and once more without it if the
 * endpoint refused. The retry costs a round trip on a genuinely bad request,
 * which is the right trade: the alternative is a hard failure on every server
 * that has not implemented JSON mode, and the response goes through the
 * tolerant parser either way.
 */
async function sendWithJsonFallback<T>(send: (json: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(true);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    if (!(error instanceof ProviderError)) throw error;
    // A 400 that is really a blocked prompt would fail again without the
    // parameter, so it is not worth a second round trip.
    if (error.filtered) throw error;
    const { status } = error.options;
    if (status === undefined || !PARAMETER_REJECTED.has(status)) throw error;
    return send(false);
  }
}

export function createOpenAIProvider(settings: OpenAISettings): Provider {
  const baseUrl = settings.baseUrl.trim() || 'https://api.openai.com/v1';
  const apiKey = settings.apiKey.trim();

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

      const send = (json: boolean) =>
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
              ...(json ? { response_format: { type: 'json_object' } } : {}),
            }),
          },
          '翻譯請求',
        );

      const data = await (options.json ? sendWithJsonFallback(send) : send(false));

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
