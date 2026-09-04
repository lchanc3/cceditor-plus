/**
 * Translation tasks.
 *
 * The prompts are carried over from the previous version — they were well
 * tuned, particularly the instruction to leave {{char}} / {{user}} macros alone
 * and to emit nothing but the translation. What is new here is cancellation,
 * retry on transient failures, and a concurrency cap for whole-card runs.
 */

import { ChatMessage, Provider, ProviderError } from './types';

export interface TranslateOptions {
  targetLang: string;
  temperature?: number;
  signal?: AbortSignal;
}

const systemPrompt = (targetLang: string) => `你是一位專業的角色設定翻譯。請將以下內容翻譯成${targetLang}。

【嚴格指令】：
1. 保持角色的語氣與性格特徵。
2. 絕對保留所有技術性格式與變數（如 {{char}}, {{user}}, <START>, {{original}} 等），不可翻譯或改寫。
3. 保留原文的換行與段落結構。
4. 絕不輸出任何解釋、開場白或是結尾語（例如：「這是一份翻譯...」）。
5. 只允許輸出純粹的翻譯內容。`;

const MAX_ATTEMPTS = 3;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function chatWithRetry(
  provider: Provider,
  messages: ChatMessage[],
  options: TranslateOptions,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await provider.chat(messages, {
        temperature: options.temperature ?? 0.3,
        topP: 0.8,
        signal: options.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      lastError = error;
      const retryable = error instanceof ProviderError && error.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      // Back off before trying again: 0.8s, then 1.6s.
      await delay(800 * attempt, options.signal);
    }
  }
  throw lastError;
}

/** Strip a wrapper the model added despite being told not to. */
function cleanOutput(text: string): string {
  let out = text.trim();
  const fence = out.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1].trim();
  return out;
}

export async function translateText(
  provider: Provider,
  content: string,
  options: TranslateOptions,
): Promise<string> {
  if (!content.trim()) return content;

  const text = await chatWithRetry(
    provider,
    [
      { role: 'system', content: systemPrompt(options.targetLang) },
      { role: 'user', content: `待翻譯內容：\n"""\n${content}\n"""` },
    ],
    options,
  );
  return cleanOutput(text);
}

export async function translateKeywords(
  provider: Provider,
  keywords: string[],
  options: TranslateOptions,
): Promise<string[]> {
  const valid = keywords.map((k) => k.trim()).filter((k) => k !== '');
  if (valid.length === 0) return [];

  const text = await chatWithRetry(
    provider,
    [
      {
        role: 'user',
        content: `請將以下關鍵字清單翻譯成${options.targetLang}，並以逗號分隔回傳。除了翻譯的語言實體外，絕不輸出任何解釋或句子。
例如：apple, tree -> 蘋果, 樹

待翻譯關鍵字：
${valid.join(', ')}`,
      },
    ],
    { ...options, temperature: 0.1 },
  );

  return cleanOutput(text)
    .split(/[,、，]/)
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

/**
 * Run tasks with a small concurrency cap.
 *
 * Whole-card translation can be 20+ requests; firing them all at once gets you
 * rate-limited by every hosted provider and swamps a local one.
 */
export async function runPooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 3,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (signal?.aborted) return;
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export function describeError(error: unknown): string {
  if ((error as Error)?.name === 'AbortError') return '已取消。';
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error) return error.message;
  return '發生未知錯誤。';
}
