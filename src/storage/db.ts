/**
 * IndexedDB persistence.
 *
 * A schematic doc carries a full-page PNG data URL per sheet, which blows past
 * the ~5MB localStorage ceiling immediately. IndexedDB also lets the PWA reopen
 * the user's last session offline, which is the whole point of installing it.
 *
 * Four stores, deliberately separated by how often they are read:
 *
 *   docs      the documents themselves -- large, read one at a time
 *   meta      one small record per document -- name, folder, thumbnail, counts
 *   folders   the library tree
 *   sources   the original uploaded bytes, kept for high-resolution redraws
 *   learning  what the classifier has been taught (a single small record)
 *
 * `meta` exists because listing used to load every document in full -- fifteen
 * sheets of decoded PNG per document, just to draw a filename in a list. On a
 * phone that is the difference between a library that opens instantly and one
 * that stalls for several seconds and sometimes runs the tab out of memory.
 */

import type { SchematicDoc } from '../core/model/types';
import { newId } from '../core/util/id';

const DB_NAME = 'schematic-analyzer';
const DB_VERSION = 2;

const DOCS = 'docs';
const META = 'meta';
const FOLDERS = 'folders';
const SOURCES = 'sources';
const LEARNING = 'learning';

/** Lightweight record backing every list in the library. */
export interface DocMeta {
  id: string;
  name: string;
  /** Containing folder, or null for the library root. */
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  pageCount: number;
  netCount: number;
  componentCount: number;
  /** Small JPEG of the first sheet, for the library rows. */
  thumbnail?: string;
  /** Length of the raster the thumbnail was made from, to spot a stale one. */
  thumbnailOf?: number;
  /** Bytes of original-upload detail held for this document. */
  sourceBytes?: number;
}

export interface Folder {
  id: string;
  name: string;
  /** Parent folder, or null at the root. */
  parentId: string | null;
  createdAt: number;
}

/**
 * An original upload, kept so a zoomed-in sheet can be redrawn sharply.
 *
 * Keyed by *file*, not by sheet: a twenty-page PDF is one blob that twenty
 * sheets point at, and storing it per sheet would multiply a 30MB manual into
 * 600MB of duplicated bytes.
 */
export interface SourceRecord {
  /** `${docId}/f${n}`, matching `SourcePage.origin.key`. */
  key: string;
  docId: string;
  blob: Blob;
  kind: 'image' | 'pdf';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let cached: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  // One long-lived connection. The previous code opened and closed the database
  // per operation, which is roughly a hundred opens to draw one library page.
  if (cached) return cached;

  cached = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) {
        db.createObjectStore(DOCS, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(META)) {
        const store = db.createObjectStore(META, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('folderId', 'folderId');
      }
      if (!db.objectStoreNames.contains(FOLDERS)) {
        db.createObjectStore(FOLDERS, { keyPath: 'id' }).createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains(SOURCES)) {
        db.createObjectStore(SOURCES, { keyPath: 'key' }).createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains(LEARNING)) {
        db.createObjectStore(LEARNING, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema would otherwise leave this connection
      // blocking it forever.
      db.onversionchange = () => {
        db.close();
        cached = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cached = null;
      reject(req.error);
    };
  });

  return cached;
}

/**
 * Run work inside one transaction and resolve once it has actually committed.
 *
 * The body may await `once(...)` on requests belonging to the same transaction:
 * a request's success handler resolves its promise in a microtask, which runs
 * before the transaction's auto-commit task, so follow-up reads and writes stay
 * inside it. What the body must not do is await anything *outside* IndexedDB --
 * that yields to the task queue and the transaction commits underneath it.
 */
async function run<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await open();
  const tx = db.transaction(storeNames, mode);

  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });

  const result = await fn(tx);
  await committed;
  return result;
}

/** Promise wrapper for a single request inside a transaction we already have. */
function once<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Write a document and refresh its library entry in the same transaction.
 *
 * Doing both atomically matters: a document saved without its meta record is
 * invisible in the library, and a meta record without its document is a row
 * that opens to nothing.
 */
export async function saveDoc(doc: SchematicDoc, patch: Partial<DocMeta> = {}): Promise<void> {
  const existing = await getMeta(doc.id);
  const first = doc.pages[0];
  const stale = !existing?.thumbnail || existing.thumbnailOf !== first?.dataUrl.length;
  const thumbnail = stale && first ? await makeThumbnail(first.dataUrl) : existing?.thumbnail;

  const meta: DocMeta = {
    id: doc.id,
    name: doc.name,
    folderId: existing?.folderId ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    pageCount: doc.pages.length,
    netCount: doc.nets.length,
    componentCount: doc.components.length,
    thumbnail,
    thumbnailOf: thumbnail ? first?.dataUrl.length : undefined,
    sourceBytes: existing?.sourceBytes ?? 0,
    ...patch,
  };

  await run([DOCS, META], 'readwrite', (tx) => {
    tx.objectStore(DOCS).put(doc);
    tx.objectStore(META).put(meta);
  });
}

export const getDoc = (id: string) =>
  run<SchematicDoc | undefined>(DOCS, 'readonly', (tx) => once(tx.objectStore(DOCS).get(id)));

export const getMeta = (id: string) =>
  run<DocMeta | undefined>(META, 'readonly', (tx) => once(tx.objectStore(META).get(id)));

/** Remove a document, its library entry and every original it kept. */
export async function deleteDoc(id: string): Promise<void> {
  await run([DOCS, META, SOURCES], 'readwrite', async (tx) => {
    tx.objectStore(DOCS).delete(id);
    tx.objectStore(META).delete(id);
    const keys = await once(tx.objectStore(SOURCES).index('docId').getAllKeys(id));
    for (const k of keys) tx.objectStore(SOURCES).delete(k);
  });
}

