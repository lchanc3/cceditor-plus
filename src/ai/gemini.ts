/**
 * Google Gemini via the REST API.
 *
 * Uses plain `fetch` rather than @google/genai: the SDK added a large dependency
 * to the browser bundle for two endpoints, and a static host has no server to
 * proxy through anyway.
 */

import { PARAMETER_REJECTED, joinUrl, requestJson } from './http';
import {
  ChatMessage,
  ChatOptions,
  GeminiSettings,
  Provider,
  ProviderError,
  ReasoningLevel,
} from './types';

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

type NamedLevel = Exclude<ReasoningLevel, 'auto'>;

/**
 * Gemini has asked for the thinking level in two different shapes.
 *
 * The 2.x models take a token budget: 0 turns thinking off, and the flash
 * models cap out at 24576. Gemini 3 replaced that with a named level, and does
 * not let thinking be turned off at all — so `off` is mapped to the lowest
 * level there rather than pretended to work.
 *
 * Which shape an endpoint wants is guessed from the model id and confirmed by
 * whether it complains, because the id is all we have: the model list gives no
 * capabilities, and a proxy may serve either family under a name of its own.
 */
const THINKING_BUDGET: Record<NamedLevel, number> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
};

const THINKING_LEVEL: Record<NamedLevel, string> = {
  off: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

function thinkingConfig(model: string, level: ReasoningLevel): Record<string, unknown> | undefined {
  if (level === 'auto') return undefined;
  return /gemini-[3-9]/.test(model)
    ? { thinkingLevel: THINKING_LEVEL[level] }
    : { thinkingBudget: THINKING_BUDGET[level] };
}

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

/**
 * Send with the thinking parameter, and once more without it if the endpoint
 * refused it.
 *
 * The guess in `thinkingConfig` is the reason this exists: an older proxy, a
 * model whose family cannot be read off its name, a gateway that forwards
 * `generationConfig` verbatim to something else — any of them answers an
 * unknown field with a 400. Degrading to the model's own default is the right
 * outcome there. A translation run must not stop because a hint was refused.
 */
async function sendWithThinkingFallback<T>(
  send: (withThinking: boolean) => Promise<T>,
  withThinking: boolean,
  onRefused: () => void,
): Promise<T> {
  if (!withThinking) return send(false);
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

    const result = await send(false);
    // Only a *successful* retry proves the parameter was the problem. A 400 on
    // its own never says which field it was about, and remembering the wrong
    // one would give up a hint the endpoint was perfectly happy with.
    onRefused();
    return result;
  }
}

export function createGeminiProvider(
  settings: GeminiSettings,
  reasoning: ReasoningLevel = 'auto',
): Provider {
  const apiKey = settings.apiKey.trim();
  const thinking = thinkingConfig(settings.model, reasoning);

  /**
   * Set once the endpoint has refused the thinking parameter, so a 37-section
   * card pays for that discovery once instead of thirty-seven times — the cost
   * is not only the round trip but a slot in a per-minute quota. A refusal that
   * was really about something else, a mistyped model name, is forgotten as
   * soon as it is fixed: changing the settings builds a new provider.
   */
  let thinkingRefused = false;

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

      const send = (withThinking: boolean) =>
        requestJson<GeminiResponse>(
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
                ...(withThinking && thinking ? { thinkingConfig: thinking } : {}),
              },
            }),
          },
          'Gemini 請求',
        );

      const data = await sendWithThinkingFallback(send, thinking !== undefined && !thinkingRefused, () => {
        thinkingRefused = true;
      });

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

      if (!text.trim()) {
        const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? '';
        // Running out of room is not a rejection. It is handled the same way —
        // this section only, no retry, no vote towards stopping the run — but
        // calling it a content filter sends the reader looking for the wrong
        // fix, when what they need is a shorter section or a bigger budget.
        const tooLong = reason === 'MAX_TOKENS';

        throw new ProviderError(
          FINISH_REASON_HINTS[reason] ?? `Gemini 沒有回傳內容${reason ? `（原因：${reason}）` : ''}。`,
          // A named reason is always about this particular text — safety,
          // recitation, length. No reason at all is an unexplained empty
          // response, which is worth another try.
          { retryable: reason === '', filtered: reason !== '' && !tooLong, tooLong },
        );
      }
      return text;
    },
  };
}
