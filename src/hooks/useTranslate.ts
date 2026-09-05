import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AISettings,
  createProvider,
  decideTranslations,
  describeError,
  extractTerms,
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

/** The two whole-card passes get fixed slots, since only one of each can run. */
export const EXTRACT_KEY = 'glossary:extract';
export const DECIDE_KEY = 'glossary:decide';

/**
 * Tracks one translation per UI slot (a field name, `greeting:2`, `lore:0`…),
 * so several can run at once and each shows its own state.
 *
 * The glossary is a hook argument rather than a per-call one so that every
 * translation carries it automatically — the same reasoning that puts the
 * "only send terms this text contains" filter inside `translateText`. A call
 * site cannot forget what it never has to pass.
 */
export function useTranslate(settings: AISettings, meta: TranslationMeta) {
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
          signal,
        }),
      ),
    [provider, run, settings.targetLang, settings.temperature, meta.glossary, meta.styleNotes],
  );

  const translateKeys = useCallback(
    (key: string, keywords: string[]) =>
      run(key, (signal) =>
        translateKeywords(provider, keywords, { targetLang: settings.targetLang, signal }),
      ),
    [provider, run, settings.targetLang],
  );

  /** Propose the proper nouns the lorebook keys did not already cover. */
  const extract = useCallback(
    (fields: CardFields) =>
      run(EXTRACT_KEY, (signal) =>
        extractTerms(provider, fields, {
          targetLang: settings.targetLang,
          signal,
          onProgress: step(EXTRACT_KEY),
        }),
      ),
    [provider, run, settings.targetLang, step],
  );

  /** Settle a translation for every term that has none. */
  const decide = useCallback(
    (fields: CardFields, terms: GlossaryTerm[]) =>
      run(DECIDE_KEY, (signal) =>
        decideTranslations(provider, fields, terms, {
          targetLang: settings.targetLang,
          signal,
          onProgress: step(DECIDE_KEY),
        }),
      ),
    [provider, run, settings.targetLang, step],
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
    extract,
    decide,
    cancel,
    cancelAll,
    busy,
  };
}
