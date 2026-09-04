import { FileJson, FileImage } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  CardModel,
  ExportSpec,
  SPEC_LABELS,
  buildCardJson,
  buildCardPng,
  suggestFilename,
  withExportTimestamps,
} from '../card';
import { downloadBytes, downloadText } from '../lib/download';
import { Banner, Modal } from './ui';

const SPEC_ORDER: ExportSpec[] = ['max', 'v3', 'v2', 'v1'];

const SPEC_NOTES: Record<ExportSpec, string> = {
  max: '同時具備 V1 的扁平欄位與 V3 的 spec/data 結構，任何版本的讀取器都吃得下。不確定就選這個。',
  v3: '最新規格，保留 assets、暱稱、群組開場白等 V3 專屬欄位。',
  v2: '相容性最廣的傳統格式，會捨棄 V3 專屬欄位。',
  v1: '僅 6 個基本欄位，會捨棄世界書、其他開場白與所有中繼資料。',
};

export function ExportDialog({
  open,
  model,
  imageBytes,
  onClose,
}: {
  open: boolean;
  model: CardModel;
  imageBytes: Uint8Array | null;
  onClose: () => void;
}) {
  const [spec, setSpec] = useState<ExportSpec>('max');
  const [error, setError] = useState('');

  // Timestamps are stamped once per export so both formats agree.
  const stamped = useMemo(() => withExportTimestamps(model), [model]);

  const exportJson = () => {
    try {
      downloadText(buildCardJson(stamped, spec), suggestFilename(stamped, 'json'));
      onClose();
    } catch (exportError) {
      setError((exportError as Error).message);
    }
  };

  const exportPng = () => {
    if (!imageBytes) {
      setError('這張卡沒有圖片。請先用側邊欄的「換圖」掛上一張 PNG，或改為匯出 JSON。');
      return;
    }
    try {
      // The PNG always carries both chara (V2) and ccv3 (V3), regardless of the
      // spec chosen above — that choice only affects the JSON output.
      downloadBytes(buildCardPng(stamped, imageBytes), suggestFilename(stamped, 'png'));
      onClose();
    } catch (exportError) {
      setError((exportError as Error).message);
    }
  };

  return (
    <Modal open={open} title="匯出角色卡" onClose={onClose}>
      {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}

      <fieldset className="space-y-2">
        <legend className="label">JSON 規格版本</legend>
        {SPEC_ORDER.map((option) => (
          <label
            key={option}
            className={`flex cursor-pointer gap-3 rounded border p-3 transition-colors ${
              spec === option ? 'border-gold bg-gold/5' : 'border-line hover:border-line-bright'
            }`}
          >
            <input
              type="radio"
              name="export-spec"
              className="mt-1 size-4 shrink-0 accent-[#d4af37]"
              checked={spec === option}
              onChange={() => setSpec(option)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-bold">{SPEC_LABELS[option]}</span>
              <span className="mt-1 block text-xs leading-relaxed text-dim">{SPEC_NOTES[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={exportJson} className="btn-ghost">
          <FileJson className="size-4" />
          下載 JSON
        </button>
        <button onClick={exportPng} disabled={!imageBytes} className="btn-primary">
          <FileImage className="size-4" />
          下載 PNG
        </button>
      </div>

      <p className="text-xs leading-relaxed text-dim">
        PNG 一律同時寫入 <code className="text-gold">chara</code>（V2）與{' '}
        <code className="text-gold">ccv3</code>（V3）兩個 chunk，舊工具讀前者、新工具讀後者，
        並且會先移除卡片原有的舊 chunk，不會殘留過期資料。
      </p>
    </Modal>
  );
}
