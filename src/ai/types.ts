export type ProviderId = 'gemini' | 'openai';

/**
 * How hard the model should think before it answers.
 *
 * `auto` sends no parameter at all and leaves the decision to the model's own
 * default — what every version before this one did, and the only setting every
 * endpoint is guaranteed to accept. The rest are advisory in the same way
 * `json` is: each provider maps them onto its own parameter, and an endpoint
 * that has never heard of that parameter has the request retried without it.
 */
export type ReasoningLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';

export const REASONING_LEVELS: { value: ReasoningLevel; label: string }[] = [
  { value: 'auto', label: '模型預設' },
  { value: 'off', label: '關閉思考' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

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
   * How hard the model thinks, on every request the app makes — the prose
   * translations and the glossary passes alike.
   *
   * One setting rather than one per task on purpose. Splitting them is
   * defensible on paper (deciding a name is recall, not composition) but it
   * buys a second knob nobody can calibrate without running both, and the
   * glossary is what the prose is then pinned to: thinking harder about the
   * names and less about the sentences gets the dependency backwards.
   */
  reasoning: ReasoningLevel;
  /**
   * Requests per minute the endpoint will tolerate. 0 means unlimited.
   *
   * Free Gemini tiers are quota'd per minute rather than per token, so a long
   * card is throttled halfway through unless the requests are spaced out. The
   * default leaves headroom under flash-lite's 15.
   */
  requestsPerMinute: number;

  /**
   * How many sections a whole-card run translates at once.
   *
   * This, not `requestsPerMinute`, is what a long card's wall clock actually
   * depends on: three workers against replies of half a minute settle at around
   * five requests a minute on their own, so a per-minute cap set above that is
   * never reached and raising it changes nothing. The pacing gate is a brake;
   * this is the throttle.
   */
  concurrency: number;
}

export const DEFAULT_SETTINGS: AISettings = {
  provider: 'gemini',
  gemini: { apiKey: '', model: 'gemini-3.5-flash-lite' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  targetLang: '繁體中文',
  temperature: 0.3,
  reasoning: 'auto',
  requestsPerMinute: 10,
  concurrency: 3,
};

/** Endpoints people commonly point the OpenAI-compatible provider at. */
export const OPENAI_PRESETS: { label: string; baseUrl: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'NanoGPT', baseUrl: 'https://nano-gpt.com/api/v1' },
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
      tooLong?: boolean;
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
   * The model had no room left to answer in — Gemini's `MAX_TOKENS` with an
   * empty reply, which is a long section rather than a rejected one.
   *
   * It behaves like a filtered section for the run: retrying the same text
   * against the same budget produces the same nothing, and it says nothing
   * about the other nineteen sections, so it must not count towards the
   * failures that stop a run. It is separate from `filtered` only because
   * telling somebody their card was blocked, when it was merely too long for
   * one section, sends them looking for the wrong fix.
   */
  get tooLong(): boolean {
    return this.options.tooLong ?? false;
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
