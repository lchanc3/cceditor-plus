/**
 * Google Gemini via the REST API.
 *
 * Uses plain `fetch` rather than @google/genai: the SDK added a large dependency
 * to the browser bundle for two endpoints, and a static host has no server to
 * proxy through anyway.
 */

import { joinUrl, requestJson } from './http';
import { ChatMessage, ChatOptions, GeminiSettings, Provider, ProviderError } from './types';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Character cards routinely trip the default filters on content that is
 * perfectly ordinary for fiction, so every category is turned down. Carried
 * over from the previous implementation.
 */
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

interface GeminiModelList {
  models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
}

const FINISH_REASON_HINTS: Record<string, string> = {
  SAFETY: '內容被 Gemini 的安全過濾器攔截。可改用 OpenAI 相容端點，或換一個模型。',
  RECITATION: '回應因疑似重複公開內容而被攔截。',
  MAX_TOKENS: '回應長度超過模型上限，請把內容拆成幾段再翻譯。',
  PROHIBITED_CONTENT: '內容被 Gemini 判定為禁止內容而未回傳。',
};

export function createGeminiProvider(settings: GeminiSettings): Provider {
  const apiKey = settings.apiKey.trim();

  const requireKey = () => {
    if (!apiKey) {
      throw new ProviderError('尚未設定 Gemini API Key。請在「API 設定」中填入你自己的金鑰。');
    }
  };

  return {
    id: 'gemini',

    async listModels(signal) {
      requireKey();
      const data = await requestJson<GeminiModelList>(
        `${API_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
        { method: 'GET', signal },
        '取得 Gemini 模型清單',
      );
      return (data.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
        .map((model) => ({
          // The API returns "models/gemini-2.5-flash"; the generate call wants
          // the bare id.
          id: model.name.replace(/^models\//, ''),
          label: model.displayName,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async chat(messages: ChatMessage[], options: ChatOptions = {}) {
      requireKey();

      // Gemini keeps the system prompt out of the turn list.
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const url = joinUrl(
        API_BASE,
        `models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      );

      const data = await requestJson<GeminiResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: options.signal,
          body: JSON.stringify({
            contents: turns,
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            safetySettings: SAFETY_SETTINGS,
            generationConfig: {
              ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options.topP !== undefined ? { topP: options.topP } : {}),
              ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
              ...(options.json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        },
        'Gemini 請求',
      );

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

      if (!text.trim()) {
        const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? '';
        throw new ProviderError(
          FINISH_REASON_HINTS[reason] ?? `Gemini 沒有回傳內容${reason ? `（原因：${reason}）` : ''}。`,
          { retryable: reason === '' },
        );
      }
      return text;
    },
  };
}
