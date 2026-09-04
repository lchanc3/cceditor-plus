/**
 * Draft persistence.
 *
 * Mobile browsers evict background tabs aggressively; without this, switching
 * apps mid-edit loses the work. IndexedDB rather than localStorage because the
 * PNG artwork has to survive too — restoring a card you can only export as JSON
 * is not much of a restore.
 */

import type { CardModel } from '../card';

const DB_NAME = 'cceditor-plus';
const STORE = 'draft';
const KEY = 'current';

export interface Draft {
  model: CardModel;
  imageBytes?: Uint8Array;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Every operation is best-effort: a failed draft save must never break editing. */
export async function saveDraft(model: CardModel, imageBytes?: Uint8Array): Promise<void> {
  try {
    const draft: Draft = { model, savedAt: Date.now() };
    if (imageBytes) draft.imageBytes = imageBytes;
    await withStore('readwrite', (store) => store.put(draft, KEY));
  } catch {
    /* private browsing, quota, or no IndexedDB */
  }
}

export async function loadDraft(): Promise<Draft | null> {
  try {
    return (await withStore<Draft | undefined>('readonly', (store) => store.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    /* nothing to do */
  }
}
