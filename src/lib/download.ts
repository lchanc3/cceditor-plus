/** Browser-only side of exporting; the codec itself deals in bytes and strings. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari needs the URL to outlive the click by a beat.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = 'application/json'): void {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = 'image/png'): void {
  downloadBlob(new Blob([bytes as BlobPart], { type }), filename);
}
