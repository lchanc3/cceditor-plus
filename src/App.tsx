import { Download, RotateCcw, Settings, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AISettings, loadSettings, saveSettings } from './ai';
import {
  CardFields,
  CardModel,
  readCardBytes,
  readCardFile,
} from './card';
import { AdvancedEditor } from './components/AdvancedEditor';
import { BasicEditor } from './components/BasicEditor';
import { CardSummary } from './components/CardSummary';
import { Dropzone } from './components/Dropzone';
import { ExportDialog } from './components/ExportDialog';
import { FieldEditor } from './components/FieldEditor';
import { GreetingsEditor } from './components/GreetingsEditor';
import { LorebookEditor } from './components/LorebookEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { TabBar, TabDef } from './components/TabBar';
import { Banner } from './components/ui';
import { useTranslate } from './hooks/useTranslate';
import { clearDraft, loadDraft, saveDraft } from './lib/draft';
import { useCardStore } from './state/cardStore';

const LONG_FIELDS = {
  description: { label: '角色描述', hint: '角色的外貌、背景與核心設定。通常是最重要的欄位。' },
  personality: { label: '性格設定', hint: '個性特質的摘要。' },
  scenario: { label: '場景 / 世界觀', hint: '對話發生的情境。' },
  first_mes: { label: '開場白', hint: '角色的第一句話。' },
  mes_example: { label: '對話範例', hint: '示範對話，用 <START> 分隔多組。' },
} as const;

type LongField = keyof typeof LONG_FIELDS;

