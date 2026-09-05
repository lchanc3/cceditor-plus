import { Download, Languages, Loader2, RotateCcw, Settings, Sparkles } from 'lucide-react';
import { ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AISettings, loadSettings, saveSettings } from './ai';
import {
  CardFields,
  CardModel,
  readCardBytes,
  readCardFile,
  suggestFilename,
} from './card';
import {
  TranslationIssue,
  cardSections,
  checkTranslation,
  createTerm,
  decodeTranslationMeta,
  duplicateTargets,
  encodeTranslationMeta,
  scanUsage,
  termsInText,
  translatedKeysFor,
  unappliedTerms,
} from './glossary';
import { AdvancedEditor } from './components/AdvancedEditor';
import { BasicEditor } from './components/BasicEditor';
import { CardSummary } from './components/CardSummary';
import { Dropzone } from './components/Dropzone';
import { ExportDialog } from './components/ExportDialog';
import { FieldEditor } from './components/FieldEditor';
import { GlossaryEditor } from './components/GlossaryEditor';
import { GreetingsEditor } from './components/GreetingsEditor';
import { LorebookEditor } from './components/LorebookEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { TabBar, TabDef } from './components/TabBar';
import { RunReport, TranslateReport } from './components/TranslateReport';
import { Banner } from './components/ui';
import { CARD_KEY, useTranslate } from './hooks/useTranslate';
import { clearDraft, loadDraft, saveDraft } from './lib/draft';
import { downloadText } from './lib/download';
import { useCardStore } from './state/cardStore';

/** Shown in the footer to satisfy AGPL-3.0 section 13. */
const SOURCE_URL = 'https://github.com/lchanc3/cceditor-plus';

const LONG_FIELDS = {
  description: { label: '角色描述', hint: '角色的外貌、背景與核心設定。通常是最重要的欄位。' },
  personality: { label: '性格設定', hint: '個性特質的摘要。' },
  scenario: { label: '場景 / 世界觀', hint: '對話發生的情境。' },
  first_mes: { label: '開場白', hint: '角色的第一句話。' },
  mes_example: { label: '對話範例', hint: '示範對話，用 <START> 分隔多組。' },
} as const;

type LongField = keyof typeof LONG_FIELDS;

/** Everything the glossary tab needs that is not task state. */
type GlossaryPanel = Omit<
  ComponentProps<typeof GlossaryEditor>,
  'status' | 'errors' | 'progress' | 'onCancel'
