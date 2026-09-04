import { ImageIcon, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CardModel, CardOrigin } from '../card';
import { formatCount } from '../lib/utils';

const SPEC_BADGE: Record<string, string> = { v1: 'V1', v2: 'V2', v3: 'V3' };
const ORIGIN_LABEL: Record<CardOrigin, string> = {
  ccv3: 'PNG · ccv3 chunk',
  chara: 'PNG · chara chunk',
  json: 'JSON',
};

export function CardSummary({
  model,
  imageBytes,
  origin,
  onNameChange,
  onCreatorChange,
  onReplaceImage,
}: {
  model: CardModel;
  imageBytes: Uint8Array | null;
  origin: CardOrigin | null;
  onNameChange: (value: string) => void;
  onCreatorChange: (value: string) => void;
  onReplaceImage: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!imageBytes) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([imageBytes as BlobPart], { type: 'image/png' }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageBytes]);

  const totalChars = useMemo(() => {
    const { fields } = model;
    const lore = fields.character_book?.entries.reduce((sum, e) => sum + e.content.length, 0) ?? 0;
    return (
      fields.description.length +
      fields.personality.length +
      fields.scenario.length +
      fields.first_mes.length +
      fields.mes_example.length +
      fields.alternate_greetings.reduce((sum, g) => sum + g.length, 0) +
      lore
    );
  }, [model]);

  return (
    <div className="panel space-y-5 p-4 sm:p-5">
      <div className="flex gap-4 lg:block lg:space-y-5">
        <div className="relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded border border-line bg-field lg:w-full">
          {imageUrl ? (
            <img src={imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-line-bright">
              <ImageIcon className="size-8" />
            </div>
          )}
          <button
            onClick={() => inputRef.current?.click()}
            className="tap absolute right-1 bottom-1 flex items-center gap-1 rounded bg-ink/80 px-2 py-1 text-xs font-bold text-gold backdrop-blur-sm"
            title="只更換圖片，不影響已編輯的內容"
          >
            <RefreshCw className="size-3" />
            換圖
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".png,image/png"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onReplaceImage(file);
              event.target.value = '';
            }}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <label className="label" htmlFor="card-name">
              角色名稱
            </label>
            <input
              id="card-name"
              className="field font-serif text-lg"
              value={model.fields.name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="未命名角色"
            />
          </div>

          <div>
            <label className="label" htmlFor="card-creator">
              作者
            </label>
            <input
              id="card-creator"
              className="field text-sm"
              value={model.fields.creator}
              onChange={(event) => onCreatorChange(event.target.value)}
              placeholder="未填寫"
            />
          </div>
        </div>
      </div>

      <dl className="space-y-2 border-t border-line pt-4 text-xs">
        <Row label="讀取格式" value={SPEC_BADGE[model.sourceSpec] ?? model.sourceSpec} />
        <Row label="資料來源" value={origin ? ORIGIN_LABEL[origin] : '草稿還原'} />
        <Row label="開場白" value={`${model.fields.alternate_greetings.length + 1} 則`} />
        <Row label="世界書" value={`${model.fields.character_book?.entries.length ?? 0} 條`} />
        <Row label="總字數" value={formatCount(totalChars)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className="truncate text-right text-gold">{value}</dd>
    </div>
  );
}
