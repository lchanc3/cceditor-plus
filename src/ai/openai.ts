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

      const data = await requestJson<ChatCompletion>(
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
          }),
        },
        '翻譯請求',
      );

      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';

      if (!text.trim()) {
        const reason = choice?.finish_reason;
        throw new ProviderError(
          reason === 'content_filter'
            ? '內容被服務端的過濾器攔截，未回傳翻譯結果。'
            : `模型沒有回傳內容${reason ? `（finish_reason: ${reason}）` : ''}。`,
          { retryable: reason !== 'content_filter' },
        );
      }
      return text;
    },
  };
}