>;

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
  /**
   * Terms the last translation run failed to honour.
   *
   * Transient on purpose: checking one needs the source and the translation
   * side by side, and translating in place destroys the source. So it can only
   * be worked out at the moment a translation lands, never afterwards.
   */
  const [unapplied, setUnapplied] = useState<Set<string>>(new Set());
  /** The outcome of the last translation run, until it is dismissed. */
  const [report, setReport] = useState<RunReport | null>(null);
  /** Element id a jump is heading for, cleared once the scroll has happened. */
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);

  const translate = useTranslate(settings, state.glossary);
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
        setUnapplied(new Set());
        setReport(null);
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
    setUnapplied(new Set());
    setReport(null);
    reset();
  }, [reset, state.dirty, translate]);

  // ---- translation -------------------------------------------------------

  const setField = useCallback(
    <K extends keyof CardFields>(key: K, value: CardFields[K]) => actions.setField(key, value),
    [actions],
  );

  /**
   * Compare a finished translation against the glossary while the source is
   * still available. Terms honoured this time drop off the list, so a retry
   * clears its own flag.
   */
  const checkApplied = useCallback(
    (source: string, translated: string) => {
      const glossary = state.glossary.glossary;
      const missed = new Set(unappliedTerms(source, translated, glossary).map((t) => t.source));
      const checked = termsInText(source, glossary).map((t) => t.source);
      if (checked.length === 0) return;

      setUnapplied((prev) => {
        const next = new Set(prev);
        for (const term of checked) {
          if (missed.has(term)) next.add(term);
          else next.delete(term);
        }
        return next;
      });
    },
    [state.glossary.glossary],
  );

  const translateField = useCallback(
    async (key: keyof CardFields) => {
      if (!model) return;
      const current = model.fields[key];
      if (typeof current !== 'string') return;
      const result = await translate.translate(key as string, current);
      if (result === null) return;
      setField(key, result as CardFields[typeof key]);
      checkApplied(current, result);
    },
    [checkApplied, model, setField, translate],
  );

  const translateGreeting = useCallback(
    async (index: number) => {
      if (!model) return;
      const source = model.fields.alternate_greetings[index];
      const result = await translate.translate(`greeting:${index}`, source);
      if (result === null) return;
      dispatch({ type: 'greeting.set', index, value: result });
      checkApplied(source, result);
    },
    [checkApplied, dispatch, model, translate],
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
      //
      // With a glossary, the translated key comes from the same place as the
      // name used in the text above — which is the only thing that guarantees
      // the entry still fires. Only a card with no glossary at all falls back
      // to translating the keys independently.
      const terms = state.glossary.glossary;
      const appendTranslated = async (existing: string[]): Promise<string[]> => {
        if (existing.length === 0) return existing;
        if (terms.length > 0) return [...existing, ...translatedKeysFor(existing, terms)];
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
      checkApplied(entry.content, content);
    },
    [checkApplied, dispatch, model, state.glossary.glossary, translate],
  );

  /** Run the deterministic checks and keep whatever they found for this path. */
  const inspect = useCallback(
    (source: string, translated: string): TranslationIssue[] =>
      checkTranslation(source, translated, { targetLang: settings.targetLang }),
    [settings.targetLang],
  );

  const translateWholeCard = useCallback(
    async (only?: string[]) => {
      if (!model) return;

      // Captured before anything is written, since translating in place
      // destroys the source the checks need.
      const before = new Map(cardSections(model.fields).map((s) => [s.path, s.text]));
      const entries = model.fields.character_book?.entries ?? [];
      const terms = state.glossary.glossary;

      const results = await translate.translateWholeCard(model.fields, only);
      if (!results) return;

      const issues: Record<string, TranslationIssue[]> = {};

      for (const result of results) {
        if (result.text === undefined) continue;
        const source = before.get(result.path) ?? '';

        dispatch({ type: 'section.set', path: result.path, value: result.text });

        // A lorebook entry only fires if its keys match the translated text, so
        // the keys come from the same glossary the translation was pinned to.
        const lore = /^lore:(\d+)$/.exec(result.path);
        if (lore && terms.length > 0) {
          const index = Number(lore[1]);
          const entry = entries[index];
          if (entry) {
            const keys = translatedKeysFor(entry.keys, terms);
            if (keys.length > 0) dispatch({ type: 'lore.addKeyList', index, field: 'keys', keys });

            const secondary = translatedKeysFor(entry.secondary_keys ?? [], terms);
            if (secondary.length > 0) {
              dispatch({ type: 'lore.addKeyList', index, field: 'secondary_keys', keys: secondary });
            }
          }
        }

        const found = inspect(source, result.text);
        if (found.length > 0) issues[result.path] = found;
        checkApplied(source, result.text);
      }

      setReport({ results, issues });
    },
    [checkApplied, dispatch, inspect, model, state.glossary.glossary, translate],
  );

  // ---- glossary ----------------------------------------------------------

  const glossary = state.glossary.glossary;

  const usage = useMemo(
    () => (model ? scanUsage(model.fields, glossary) : []),
    [model, glossary],
  );
  const conflicts = useMemo(() => duplicateTargets(glossary), [glossary]);

  const runExtract = useCallback(async () => {
    if (!model) return;
    const found = await translate.extract(model.fields);
    // `glossary.merge` applies the precedence rules, so this can only fill
    // blanks — it will not overwrite a name somebody already settled.
    if (found) dispatch({ type: 'glossary.merge', terms: found });
  }, [dispatch, model, translate]);

  const runDecide = useCallback(async () => {
    if (!model) return;
    dispatch({ type: 'glossary.setLangs', targetLang: settings.targetLang });
    const decided = await translate.decide(model.fields, glossary);
    if (decided) dispatch({ type: 'glossary.merge', terms: decided });
  }, [dispatch, glossary, model, settings.targetLang, translate]);

  const importGlossary = useCallback(
    async (file: File) => {
      setLoadError('');
      try {
        const parsed = decodeTranslationMeta(JSON.parse(await file.text()));
        if (!parsed) throw new Error('檔案裡沒有詞彙表資料。');
        dispatch({ type: 'glossary.merge', terms: parsed.glossary });
        // Adopt the imported style notes only when there are none to lose.
        if (state.glossary.styleNotes.trim() === '' && parsed.styleNotes.trim() !== '') {
          dispatch({ type: 'glossary.setStyleNotes', notes: parsed.styleNotes });
        }
      } catch (error) {
        setLoadError(`無法匯入詞彙表：${(error as Error).message}`);
      }
    },
    [dispatch, state.glossary.styleNotes],
  );

  const exportGlossary = useCallback(() => {
    const encoded = encodeTranslationMeta(state.glossary);
    if (!encoded || !model) return;
    // Same shape the card carries, so a file from one card loads into another.
    downloadText(
      JSON.stringify(encoded, null, 2),
      suggestFilename(model, 'glossary.json'),
    );
  }, [model, state.glossary]);

  /**
   * Term occurrences and report entries are addressed by section path; tabs are
   * not, and a tab holding twenty lorebook entries is not somewhere a link has
   * arrived until it lands on the right one.
   */
  const jumpToPath = useCallback((path: string) => {
    const entry = /^(greeting|lore):(\d+)$/.exec(path);
    if (entry) {
      setActiveTab(entry[1] === 'lore' ? 'lorebook' : 'greetings');
      setPendingScroll(`${entry[1]}-${entry[2]}`);
      return;
    }

    setPendingScroll(null);
    if (path === 'name' || path === 'creator_notes') return setActiveTab('basic');
    if (path === 'system_prompt' || path === 'post_history_instructions') {
      return setActiveTab('advanced');
    }
    setActiveTab(path);
  }, []);

  // The target only exists once the new tab has rendered, so the scroll waits
  // for the commit rather than happening inside the click handler.
  useEffect(() => {
    if (!pendingScroll) return;
    setPendingScroll(null);

    const target = document.getElementById(pendingScroll);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A brief outline, because scrolling alone leaves the reader hunting for
    // which of twenty identical-looking entries they were sent to.
    target.classList.add('flash');
    window.setTimeout(() => target.classList.remove('flash'), 1600);
  }, [pendingScroll, activeTab]);

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
      { id: 'glossary', label: '詞彙', badge: glossary.length },
      { id: 'mes_example', label: '對話範例' },
      { id: 'advanced', label: '進階' },
    ];
  }, [glossary.length, model]);

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
            {model &&
              (translate.status[CARD_KEY] === 'running' ? (
                <button
                  onClick={() => translate.cancel(CARD_KEY)}
                  className="btn-ghost hidden px-3 text-gold sm:inline-flex"
                >
                  <Loader2 className="size-4 animate-spin" />
                  取消
                  {translate.progress[CARD_KEY] && (
                    <span className="tabular-nums">
                      {translate.progress[CARD_KEY].done}/{translate.progress[CARD_KEY].total}
                    </span>
                  )}
                </button>
              ) : (
                <button
                  onClick={() => void translateWholeCard()}
                  className="btn-ghost hidden px-3 sm:inline-flex"
                >
                  <Languages className="size-4" />
                  整卡翻譯
                </button>
              ))}
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

        {model && report && (
          <div className="mb-5">
            <TranslateReport
              report={report}
              onRetry={(paths) => void translateWholeCard(paths)}
              onDismiss={() => setReport(null)}
              onJump={jumpToPath}
            />
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
                  glossary={{
                    meta: state.glossary,
                    usage,
                    conflicts,
                    unapplied,
                    onSeed: () => dispatch({ type: 'glossary.seed' }),
                    onExtract: runExtract,
                    onDecide: runDecide,
                    onPatch: (index, patch) =>
                      dispatch({ type: 'glossary.patchTerm', index, patch }),
                    onAdd: (source) =>
                      dispatch({ type: 'glossary.addTerm', term: createTerm({ source }) }),
                    onRemove: (index) => dispatch({ type: 'glossary.removeTerm', index }),
                    onClear: () => dispatch({ type: 'glossary.clear' }),
                    onStyleNotes: (notes) => dispatch({ type: 'glossary.setStyleNotes', notes }),
                    onImport: importGlossary,
                    onExport: exportGlossary,
                    onJump: jumpToPath,
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      {/*
        AGPL-3.0 section 13 requires that anyone interacting with this app over a
        network be offered its source, so the link below is a licence obligation,
        not decoration. Keep it visible on every page.
      */}
      <footer className="border-t border-line px-4 py-6 text-center text-xs text-dim/60 sm:px-6">
        <p>CCEditor+ · 角色卡在你的瀏覽器內處理，不會上傳到任何伺服器。</p>
        <p className="mt-2">
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-gold"
          >
            原始碼
          </a>
          {' · AGPL-3.0'}
        </p>
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
  glossary,
}: {
  activeTab: string;
  fields: CardFields;
  translate: ReturnType<typeof useTranslate>;
  setField: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void;
  dispatch: ReturnType<typeof useCardStore>['dispatch'];
  onTranslateField: (key: keyof CardFields) => void;
  onTranslateGreeting: (index: number) => void;
  onTranslateLore: (index: number) => void;
  glossary: GlossaryPanel;
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

    case 'glossary':
      return (
        <GlossaryEditor
          {...glossary}
          status={translate.status}
          errors={translate.errors}
          progress={translate.progress}
          onCancel={translate.cancel}
        />
      );

    case 'advanced':
      return <AdvancedEditor fields={fields} onChange={setField} />;

    default:
      return null;
  }
}
