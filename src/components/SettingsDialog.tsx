import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  AISettings,
  ModelInfo,
  OPENAI_PRESETS,
  TARGET_LANGUAGES,
  createProvider,
  describeError,
} from '../ai';
import { Banner, Modal, Spinner } from './ui';

export function SettingsDialog({
  open,
  settings,
  onClose,
  onSave,
}: {
  open: boolean;
  settings: AISettings;
  onClose: () => void;
  onSave: (settings: AISettings) => void;
}) {
  const [draft, setDraft] = useState(settings);

  // Re-seed from the saved settings each time the dialog opens, so cancelling
  // genuinely discards the edits.
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const patch = (value: Partial<AISettings>) => setDraft((prev) => ({ ...prev, ...value }));

  return (
    <Modal
      open={open}
      title="API 設定"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">
            取消
          </button>
          <button onClick={() => onSave(draft)} className="btn-primary">
            儲存設定
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3 rounded border border-line bg-field px-3 py-2.5 text-xs text-dim">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-gold" />
        <p>
          金鑰只會存在這個瀏覽器的 localStorage，不會送到任何伺服器。本站沒有後端，也沒有內建金鑰。
        </p>
      </div>

      <div>
        <label className="label" htmlFor="provider">
          AI 服務
        </label>
        <select
          id="provider"
          className="field"
          value={draft.provider}
          onChange={(event) => patch({ provider: event.target.value as AISettings['provider'] })}
        >
          <option value="gemini">Google Gemini</option>
          <option value="openai">OpenAI 相容端點</option>
        </select>
      </div>

      {draft.provider === 'gemini' ? (
        <>
          <div>
            <label className="label" htmlFor="gemini-key">
              Gemini API Key
            </label>
            <input
              id="gemini-key"
              type="password"
              autoComplete="off"
              className="field"
              value={draft.gemini.apiKey}
              onChange={(event) => patch({ gemini: { ...draft.gemini, apiKey: event.target.value } })}
              placeholder="AIza…"
            />
            <p className="mt-2 text-xs text-dim">
              可於 Google AI Studio 免費取得。
            </p>
          </div>

          <ModelPicker
            label="模型"
            settings={{ ...draft, provider: 'gemini' }}
            value={draft.gemini.model}
            onChange={(model) => patch({ gemini: { ...draft.gemini, model } })}
            placeholder="gemini-2.5-flash"
          />
        </>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="openai-preset">
              常用端點
            </label>
            <select
              id="openai-preset"
              className="field"
              value={
                OPENAI_PRESETS.find((preset) => preset.baseUrl === draft.openai.baseUrl)?.baseUrl ?? ''
              }
              onChange={(event) => {
                if (event.target.value) {
                  patch({ openai: { ...draft.openai, baseUrl: event.target.value } });
                }
              }}
            >
              <option value="">自訂…</option>
              {OPENAI_PRESETS.map((preset) => (
                <option key={preset.baseUrl} value={preset.baseUrl}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="openai-url">
              Base URL
            </label>
            <input
              id="openai-url"
              className="field"
              inputMode="url"
              autoComplete="off"
              value={draft.openai.baseUrl}
              onChange={(event) => patch({ openai: { ...draft.openai, baseUrl: event.target.value } })}
              placeholder="https://api.openai.com/v1"
            />
            <p className="mt-2 text-xs text-dim">
              需包含 <code className="text-gold">/v1</code>。端點必須允許瀏覽器跨來源請求（CORS）。
            </p>
          </div>

          <div>
            <label className="label" htmlFor="openai-key">
              API Key
            </label>
            <input
              id="openai-key"
              type="password"
              autoComplete="off"
              className="field"
              value={draft.openai.apiKey}
              onChange={(event) => patch({ openai: { ...draft.openai, apiKey: event.target.value } })}
              placeholder="sk-…（本機服務可留空）"
            />
          </div>

          <ModelPicker
            label="模型"
            settings={{ ...draft, provider: 'openai' }}
            value={draft.openai.model}
            onChange={(model) => patch({ openai: { ...draft.openai, model } })}
            placeholder="gpt-4o-mini"
          />
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="target-lang">
            翻譯目標語言
          </label>
          <input
            id="target-lang"
            list="target-lang-options"
            className="field"
            value={draft.targetLang}
            onChange={(event) => patch({ targetLang: event.target.value })}
          />
          <datalist id="target-lang-options">
            {TARGET_LANGUAGES.map((lang) => (
              <option key={lang} value={lang} />
            ))}
          </datalist>
        </div>

        <div>
          <label className="label" htmlFor="temperature">
            Temperature：{draft.temperature.toFixed(2)}
          </label>
          <input
            id="temperature"
            type="range"
            min={0}
            max={1}
            step={0.05}
            className="w-full accent-[#d4af37]"
            value={draft.temperature}
            onChange={(event) => patch({ temperature: Number(event.target.value) })}
          />
          <p className="mt-1 text-xs text-dim">越低越貼近原文，越高越自由。</p>
        </div>

        <div>
          <label className="label" htmlFor="rpm">
            每分鐘請求數上限
          </label>
          <input
            id="rpm"
            type="number"
            min={0}
            max={600}
            step={1}
            className="field text-sm"
            value={draft.requestsPerMinute}
            onChange={(event) =>
              patch({ requestsPerMinute: Math.max(0, Math.floor(Number(event.target.value) || 0)) })
            }
          />
          <p className="mt-1 text-xs leading-relaxed text-dim">
            整卡翻譯會照這個速度送出請求，不會等被擋了才放慢。
            Google AI Studio 免費層大約是 10～15，填 0 代表不限制。
          </p>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Model name with autocompletion from the endpoint's own model list.
 *
 * Free text rather than a hard dropdown: hosted gateways expose hundreds of
 * models, and a private deployment may serve one the list endpoint never
 * mentions.
 */
function ModelPicker({
  label,
  settings,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  settings: AISettings;
  value: string;
  placeholder?: string;
  onChange: (model: string) => void;
}) {
  const listId = useId();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  // Abandon an in-flight lookup if the dialog closes or the provider changes.
  useEffect(() => () => controller.current?.abort(), []);

  const fetchModels = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;

    setLoading(true);
    setError('');
    try {
      const found = await createProvider(settings).listModels(next.signal);
      setModels(found);
      if (found.length > 0 && !found.some((model) => model.id === value)) {
        // Nothing matched what is typed; leave it, but make the list obvious.
        setError('');
      }
    } catch (fetchError) {
      if ((fetchError as Error).name !== 'AbortError') setError(describeError(fetchError));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [settings, value]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="label mb-0" htmlFor={`${listId}-input`}>
          {label}
        </label>
        <button onClick={fetchModels} disabled={loading} className="btn-quiet">
          {loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          {loading ? '搜尋中…' : '搜尋模型'}
        </button>
      </div>

      <input
        id={`${listId}-input`}
        list={listId}
        className="field"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label && model.label !== model.id ? model.label : undefined}
          </option>
        ))}
      </datalist>

      {error && <Banner tone="error">{error}</Banner>}

      {models.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-dim">
            找到 {models.length} 個模型，可直接點選或在上方輸入框自動補完：
          </p>
          <div className="scroll-x flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {models.slice(0, 60).map((model) => (
              <button
                key={model.id}
                onClick={() => onChange(model.id)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${
                  model.id === value
                    ? 'border-gold bg-gold/10 text-gold'
                    : 'border-line text-dim hover:border-gold hover:text-gold'
                }`}
                title={model.label}
              >
                {model.id}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
