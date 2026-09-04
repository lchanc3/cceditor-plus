import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AISettings,
  createProvider,
  describeError,
  translateKeywords,
  translateText,
} from '../ai';

export type TaskStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * Tracks one translation per UI slot (a field name, `greeting:2`, `lore:0`…),
 * so several can run at once and each shows its own state.
 */
export function useTranslate(settings: AISettings) {
  const [status, setStatus] = useState<Record<string, TaskStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
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

  const translate = useCallback(
    (key: string, content: string) =>
      run(key, (signal) =>
        translateText(provider, content, {
          targetLang: settings.targetLang,
          temperature: settings.temperature,
          signal,
        }),
      ),
    [provider, run, settings.targetLang, settings.temperature],
  );

  const translateKeys = useCallback(
    (key: string, keywords: string[]) =>
      run(key, (signal) =>
        translateKeywords(provider, keywords, { targetLang: settings.targetLang, signal }),
      ),
    [provider, run, settings.targetLang],
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
  }, []);

  const busy = Object.values(status).some((value) => value === 'running');

  return { provider, status, errors, translate, translateKeys, cancel, cancelAll, busy };
}
