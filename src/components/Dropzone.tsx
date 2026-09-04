import { FilePlus2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import { cn } from '../lib/utils';
import { Spinner } from './ui';

export function Dropzone({
  busy,
  onFile,
  onBlank,
}: {
  busy: boolean;
  onFile: (file: File) => void;
  onBlank: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          'rounded-lg border border-dashed bg-surface transition-colors',
          dragging ? 'border-gold bg-gold/5' : 'border-line-bright',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex w-full flex-col items-center gap-4 px-6 py-12 text-center sm:py-16"
        >
          <span className="flex size-16 items-center justify-center rounded-full border border-line bg-field">
            {busy ? <Spinner className="size-7 text-gold" /> : <Upload className="size-7 text-gold" />}
          </span>
          <span className="space-y-1">
            <span className="block font-serif text-xl text-gold">上傳角色卡</span>
            <span className="block text-sm text-dim">點擊選擇，或把檔案拖進來</span>
            <span className="block text-xs text-dim/70">支援 PNG（v1 / v2 / v3）與 JSON</span>
          </span>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept=".png,.json,image/png,application/json"
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            // Reset so picking the same file twice still fires a change event.
            event.target.value = '';
          }}
        />
      </div>

      <div className="flex justify-center">
        <button onClick={onBlank} className="btn-ghost">
          <FilePlus2 className="size-4" />
          從空白卡片開始
        </button>
      </div>

      <p className="text-center text-xs leading-relaxed text-dim/80">
        所有處理都在你的瀏覽器內完成。卡片不會上傳到任何伺服器；
        <br className="hidden sm:block" />
        只有在你按下翻譯時，該欄位的文字才會送往你自己設定的 AI 服務。
      </p>
    </div>
  );
}
