/**
 * Client for the shared library API.
 *
 * Thin on purpose: the interesting decisions -- when to prefer the shared copy,
 * what to do when the server is not there -- live in `library.ts`. This file
 * only knows how to talk to it.
 *
 * Every call is written to fail fast. The app has always worked offline and
 * still must: a phone in a workshop with no signal should fall back to its own
 * copy in a second or two, not hang the library behind a TCP timeout.
 */

import type { SchematicDoc } from '../core/model/types';
import type { DocMeta, Folder } from './db';

/** How long any one request gets before we call the shared library absent. */
const TIMEOUT = 6000;
/** The status probe is on the startup path, so it gets a tighter budget. */
const PROBE_TIMEOUT = 2500;

export interface SharedStatus {
  shared: true;
  docs: number;
  dataDir: string;
}

/**
 * `fetch` with a deadline, resolving to the parsed body.
 *
 * The base is relative, so the app works from a sub-path as happily as from a
 * domain root -- the same reason `base` is './' in the Vite config.
 */
async function call<T>(path: string, init: RequestInit = {}, timeout = TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`api/${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error ?? `Shared library returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this build is talking to a shared library, probed once.
 *
 * Cached for the life of the tab: the answer is a property of where the app is
 * hosted, and re-probing on every list would put a request in front of every
 * screen for a fact that cannot change. `refresh` exists for the retry button.
 */
let probe: Promise<SharedStatus | null> | null = null;

export function sharedStatus(refresh = false): Promise<SharedStatus | null> {
  if (refresh) probe = null;
  probe ??= call<SharedStatus>('status', {}, PROBE_TIMEOUT).catch(() => null);
  return probe;
}

export const fetchLibrary = () => call<{ docs: DocMeta[]; folders: Folder[] }>('library');

export const fetchDoc = (id: string) => call<SchematicDoc>(`docs/${encodeURIComponent(id)}`);

export const pushDoc = (doc: SchematicDoc, meta: DocMeta) =>
  call<{ ok: true }>(`docs/${encodeURIComponent(doc.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc, meta }),
    // A multi-sheet manual is tens of megabytes over a phone's uplink; the
    // usual budget would abort a perfectly healthy upload.
  }, 120_000);

export const patchMeta = (id: string, patch: Partial<DocMeta>) =>
  call<DocMeta>(`docs/${encodeURIComponent(id)}/meta`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const removeDoc = (id: string) =>
  call<{ ok: true }>(`docs/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const putFolder = (folder: Folder) =>
  call<{ ok: true }>(`folders/${encodeURIComponent(folder.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(folder),
  });

export const removeFolder = (id: string) =>
  call<{ ok: true }>(`folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