export const updateMeta = (id: string, patch: Partial<DocMeta>) =>
  run(META, 'readwrite', async (tx) => {
    const store = tx.objectStore(META);
    const current = await once<DocMeta | undefined>(store.get(id));
    if (current) store.put({ ...current, ...patch, id });
  });

/**
 * Every library entry, newest first.
 *
 * Backfills entries for documents saved before the library existed, so an
 * upgrade never looks like data loss.
 */
export async function listDocs(): Promise<DocMeta[]> {
  const metas = await run<DocMeta[]>(META, 'readonly', (tx) => once(tx.objectStore(META).getAll()));
  const known = new Set(metas.map((m) => m.id));

  const orphanIds = (
    await run<IDBValidKey[]>(DOCS, 'readonly', (tx) => once(tx.objectStore(DOCS).getAllKeys()))
  )
    .map(String)
    .filter((id) => !known.has(id));

  for (const id of orphanIds) {
    const doc = await getDoc(id);
    if (!doc) continue;
    await saveDoc(doc);
    const meta = await getMeta(id);
    if (meta) metas.push(meta);
  }

  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const listFolders = () =>
  run<Folder[]>(FOLDERS, 'readonly', (tx) => once(tx.objectStore(FOLDERS).getAll()));

export async function createFolder(name: string, parentId: string | null = null): Promise<Folder> {
  const folder: Folder = { id: newId(), name: name.trim() || 'New folder', parentId, createdAt: Date.now() };
  await run(FOLDERS, 'readwrite', (tx) => tx.objectStore(FOLDERS).put(folder));
  return folder;
}

export const renameFolder = (id: string, name: string) =>
  run(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const current = await once<Folder | undefined>(store.get(id));
    if (current) store.put({ ...current, name: name.trim() || current.name });
  });

/**
 * Delete a folder, lifting its contents to the parent.
 *
 * Deleting the schematics inside as well would be the more obvious behaviour
 * and much the more dangerous one -- an hour of OCR sits behind each of those
 * rows. Documents are only ever deleted one at a time, deliberately.
 */
export async function deleteFolder(id: string): Promise<void> {
  const folders = await listFolders();
  const target = folders.find((f) => f.id === id);
  if (!target) return;

  await run([FOLDERS, META], 'readwrite', async (tx) => {
    const folderStore = tx.objectStore(FOLDERS);
    for (const child of folders.filter((f) => f.parentId === id)) {
      folderStore.put({ ...child, parentId: target.parentId });
    }
    folderStore.delete(id);

    const metaStore = tx.objectStore(META);
    const inside = await once<DocMeta[]>(metaStore.index('folderId').getAll(id));
    for (const m of inside) metaStore.put({ ...m, folderId: target.parentId });
  });
}

// ---------------------------------------------------------------------------
// Original sources (high-resolution redraw)
// ---------------------------------------------------------------------------

/**
 * Keep the bytes the user actually uploaded.
 *
 * The analysis raster is capped at 2600px on its long edge -- plenty for
 * tracing, and blurry the moment you zoom past about 150%. Holding the original
 * lets the viewport redraw the patch you are looking at from the real thing,
 * or re-render the PDF's vectors outright, at whatever resolution the screen
 * can show.
 */
export async function putSources(docId: string, records: SourceRecord[]): Promise<number> {
  if (!records.length) return 0;
  let bytes = 0;
  await run(SOURCES, 'readwrite', (tx) => {
    const store = tx.objectStore(SOURCES);
    for (const r of records) {
      bytes += r.blob.size;
      store.put(r);
    }
  });
  const meta = await getMeta(docId);
  const total = (meta?.sourceBytes ?? 0) + bytes;
  await updateMeta(docId, { sourceBytes: total });
  return total;
}

export const getSource = (key: string) =>
  run<SourceRecord | undefined>(SOURCES, 'readonly', (tx) => once(tx.objectStore(SOURCES).get(key)));

/** Drop the originals for one document, keeping the analysis itself. */
export async function dropSources(docId: string): Promise<void> {
  await run(SOURCES, 'readwrite', async (tx) => {
    const store = tx.objectStore(SOURCES);
    const keys = await once(store.index('docId').getAllKeys(docId));
    for (const k of keys) store.delete(k);
  });
  await updateMeta(docId, { sourceBytes: 0 });
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export const loadLearning = <T>(id: string) =>
  run<(T & { id: string }) | undefined>(LEARNING, 'readonly', (tx) =>
    once(tx.objectStore(LEARNING).get(id)),
  );

export const saveLearning = <T extends object>(id: string, value: T) =>
  run(LEARNING, 'readwrite', (tx) => tx.objectStore(LEARNING).put({ ...value, id }));

export const clearLearning = (id: string) =>
  run(LEARNING, 'readwrite', (tx) => tx.objectStore(LEARNING).delete(id));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Storage the browser reports us as using, when it will say. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

const THUMB_WIDTH = 320;

/** A small JPEG of a sheet, for the library rows. */
async function makeThumbnail(dataUrl: string): Promise<string | undefined> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // A thumbnail is decoration; never let one cost the user their save.
    return undefined;
  }
}

const LAST_KEY = 'schematic-analyzer.lastDoc';
export const rememberLast = (id: string) => localStorage.setItem(LAST_KEY, id);
export const forgetLast = () => localStorage.removeItem(LAST_KEY);
export const recallLast = () => localStorage.getItem(LAST_KEY);
