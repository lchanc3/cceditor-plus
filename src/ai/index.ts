import { createGeminiProvider } from './gemini';
import { createOpenAIProvider } from './openai';
import { AISettings, DEFAULT_SETTINGS, Provider } from './types';

export * from './types';
export { createGeminiProvider } from './gemini';
export { createOpenAIProvider } from './openai';
export * from './tasks';

export function createProvider(settings: AISettings): Provider {
  return settings.provider === 'openai'
    ? createOpenAIProvider(settings.openai)
    : createGeminiProvider(settings.gemini);
}

const STORAGE_KEY = 'cceditor.ai-settings.v1';

/**
 * Settings — API keys included — live only in this browser. There is no server
 * component and no build-time key, which is what lets the same build be hosted
 * on GitHub Pages without leaking anything.
 */
export function loadSettings(): AISettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AISettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      gemini: { ...DEFAULT_SETTINGS.gemini, ...parsed.gemini },
      openai: { ...DEFAULT_SETTINGS.openai, ...parsed.openai },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AISettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota. Losing the preference is survivable.
  }
}

export function currentModel(settings: AISettings): string {
  return settings.provider === 'openai' ? settings.openai.model : settings.gemini.model;
}

export function hasCredentials(settings: AISettings): boolean {
  if (settings.provider === 'gemini') return settings.gemini.apiKey.trim() !== '';
  // Local OpenAI-compatible servers legitimately need no key.
  return settings.openai.baseUrl.trim() !== '';
}
