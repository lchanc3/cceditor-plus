import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AISettings,
  cardContext,
  createProvider,
  createRateGate,
  decideTranslations,
  describeError,
  extractTerms,
  sectionContext,
  translateCard,
  translateKeywords,
  translateText,
} from '../ai';
import type { CardFields } from '../card';
import type { GlossaryTerm, TranslationMeta } from '../glossary';

export type TaskStatus = 'idle' | 'running' | 'done' | 'error';

export interface TaskProgress {
  done: number;
  total: number;
}

/** The whole-card passes get fixed slots, since only one of each can run. */
export const EXTRACT_KEY = 'glossary:extract';
export const DECIDE_KEY = 'glossary:decide';
export const CARD_KEY = 'card';

/**
 * Tracks one translation per UI slot (a field name, `greeting:2`, `lore:0`…),
 * so several can run at once and each shows its own state.
 *
 * The glossary and the card are hook arguments rather than per-call ones so
 * that every translation carries them automatically — the same reasoning that
 * puts the "only send terms this text contains" filter inside `translateText`.
 * A call site cannot forget what it never has to pass.
 *
 * The task key doubles as the section path, so the card context for one field
 * can be worked out from the key alone.
 */
export function useTranslate(
  settings: AISettings,
  meta: TranslationMeta,
  fields: CardFields | null,
) {
  const [status, setStatus] = useState<Record<string, TaskStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const controllers = useRef(new Map<string, AbortController>());

  // Anything in flight when the component unmounts should stop, not leak.
  useEffect(() => {
    const inFlight = controllers.current;
    return () => {
      inFlight.forEach((controller) => controller.abort());
      inFlight.clear();
    };
  }, []);

  const provider = useMemo(() => createProvider(settings), [settings]);

  // One budget for the endpoint, shared by every task: the glossary passes and
  // a whole-card run draw on the same per-minute quota.
  const gate = useMemo(
    () => createRateGate(settings.requestsPerMinute),
    [settings.requestsPerMinute],
  );

  const run = useCallback(
    async <T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
      controllers.current.get(key)?.abort();
      const controller = new AbortController();
      controllers.current.set(key, controller);

      setStatus((prev) => ({ ...prev, [key]: 'running' }));
      setErrors((prev) => ({ ...prev, [key]: '' }));
      setProgress((prev) => {
        if (prev[key] === undefined) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      try {
        const result = await task(controller.signal);
        setStatus((prev) => ({ ...prev, [key]: 'done' }));
        return result;
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          setStatus((prev) => ({ ...prev, [key]: 'idle' }));
          return null;
        }
        setStatus((prev) => ({ ...prev, [key]: 'error' }));
        setErrors((prev) => ({ ...prev, [key]: describeError(error) }));
        return null;
      } finally {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      }
    },
    [],
  );

  const step = useCallback(
    (key: string) => (done: number, total: number) =>
      setProgress((prev) => ({ ...prev, [key]: { done, total } })),
    [],
  );

  const translate = useCallback(
    (key: string, content: string) =>
      run(key, (signal) =>
        translateText(provider, content, {
          targetLang: settings.targetLang,
          temperature: settings.temperature,
          glossary: meta.glossary,
          styleNotes: meta.styleNotes,
          ...(fields
            ? { card: cardContext(fields, key), section: sectionContext(fields, key) }
            : {}),
          gate,
          signal,
        }),
      ),
    [
      fields,
      gate,
      meta.glossary,
      meta.styleNotes,
      provider,
      run,
      settings.targetLang,
      settings.temperature,
    ],
  );

  const translateKeys = useCallback(
    (key: string, keywords: string[]) =>
      run(key, (signal) =>
        translateKeywords(provider, keywords, { targetLang: settings.targetLang, gate, signal }),
      ),
    [gate, provider, run, settings.targetLang],
  );

  /** Propose the proper nouns the lorebook keys did not already cover. */
  const extract = useCallback(
    (fields: CardFields) =>
      run(EXTRACT_KEY, (signal) =>
        extractTerms(provider, fields, {
          targetLang: settings.targetLang,
          gate,
          signal,
          onProgress: step(EXTRACT_KEY),
        }),
      ),
    [gate, provider, run, settings.targetLang, step],
  );

  /** Settle a translation for every term that has none. */
  const decide = useCallback(
    (fields: CardFields, terms: GlossaryTerm[]) =>
      run(DECIDE_KEY, (signal) =>
        decideTranslations(provider, fields, terms, {
          targetLang: settings.targetLang,
          gate,
          signal,
          onProgress: step(DECIDE_KEY),
        }),
      ),
    [gate, provider, run, settings.targetLang, step],
  );

  /**
   * Translate every section. Returns per-section results rather than throwing,
   * so one blocked section cannot discard the rest.
   */
  const translateWholeCard = useCallback(
    (fields: CardFields, only?: string[]) =>
      run(CARD_KEY, (signal) =>
        translateCard(provider, fields, {
          targetLang: settings.targetLang,
          temperature: settings.temperature,
          glossary: meta.glossary,
          styleNotes: meta.styleNotes,
          gate,
          signal,
          only,
          onProgress: step(CARD_KEY),
        }),
      ),
    [
      gate,
      meta.glossary,
      meta.styleNotes,
      provider,
      run,
      settings.targetLang,
      settings.temperature,
      step,
    ],
  );

  const cancel = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setStatus((prev) => ({ ...prev, [key]: 'idle' }));
  }, []);

  const cancelAll = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setStatus({});
    setProgress({});
  }, []);

  const busy = Object.values(status).some((value) => value === 'running');

  return {
    provider,
    status,
    errors,
    progress,
    translate,
    translateKeys,
    translateWholeCard,
    extract,
    decide,
    cancel,
    cancelAll,
    busy,
  };
}
