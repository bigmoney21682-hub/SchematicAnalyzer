/**
 * One library, whether or not there is a server behind it.
 *
 * The app is used in two situations that pull in opposite directions: a shared
 * workbench where a schematic corrected on the laptop should be there on the
 * phone a minute later, and a workshop with no signal where the same phone must
 * still open the manual it was reading yesterday. So neither store is "the"
 * store:
 *
 *   IndexedDB   the working copy. Every save lands here first, immediately,
 *               and every read falls back to it. This is what makes the PWA
 *               work offline, and it is unchanged from before.
 *   the server   the shared copy. Written to a moment later, in the background,
 *               and never on the critical path of an edit.
 *
 * When the two disagree, the newer `updatedAt` wins. That is last-write-wins,
 * which is the honest description: two people editing the same schematic at the
 * same time will have one of them overwrite the other. For a shared bench tool
 * with a handful of users that is the right trade against the machinery real
 * merging would need -- and nothing is ever lost silently, because the local
 * copy on each device keeps whatever it last saw.
 *
 * The original uploads (`sources`) stay local by design. They exist so a
 * zoomed-in sheet can be redrawn from the real thing; they are ten to twenty
 * times the size of the analysis, and shipping them over a phone's uplink would
 * make sharing painful for a benefit only the zoom level uses.
 */

import type { SchematicDoc } from '../core/model/types';
import {
  createFolder as createLocalFolder,
  deleteDoc as deleteLocalDoc,
  deleteFolder as deleteLocalFolder,
  getDoc,
  getMeta,
  listDocs,
  listFolders,
  renameFolder as renameLocalFolder,
  saveDoc,
  updateMeta as updateLocalMeta,
  type DocMeta,
  type Folder,
} from './db';
import {
  fetchDoc,
  fetchLibrary,
  patchMeta,
  pushDoc,
  putFolder,
  removeDoc,
  removeFolder,
  sharedStatus,
} from './shared';

/** A library row, plus whether the shared library has heard of it yet. */
export interface LibraryEntry extends DocMeta {
  /** True when this document exists only in this browser. */
  localOnly?: boolean;
}

export interface Listing {
  docs: LibraryEntry[];
  folders: Folder[];
  /** False when we are working from this browser's copy alone. */
  shared: boolean;
}

// ---------------------------------------------------------------------------
// Sync state, for the indicator in the toolbar
// ---------------------------------------------------------------------------

export type SyncState =
  /** No server behind this build, or it could not be reached. */
  | 'local'
  /** Up to date with the shared library. */
  | 'shared'
  /** An upload is in flight or waiting on its debounce. */
  | 'syncing'
  /** The last upload failed. The local copy is safe; the shared one is stale. */
  | 'error';

let state: SyncState = 'local';
let lastError: string | null = null;
const listeners = new Set<() => void>();

const setState = (next: SyncState, error: string | null = null) => {
  if (next === state && error === lastError) return;
  state = next;
  lastError = error;
  for (const l of listeners) l();
};

export const syncState = () => ({ state, error: lastError });

