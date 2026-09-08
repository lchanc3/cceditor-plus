import { Download, Languages, Loader2, RotateCcw, Settings, Sparkles } from 'lucide-react';
import { ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AISettings, TermReview, loadSettings, saveSettings } from './ai';
import {
  CardFields,
  CardModel,
  LorebookEntry,
  readCardBytes,
  readCardFile,
  suggestFilename,
} from './card';
import {
  GlossaryTerm,
  TranslationIssue,
  cardSections,
  checkTranslation,
  createTerm,
  decodeTranslationMeta,
  duplicateTargets,
  encodeTranslationMeta,
  glossaryReadiness,
  keysWithoutTerms,
  mergeTerms,
  scanUsage,
  simplifiedTargets,
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
import { TranslateDialog } from './components/TranslateDialog';
import { RunReport, TranslateReport } from './components/TranslateReport';
import { Banner } from './components/ui';
import { CARD_KEY, useTranslate } from './hooks/useTranslate';
import { clearDraft, loadDraft, saveDraft } from './lib/draft';
import { downloadText } from './lib/download';
import { useCardStore, type SectionRevert } from './state/cardStore';

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

/** Stands in until a card is loaded; the dialog that reads it needs one. */
const NO_GLOSSARY = {
  terms: 0,
  decided: 0,
  undecided: 0,
  entriesWithKeys: 0,
  entriesCovered: 0,
};

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
  const [draftOffer, setDraftOffer] = useState<{
    model: CardModel;
    imageBytes?: Uint8Array;
    reverts?: Record<string, SectionRevert>;
  } | null>(
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
  /**
   * What the last review pass thought was wrong.
   *
   * Kept here rather than on the card: a finding is a question waiting to be
   * answered, not a property of the glossary, and one that outlived the session
   * that raised it would be answering for a card that has since moved on.
   */
  const [reviews, setReviews] = useState<TermReview[]>([]);
  /** Whether a review has run at all, which is what "found nothing" needs to mean anything. */
  const [reviewed, setReviewed] = useState(false);
  /**
   * Findings waved off by hand, held apart from the findings themselves so that
   * "the pass found nothing" and "you have answered all of them" stay two
   * different things to say.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  /** The outcome of the last translation run, until it is dismissed. */
  const [report, setReport] = useState<RunReport | null>(null);
  /** Element id a jump is heading for, cleared once the scroll has happened. */
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [translateOpen, setTranslateOpen] = useState(false);
  /** Outcome of the last "apply glossary to lorebook keys" action. */
  const [keysNotice, setKeysNotice] = useState('');

  /** Findings belong to the card that was reviewed, so a new card starts clean. */
  const clearReviews = useCallback(() => {
    setReviews([]);
    setReviewed(false);
    setDismissed(new Set());
  }, []);

  const { model, imageBytes } = state;
  const translate = useTranslate(settings, state.glossary, model?.fields ?? null);

  // ---- draft persistence -------------------------------------------------

  useEffect(() => {
    void loadDraft().then((draft) => {
      if (draft?.model?.fields?.name !== undefined) {
        setDraftOffer({ model: draft.model, imageBytes: draft.imageBytes, reverts: draft.reverts });
      }
    });
  }, []);

  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!model || !state.dirty) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveDraft(model, imageBytes ?? undefined, state.reverts);
    }, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [model, imageBytes, state.dirty, state.reverts]);

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
        clearReviews();
        setDraftOffer(null);
      } catch (error) {
        setLoadError((error as Error).message || '無法讀取這個檔案。');
      } finally {
        setBusy(false);
      }
    },
    [actions, clearReviews],
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
    clearReviews();
    reset();
  }, [clearReviews, reset, state.dirty, translate]);

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

  /** Run the deterministic checks and keep whatever they found for this path. */
  const inspect = useCallback(
    (source: string, translated: string): TranslationIssue[] =>
      checkTranslation(source, translated, { targetLang: settings.targetLang }),
    [settings.targetLang],
  );

  /**
   * What happens once a single section has been translated on its own.
   *
   * The whole-card run has always inspected what came back; the per-field
   * buttons only ever checked the glossary, so a section retranslated by itself
   * was accepted without anyone looking at its macros, its line structure, its
   * script or its encoding. That is the path somebody takes to fix a section
   * they were unhappy with, which makes it the worst one to leave unwatched — a
   * card can reach export having been repaired a field at a time and never
   * checked once.
   *
   * The report opens only when something was found. One that appeared after
   * every clean field would be dismissed unread within a day, and the button
   * already shows a tick of its own when a translation lands without complaint.
   */
  const settle = useCallback(
    (path: string, source: string, translated: string) => {
      checkApplied(source, translated);

      const found = inspect(source, translated);
      if (found.length === 0) return;

      // The label comes from the card as it was before the translation, which
      // is still what `model` holds here — the dispatch above does not reach
      // this closure until the next render.
      const label = model
        ? (cardSections(model.fields).find((section) => section.path === path)?.label ?? path)
        : path;

      setReport({ results: [{ path, label, text: translated }], issues: { [path]: found } });
    },
    [checkApplied, inspect, model],
  );

  const translateField = useCallback(
    async (key: keyof CardFields) => {
      if (!model) return;
      const current = model.fields[key];
      if (typeof current !== 'string') return;
      const result = await translate.translate(key as string, current);
      if (result === null) return;
      dispatch({ type: 'section.set', path: key as string, value: result, previous: current });
      settle(key as string, current, result);
    },
    [model, setField, settle, translate],
  );

  const translateGreeting = useCallback(
    async (index: number) => {
      if (!model) return;
      const source = model.fields.alternate_greetings[index];
      const result = await translate.translate(`greeting:${index}`, source);
      if (result === null) return;
      dispatch({ type: 'section.set', path: `greeting:${index}`, value: result, previous: source });
      settle(`greeting:${index}`, source, result);
    },
    [dispatch, model, settle, translate],
  );

  /**
   * Settle the lorebook keys the glossary cannot answer, before anything is
   * translated, and hand back the glossary to translate with.
   *
   * The order is the whole point. A key named on its own *after* the prose is
   * translated guarantees nothing: the prose may well have rendered the same
   * word another way, and then the entry never fires — which is the failure the
   * glossary exists to prevent. Named first, the one decision is pinned into
   * every section's prompt and appended to the keys, from a single source.
   *
   * A card set in the real world has no invented names to settle, so an empty
   * glossary is its normal state rather than a degraded one. This is how those
   * cards get a glossary at all, and it costs one request: the names land in
   * the 詞彙 tab where they can be read, edited and reviewed like any other.
   */
  const settleLoreKeys = useCallback(
    async (entries: LorebookEntry[]): Promise<{ terms: GlossaryTerm[]; failed: boolean }> => {
      const terms = state.glossary.glossary;
      const orphans = entries.flatMap((entry) => [
        ...keysWithoutTerms(entry.keys, terms),
        ...keysWithoutTerms(entry.secondary_keys ?? [], terms),
      ]);
      if (orphans.length === 0) return { terms, failed: false };

      const named = await translate.translateKeys(CARD_KEY, orphans);
      // A failure leaves the glossary as it was. The run still goes ahead —
      // nineteen translated sections are worth more than a perfect lorebook —
      // but the report has to say so, since those entries will end up with
      // source-language keys on a translated card.
      if (!named) return { terms, failed: true };

      dispatch({ type: 'glossary.merge', terms: named });
      // Merged locally too: the dispatch above does not reach this closure
      // until the next render, and the run starts before that.
      return { terms: mergeTerms(terms, named), failed: false };
    },
    [dispatch, state.glossary.glossary, translate],
  );

  const translateLoreEntry = useCallback(
    async (index: number) => {
      const entry = model?.fields.character_book?.entries[index];
      if (!entry) return;

      const key = `lore:${index}`;

      // Names first, then the text, then the keys — the same order the
      // whole-card run uses, so this entry's key and its prose come from one
      // decision rather than from two independent translations.
      const { terms } = await settleLoreKeys([entry]);

      const content = await translate.translate(key, entry.content, terms);
      if (content === null) return;

      const keys = translatedKeysFor(entry.keys, terms);
      const secondary = translatedKeysFor(entry.secondary_keys ?? [], terms);

      // Written through the same action the whole-card run uses, so both paths
      // get one set of rules about what may be appended and what is a repeat.
      dispatch({ type: 'section.set', path: key, value: content, previous: entry.content });
      if (keys.length > 0) dispatch({ type: 'lore.addKeyList', index, field: 'keys', keys });
      if (secondary.length > 0) {
        dispatch({ type: 'lore.addKeyList', index, field: 'secondary_keys', keys: secondary });
      }
      settle(key, entry.content, content);
    },
    [dispatch, model, settle, settleLoreKeys, translate],
  );

  const translateWholeCard = useCallback(
    async (only: string[]) => {
      if (!model || only.length === 0) return;
      setTranslateOpen(false);

      // Captured before anything is written, since translating in place
      // destroys the source the checks need. It is handed to the store as well,
      // so each section keeps a way back — what the checks cannot judge, a
      // person still can, and only while the text they are judging survives.
      const before = new Map(cardSections(model.fields).map((s) => [s.path, s.text]));
      const entries = model.fields.character_book?.entries ?? [];
      const inScope = entries.filter((_, index) => only.includes(`lore:${index}`));

      // Before a word is translated, so the names reach the prose as well as
      // the keys.
      const { terms, failed } = await settleLoreKeys(inScope);

      const results = await translate.translateWholeCard(model.fields, only, terms);
      if (!results) return;

      const issues: Record<string, TranslationIssue[]> = {};

      for (const result of results) {
        if (result.text === undefined) continue;
        const source = before.get(result.path) ?? '';

        dispatch({ type: 'section.set', path: result.path, value: result.text, previous: source });

        const found = inspect(source, result.text);
        if (found.length > 0) issues[result.path] = found;
        checkApplied(source, result.text);
      }

      /*
       * Which entries get their translated keys.
       *
       * A blocked or throttled one does too. A key is matched against what the
       * reader types, not against this entry's own text, so withholding one
       * because the entry came back refused is what actually kills it: the
       * other nineteen entries now read in the target language, the reader
       * types in that language, and this one can no longer be reached at all.
       * Its content stays in the source language either way — that part is not
       * being papered over.
       *
       * A section the run never reached is left alone. Nothing on that card has
       * been translated, so there is no language for a key to be wrong in yet.
       */
      for (const result of results) {
        const lore = /^lore:(\d+)$/.exec(result.path);
        const reached = result.text !== undefined || result.filtered || result.transient;
        if (!lore || !reached) continue;

        const index = Number(lore[1]);
        const entry = entries[index];
        if (!entry) continue;

        const keys = translatedKeysFor(entry.keys, terms);
        if (keys.length > 0) dispatch({ type: 'lore.addKeyList', index, field: 'keys', keys });

        const secondary = translatedKeysFor(entry.secondary_keys ?? [], terms);
        if (secondary.length > 0) {
          dispatch({ type: 'lore.addKeyList', index, field: 'secondary_keys', keys: secondary });
        }
      }

      setReport({ results, issues, keysFailed: failed });
    },
    [checkApplied, dispatch, inspect, model, settleLoreKeys, translate],
  );

  // ---- glossary ----------------------------------------------------------

  const glossary = state.glossary.glossary;

  const usage = useMemo(
    () => (model ? scanUsage(model.fields, glossary) : []),
    [model, glossary],
  );
  const conflicts = useMemo(() => duplicateTargets(glossary), [glossary]);
  const scriptSlips = useMemo(
    () => simplifiedTargets(glossary, settings.targetLang),
    [glossary, settings.targetLang],
  );
  const sections = useMemo(() => (model ? cardSections(model.fields) : []), [model]);
  const readiness = useMemo(
    () => (model ? glossaryReadiness(model.fields, glossary) : NO_GLOSSARY),
    [model, glossary],
  );

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

  const runReview = useCallback(async () => {
    if (!model) return;
    const found = await translate.review(model.fields, glossary);
    // `null` is a cancellation or a failure, and the task's own banner already
    // says which — so the findings already on screen are left alone.
    if (!found) return;

    setReviews(found);
    setReviewed(true);
    // A fresh reading supersedes what was waved off in the last one.
    setDismissed(new Set());
  }, [glossary, model, translate]);

  /**
   * The findings that still describe the glossary as it stands.
   *
   * A finding is about one particular translation, so the moment the term moves
   * on — taken, retyped, decided differently, or locked — it stops applying and
   * goes away without anybody having to dismiss it.
   */
  const openReviews = useMemo(() => {
    const byTerm = new Map(glossary.map((term) => [term.source, term]));
    const open = new Map<string, TermReview>();

    for (const review of reviews) {
      const term = byTerm.get(review.source);
      if (!term || term.locked || dismissed.has(review.source)) continue;
      if ((term.keepOriginal ? '' : term.target.trim()) !== review.current) continue;
      open.set(term.source, review);
    }

    return open;
  }, [dismissed, glossary, reviews]);

  /**
   * Counted from the findings still open rather than frozen when the pass
   * finished, so it cannot go on pointing at rows that no longer carry
   * anything. Which of the two empty cases it is worth saying: a review that
   * found nothing is a result, and one whose findings have all been answered is
   * a different result.
   */
  const reviewNotice = useMemo(() => {
    if (!reviewed) return '';
    if (reviews.length === 0) return '檢查完畢，這批譯名沒有建議要改的。';
    if (openReviews.size === 0) return `已經處理完這次檢查提出的 ${reviews.length} 個建議。`;
    return `${openReviews.size} 個譯名建議改掉，已標在下面的詞條上。`;
  }, [openReviews, reviewed, reviews.length]);

  const takeReview = useCallback(
    (index: number, suggestion: string) =>
      dispatch({
        type: 'glossary.patchTerm',
        index,
        // `manual`, because somebody read it and said yes. That is the origin
        // the precedence rules protect from a later AI pass, and an accepted
        // suggestion has as much standing as a typed one.
        patch: { target: suggestion, keepOriginal: false, origin: 'manual' },
      }),
    [dispatch],
  );

  const dismissReview = useCallback(
    (source: string) => setDismissed((prev) => new Set(prev).add(source)),
    [],
  );

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

  /**
   * Push agreed translations into the lorebook keys without retranslating.
   *
   * Whole-card translation already does this, but a card translated before the
   * glossary existed has no other way to get it — and without it those entries
   * keep only their source-language keys and never fire again.
   */
  const applyKeysToLorebook = useCallback(() => {
    const entries = model?.fields.character_book?.entries ?? [];
    const terms = state.glossary.glossary;
    let added = 0;
    let touched = 0;

    entries.forEach((entry, index) => {
      const keys = translatedKeysFor(entry.keys, terms);
      const secondary = translatedKeysFor(entry.secondary_keys ?? [], terms);
      if (keys.length === 0 && secondary.length === 0) return;

      touched++;
      added += keys.length + secondary.length;
      if (keys.length > 0) dispatch({ type: 'lore.addKeyList', index, field: 'keys', keys });
      if (secondary.length > 0) {
        dispatch({ type: 'lore.addKeyList', index, field: 'secondary_keys', keys: secondary });
      }
    });

    setKeysNotice(
      added === 0
        ? '沒有可以附加的關鍵字——現有的關鍵字在詞彙表裡都還沒有決定譯名。'
        : `已為 ${touched} 條世界書附加 ${added} 個譯詞關鍵字。`,
    );
  }, [dispatch, model, state.glossary.glossary]);

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
                  onClick={() => setTranslateOpen(true)}
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
                      actions.restore(draftOffer.model, draftOffer.imageBytes, draftOffer.reverts);
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
                  reverts={state.reverts}
                  onRevert={actions.revert}
                  glossary={{
                    meta: state.glossary,
                    usage,
                    conflicts,
                    scriptSlips,
                    unapplied,
                    reviews: openReviews,
                    reviewNotice,
                    onSeed: () => dispatch({ type: 'glossary.seed' }),
                    onExtract: runExtract,
                    onDecide: runDecide,
                    onReview: runReview,
                    onTakeReview: takeReview,
                    onDismissReview: dismissReview,
                    onPatch: (index, patch) =>
                      dispatch({ type: 'glossary.patchTerm', index, patch }),
                    onAdd: (source) =>
                      dispatch({ type: 'glossary.addTerm', term: createTerm({ source }) }),
                    onRemove: (index) => dispatch({ type: 'glossary.removeTerm', index }),
                    onClear: () => dispatch({ type: 'glossary.clear' }),
                    onStyleNotes: (notes) => dispatch({ type: 'glossary.setStyleNotes', notes }),
                    onImport: importGlossary,
                    onExport: exportGlossary,
                    onApplyKeys: applyKeysToLorebook,
                    keysNotice,
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
        <TranslateDialog
          open={translateOpen}
          sections={sections}
          readiness={readiness}
          onClose={() => setTranslateOpen(false)}
          onStart={(paths) => void translateWholeCard(paths)}
          onOpenGlossary={() => {
            setTranslateOpen(false);
            setActiveTab('glossary');
          }}
        />
      )}

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
  reverts,
  onRevert,
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
  reverts: Record<string, SectionRevert>;
  onRevert: (path: string) => void;
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
        revert={reverts[key]}
        onRevert={() => onRevert(key)}
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
          reverts={reverts}
          onRevert={onRevert}
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
          reverts={reverts}
          onRevert={onRevert}
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