export default function App() {
  const { state, actions, dispatch, reset } = useCardStore();
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [activeTab, setActiveTab] = useState('basic');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftOffer, setDraftOffer] = useState<{ model: CardModel; imageBytes?: Uint8Array } | null>(
    null,
  );

  const translate = useTranslate(settings);
  const { model, imageBytes } = state;

  // ---- draft persistence -------------------------------------------------

  useEffect(() => {
    void loadDraft().then((draft) => {
      if (draft?.model?.fields?.name !== undefined) {
        setDraftOffer({ model: draft.model, imageBytes: draft.imageBytes });
      }
    });
  }, []);

  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!model || !state.dirty) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveDraft(model, imageBytes ?? undefined);
    }, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [model, imageBytes, state.dirty]);

  // ---- file handling -----------------------------------------------------

  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setLoadError('');
      try {
        const result = await readCardFile(file);
        actions.load(result.model, result.origin, result.warnings, result.imageBytes);
        setActiveTab('basic');
        setDraftOffer(null);
      } catch (error) {
        setLoadError((error as Error).message || '無法讀取這個檔案。');
      } finally {
        setBusy(false);
      }
    },
    [actions],
  );

  /** Swaps only the artwork. The old build reparsed the file and lost every edit. */
  const replaceImage = useCallback(async (file: File) => {
    setLoadError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Validate it before committing, so a bad file cannot corrupt the export.
      await readCardBytes(bytes, file.name).catch((error) => {
        if (!/沒有角色卡資料/.test((error as Error).message)) throw error;
      });
      dispatch({ type: 'replaceImage', bytes });
    } catch (error) {
      setLoadError(`無法使用這張圖片：${(error as Error).message}`);
    }
  }, [dispatch]);

  const handleReset = useCallback(() => {
    if (state.dirty && !window.confirm('尚未匯出的編輯將會遺失，確定要清空嗎？')) return;
    void clearDraft();
    translate.cancelAll();
    reset();
  }, [reset, state.dirty, translate]);

  // ---- translation -------------------------------------------------------

  const setField = useCallback(
    <K extends keyof CardFields>(key: K, value: CardFields[K]) => actions.setField(key, value),
    [actions],
  );

  const translateField = useCallback(
    async (key: keyof CardFields) => {
      if (!model) return;
      const current = model.fields[key];
      if (typeof current !== 'string') return;
      const result = await translate.translate(key as string, current);
      if (result !== null) setField(key, result as CardFields[typeof key]);
    },
    [model, setField, translate],
  );

  const translateGreeting = useCallback(
    async (index: number) => {
      if (!model) return;
      const result = await translate.translate(
        `greeting:${index}`,
        model.fields.alternate_greetings[index],
      );
      if (result !== null) dispatch({ type: 'greeting.set', index, value: result });
    },
    [dispatch, model, translate],
  );

  const translateLoreEntry = useCallback(
    async (index: number) => {
      const entry = model?.fields.character_book?.entries[index];
      if (!entry) return;

      const key = `lore:${index}`;
      const content = await translate.translate(key, entry.content);
      if (content === null) return;

      // Keywords are appended, never replaced: the original terms still have to
      // match the text that triggers the entry.
      const appendTranslated = async (existing: string[]): Promise<string[]> => {
        if (existing.length === 0) return existing;
        const translated = await translate.translateKeys(key, existing);
        if (!translated) return existing;
        return [...existing, ...translated.filter((word) => !existing.includes(word))];
      };

      const keys = await appendTranslated(entry.keys);
      const secondary = await appendTranslated(entry.secondary_keys ?? []);

      dispatch({
        type: 'lore.patch',
        index,
        patch: {
          content,
          keys,
          ...(secondary.length > 0 ? { secondary_keys: secondary } : {}),
        },
      });
    },
    [dispatch, model, translate],
  );

  // ---- tabs --------------------------------------------------------------

  const tabs = useMemo<TabDef[]>(() => {
    const fields = model?.fields;
    return [
      { id: 'basic', label: '基本資料' },
      { id: 'description', label: '角色描述', field: 'description' },
      { id: 'personality', label: '性格設定', field: 'personality' },
      { id: 'scenario', label: '場景' },
      { id: 'first_mes', label: '開場白' },
      {
        id: 'greetings',
        label: '其他開場白',
        badge: fields?.alternate_greetings.length ?? 0,
      },
      { id: 'lorebook', label: '世界書', badge: fields?.character_book?.entries.length ?? 0 },
      { id: 'mes_example', label: '對話範例' },
      { id: 'advanced', label: '進階' },
    ];
  }, [model]);

  // ---- render ------------------------------------------------------------

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:h-16 sm:px-6">
          <h1 className="flex min-w-0 items-center gap-2 text-lg text-gold sm:text-xl">
            <Sparkles className="size-5 shrink-0" />
            <span className="truncate">CCEditor+</span>
          </h1>

          <div className="ml-auto flex items-center gap-2">
            {model && (
              <button onClick={handleReset} className="btn-quiet hidden sm:inline-flex">
                <RotateCcw className="size-3.5" />
                清空
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="tap inline-flex items-center justify-center rounded p-2 text-dim hover:bg-field hover:text-gold"
              aria-label="API 設定"
            >
              <Settings className="size-5" />
            </button>
            {model && (
              <button onClick={() => setExportOpen(true)} className="btn-primary hidden px-4 sm:inline-flex">
                <Download className="size-4" />
                匯出
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {loadError && (
          <div className="mb-5">
            <Banner tone="error" onDismiss={() => setLoadError('')}>
              {loadError}
            </Banner>
          </div>
        )}

        {!model && draftOffer && (
          <div className="mx-auto mb-5 max-w-xl">
            <Banner tone="info" onDismiss={() => setDraftOffer(null)}>
              <div className="space-y-2">
                <p>
                  找到未完成的草稿：
                  <span className="text-gold">{draftOffer.model.fields.name || '未命名角色'}</span>
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      actions.restore(draftOffer.model, draftOffer.imageBytes);
                      setDraftOffer(null);
                    }}
                    className="btn-ghost px-3 py-1.5 text-xs"
                  >
                    繼續編輯
                  </button>
                  <button
                    onClick={() => {
                      void clearDraft();
                      setDraftOffer(null);
                    }}
                    className="btn-quiet"
                  >
                    捨棄
                  </button>
                </div>
              </div>
            </Banner>
          </div>
        )}

        {!model ? (
          <Dropzone busy={busy} onFile={openFile} onBlank={actions.startBlank} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-8">
            <aside className="space-y-4">
              <CardSummary
                model={model}
                imageBytes={imageBytes}
                origin={state.origin}
                onNameChange={(value) => setField('name', value)}
                onCreatorChange={(value) => setField('creator', value)}
                onReplaceImage={replaceImage}
              />
              {state.warnings.length > 0 && (
                <Banner tone="warn" onDismiss={() => dispatch({ type: 'dismissWarnings' })}>
                  <ul className="space-y-1">
                    {state.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              <p className="rounded border border-line bg-surface p-4 text-xs leading-relaxed text-dim">
                編輯時請保留 <span className="text-gold">{'{{char}}'}</span> 與{' '}
                <span className="text-gold">{'{{user}}'}</span> 巨集，翻譯功能也已指示 AI 不要更動它們。
              </p>
            </aside>

            <div className="panel overflow-hidden lg:grid lg:grid-cols-[190px_minmax(0,1fr)]">
              <TabBar tabs={tabs} active={activeTab} onSelect={setActiveTab} />

              <div className="min-w-0 p-4 sm:p-6">
                <TabContent
                  activeTab={activeTab}
                  fields={model.fields}
                  translate={translate}
                  setField={setField}
                  dispatch={dispatch}
                  onTranslateField={translateField}
                  onTranslateGreeting={translateGreeting}
                  onTranslateLore={translateLoreEntry}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-line px-4 py-6 text-center text-xs text-dim/60 sm:px-6">
        <p>CCEditor+ · 角色卡在你的瀏覽器內處理，不會上傳到任何伺服器。</p>
      </footer>

      {/* Mobile action bar: export is the one thing that must always be reachable. */}
      {model && (
        <div
          className="sticky bottom-0 z-30 flex gap-3 border-t border-line bg-ink/95 px-4 py-3 backdrop-blur-md sm:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <button onClick={handleReset} className="btn-ghost shrink-0 px-4">
            <RotateCcw className="size-4" />
            <span className="sr-only">清空</span>
          </button>
          <button onClick={() => setExportOpen(true)} className="btn-primary flex-1">
            <Download className="size-4" />
            匯出角色卡
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          setSettings(next);
          saveSettings(next);
          setSettingsOpen(false);
        }}
      />

      {model && (
        <ExportDialog
          open={exportOpen}
          model={model}
          imageBytes={imageBytes}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function TabContent({
  activeTab,
  fields,
  translate,
  setField,
  dispatch,
  onTranslateField,
  onTranslateGreeting,
  onTranslateLore,
}: {
  activeTab: string;
  fields: CardFields;
  translate: ReturnType<typeof useTranslate>;
  setField: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void;
  dispatch: ReturnType<typeof useCardStore>['dispatch'];
  onTranslateField: (key: keyof CardFields) => void;
  onTranslateGreeting: (index: number) => void;
  onTranslateLore: (index: number) => void;
}) {
  if (activeTab in LONG_FIELDS) {
    const key = activeTab as LongField;
    const meta = LONG_FIELDS[key];
    return (
      <FieldEditor
        title={meta.label}
        hint={meta.hint}
        value={fields[key]}
        status={translate.status[key]}
        error={translate.errors[key]}
        onChange={(value) => setField(key, value)}
        onTranslate={() => onTranslateField(key)}
        onCancel={() => translate.cancel(key)}
      />
    );
  }

  switch (activeTab) {
    case 'basic':
      return (
        <BasicEditor
          fields={fields}
          status={translate.status.creator_notes}
          onChange={setField}
          onTranslateNotes={() => onTranslateField('creator_notes')}
          onCancelNotes={() => translate.cancel('creator_notes')}
        />
      );

    case 'greetings':
      return (
        <GreetingsEditor
          greetings={fields.alternate_greetings}
          status={translate.status}
          errors={translate.errors}
          onChange={(index, value) => dispatch({ type: 'greeting.set', index, value })}
          onAdd={() => dispatch({ type: 'greeting.add' })}
          onRemove={(index) => dispatch({ type: 'greeting.remove', index })}
          onMove={(index, direction) => dispatch({ type: 'greeting.move', index, direction })}
          onTranslate={onTranslateGreeting}
          onCancel={(index) => translate.cancel(`greeting:${index}`)}
        />
      );

    case 'lorebook':
      return (
        <LorebookEditor
          book={fields.character_book}
          status={translate.status}
          errors={translate.errors}
          onPatchBook={(patch) => dispatch({ type: 'lore.patchBook', patch })}
          onAdd={() => dispatch({ type: 'lore.add' })}
          onRemove={(index) => dispatch({ type: 'lore.remove', index })}
          onPatch={(index, patch) => dispatch({ type: 'lore.patch', index, patch })}
          onAddKeys={(index, field, raw) => dispatch({ type: 'lore.addKeys', index, field, raw })}
          onRemoveKey={(index, field, keyIndex) =>
            dispatch({ type: 'lore.removeKey', index, field, keyIndex })
          }
          onTranslate={onTranslateLore}
          onCancel={(index) => translate.cancel(`lore:${index}`)}
        />
      );

    case 'advanced':
      return <AdvancedEditor fields={fields} onChange={setField} />;

    default:
      return null;
  }
}