export function onSyncChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a shared library is reachable, and reflect it in the indicator. */
async function shared(): Promise<boolean> {
  const status = await sharedStatus();
  if (!status) {
    setState('local');
    return false;
  }
  if (state === 'local') setState('shared');
  return true;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Everything in the library: the shared set, plus anything this browser has
 * that has not been uploaded yet.
 *
 * The local-only rows are shown rather than hidden. A document that failed to
 * upload -- the server was down, the phone was on a train -- is still the user's
 * work, and a library that quietly omitted it would look like data loss.
 */
export async function listLibrary(): Promise<Listing> {
  const [localDocs, localFolders] = await Promise.all([
    listDocs().catch(() => [] as DocMeta[]),
    listFolders().catch(() => [] as Folder[]),
  ]);

  if (!(await shared())) return { docs: localDocs, folders: localFolders, shared: false };

  try {
    const remote = await fetchLibrary();
    const byId = new Map<string, LibraryEntry>();
    for (const meta of remote.docs) byId.set(meta.id, meta);
    for (const meta of localDocs) {
      const there = byId.get(meta.id);
      // A local copy that is ahead has not finished uploading; show its figures,
      // since they are what the user just did.
      if (!there) byId.set(meta.id, { ...meta, localOnly: true });
      else if (meta.updatedAt > there.updatedAt) byId.set(meta.id, meta);
    }

    return {
      docs: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      folders: remote.folders,
      shared: true,
    };
  } catch (err) {
    setState('error', message(err));
    return { docs: localDocs, folders: localFolders, shared: false };
  }
}

/**
 * Open a document, preferring whichever copy was written last.
 *
 * A shared copy that wins is cached locally on the way through, so the next
 * open works with no network and the existing autosave path has something to
 * write against.
 */
export async function openDocument(id: string): Promise<SchematicDoc | undefined> {
  const local = await getDoc(id).catch(() => undefined);
  if (!(await shared())) return local;

  try {
    const remote = await fetchDoc(id);
    if (local && local.updatedAt > remote.updatedAt) return local;
    await saveDoc(remote).catch(() => {});
    return remote;
  } catch {
    // Present locally but not on the server yet, or the server went away
    // mid-session. Either way the local copy is the answer.
    return local;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Upload debounce.
 *
 * The local autosave runs 800ms after an edit, which is right for IndexedDB and
 * far too eager for a 20MB upload -- typing a net label would push the whole
 * document a character at a time. Uploads wait for a real pause, and only the
 * latest version of any document is ever in flight.
 */
const PUSH_DELAY = 4000;
const pending = new Map<string, { doc: SchematicDoc; timer: number }>();
const inFlight = new Set<string>();

/** Save locally now; upload shortly. Resolves once the local write is done. */
export async function saveDocument(doc: SchematicDoc): Promise<void> {
  await saveDoc(doc);
  if (!(await shared())) return;

  const existing = pending.get(doc.id);
  if (existing) clearTimeout(existing.timer);
  setState('syncing');
  pending.set(doc.id, {
    doc,
    timer: window.setTimeout(() => void push(doc.id), PUSH_DELAY),
  });
}

/** Send a document now, skipping the debounce. */
export async function flushDocument(id: string): Promise<void> {
  const entry = pending.get(id);
  if (entry) clearTimeout(entry.timer);
  await push(id);
}

async function push(id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  // A second upload of the same document while the first is still going would
  // race, and the loser might be the newer one.
  if (inFlight.has(id)) {
    entry.timer = window.setTimeout(() => void push(id), 1500);
    return;
  }

  pending.delete(id);
  inFlight.add(id);
  setState('syncing');
  try {
    const meta = await getMeta(id);
    if (meta) await pushDoc(entry.doc, meta);
    setState(pending.size ? 'syncing' : 'shared');
  } catch (err) {
    setState('error', message(err));
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Put anything this browser has into the shared library.
 *
 * Run once at startup. Its real job is the first run after this feature landed:
 * every schematic already analysed on this device is local-only, and without
 * this the shared library would start empty and look broken.
 */
export async function syncUp(): Promise<void> {
  if (!(await shared())) return;

  try {
    const remote = await fetchLibrary();
    const there = new Map(remote.docs.map((d) => [d.id, d.updatedAt]));
    const mine = await listDocs();

    for (const meta of mine) {
      const theirs = there.get(meta.id);
      if (theirs !== undefined && theirs >= meta.updatedAt) continue;
      const doc = await getDoc(meta.id);
      if (!doc) continue;
      setState('syncing');
      await pushDoc(doc, meta);
    }

    // Folders are small; push any the server has not seen rather than diffing.
    const theirFolders = new Set(remote.folders.map((f) => f.id));
    for (const folder of await listFolders()) {
      if (!theirFolders.has(folder.id)) await putFolder(folder);
    }

    setState('shared');
  } catch (err) {
    setState('error', message(err));
  }
}

// ---------------------------------------------------------------------------
// Library management -- both stores, local first
// ---------------------------------------------------------------------------

export async function deleteDocument(id: string): Promise<void> {
  await deleteLocalDoc(id);
  if (await shared()) await removeDoc(id).catch((err) => setState('error', message(err)));
}

/** Rename a document, or move it between folders. */
export async function updateDocumentMeta(id: string, patch: Partial<DocMeta>): Promise<void> {
  await updateLocalMeta(id, patch);
  if (!(await shared())) return;
  try {
    await patchMeta(id, patch);
  } catch {
    // The shared library has no meta record for a document it has never seen.
    // Uploading it in full is both the fix and what the user wanted anyway.
    const doc = await getDoc(id);
    const meta = await getMeta(id);
    if (doc && meta) await pushDoc(doc, meta).catch((err) => setState('error', message(err)));
  }
}

export async function createLibraryFolder(name: string, parentId: string | null): Promise<Folder> {
  // Created locally first so both stores agree on the id.
  const folder = await createLocalFolder(name, parentId);
  if (await shared()) await putFolder(folder).catch((err) => setState('error', message(err)));
  return folder;
}

export async function renameLibraryFolder(id: string, name: string): Promise<void> {
  await renameLocalFolder(id, name);
  if (!(await shared())) return;
  // A folder made on another device has no local record to read back, so fall
  // through to the shared copy rather than dropping the rename.
  const folder =
    (await listFolders()).find((f) => f.id === id) ??
    (await fetchLibrary().catch(() => null))?.folders.find((f) => f.id === id);
  if (folder) await putFolder({ ...folder, name }).catch((err) => setState('error', message(err)));
}

export async function deleteLibraryFolder(id: string): Promise<void> {
  await deleteLocalFolder(id);
  if (await shared()) await removeFolder(id).catch((err) => setState('error', message(err)));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
