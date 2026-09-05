export type ProviderId = 'gemini' | 'openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /**
   * Ask the endpoint to emit strict JSON. Advisory only: several
   * OpenAI-compatible servers ignore it, and some reject it outright, so the
   * response still goes through the tolerant parser in `json.ts`.
   */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface Provider {
  readonly id: ProviderId;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  /** Fetch the endpoint's model list so the settings dialog can offer a picker. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface GeminiSettings {
  apiKey: string;
  model: string;
}

export interface OpenAISettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AISettings {
  provider: ProviderId;
  gemini: GeminiSettings;
  openai: OpenAISettings;
  targetLang: string;
  temperature: number;
  /**
   * Requests per minute the endpoint will tolerate. 0 means unlimited.
   *
   * Free Gemini tiers are quota'd per minute rather than per token, so a long
   * card is throttled halfway through unless the requests are spaced out. The
   * default leaves headroom under flash-lite's 15.
   */
  requestsPerMinute: number;
}

export const DEFAULT_SETTINGS: AISettings = {
  provider: 'gemini',
  gemini: { apiKey: '', model: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  targetLang: '繁體中文',
  temperature: 0.3,
  requestsPerMinute: 10,
};

/** Endpoints people commonly point the OpenAI-compatible provider at. */
export const OPENAI_PRESETS: { label: string; baseUrl: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'LM Studio（本機）', baseUrl: 'http://localhost:1234/v1' },
  { label: 'Ollama（本機）', baseUrl: 'http://localhost:11434/v1' },
];

export const TARGET_LANGUAGES = [
  '繁體中文',
  '简体中文',
  'English',
  '日本語',
  '한국어',
] as const;

/**
 * Thrown for every provider failure, with a message already written for the
 * user. `retryable` drives the automatic retry in `tasks.ts`.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      filtered?: boolean;
      /** How long the server asked us to wait, from its Retry-After header. */
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  /**
   * A content filter rejected this particular text.
   *
   * The distinction drives whole-card translation: a filtered section says
   * nothing about the other nineteen, whereas a bad key or a wrong model name
   * will fail every one of them identically. Status codes cannot carry this —
   * Gemini answers a bad key with 400, the same code an endpoint uses to reject
   * an unknown parameter.
   */
  get filtered(): boolean {
    return this.options.filtered ?? false;
  }

  /**
   * The server answered and asked us to come back later — a rate limit, or an
   * overloaded model.
   *
   * Distinct from `retryable`, which is also true for a connection that never
   * reached a server at all. That difference is what keeps a whole-card run
   * alive: being throttled says the endpoint works and we are going too fast,
   * whereas a connection failure says nothing will work. Free Gemini tiers are
   * measured in requests per minute, so a 37-section card meets this routinely.
   */
  get transient(): boolean {
    return this.options.status !== undefined && this.retryable;
  }
}
