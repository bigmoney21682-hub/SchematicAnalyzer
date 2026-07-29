/**
 * The library: every analysed schematic, in folders.
 *
 * Analysing a manual is a long job -- twenty sheets of OCR is minutes of phone
 * battery -- so the results are the valuable thing here, not the uploads. This
 * is where they live: a plain folder tree, because a bench workflow is "the
 * Trio-9500 job" and "the amp I'm still arguing with", and a flat list sorted
 * by date stops being navigable at about a dozen documents.
 *
 * Everything drawn here comes from the `meta` store -- name, counts, a small
 * thumbnail. The documents themselves are only read when one is opened, so a
 * library holding fifteen multi-sheet manuals opens as fast as an empty one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { dropSources, storageEstimate, type Folder } from '../storage/db';
import {
  createLibraryFolder,
  deleteDocument,
  deleteLibraryFolder,
  listLibrary,
  renameLibraryFolder,
  updateDocumentMeta,
  type LibraryEntry,
} from '../storage/library';

interface Props {
  /** Open a document. */
  onOpen: (id: string) => void;
  /** Start a new analysis. */
  onNew: () => void;
  /** Leave the library. Absent when it is the whole screen. */
  onClose?: () => void;
  /** The document currently open, marked in the list. */
  currentId?: string;
}

/** Folder being renamed or created, or a document being renamed. */
type Editing = { kind: 'folder' | 'doc' | 'new-folder'; id: string; value: string } | null;

const SHARE_HINT = {
  on: 'These schematics live on the server, not in this browser. Everyone with the link sees and edits the same set.',
  off: 'No shared library is reachable, so these are the schematics in this browser alone. Anything you analyse now uploads itself as soon as the server is back.',
};

export function Library({ onOpen, onNew, onClose, currentId }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [docs, setDocs] = useState<LibraryEntry[]>([]);
  /** Whether these rows came from the shared library or this browser alone. */
  const [shared, setShared] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [listing, u] = await Promise.all([listLibrary(), storageEstimate()]);
      setFolders(listing.folders);
      setDocs(listing.docs);
      setShared(listing.shared);
      setUsage(u);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A folder deleted in another tab would otherwise leave us inside nothing.
  useEffect(() => {
    if (cwd && !folders.some((f) => f.id === cwd)) setCwd(null);
  }, [folders, cwd]);

  const path = useMemo(() => folderPath(folders, cwd), [folders, cwd]);
  const here = useMemo(
    () => ({
      folders: folders.filter((f) => f.parentId === cwd).sort((a, b) => a.name.localeCompare(b.name)),
      docs: docs.filter((d) => (d.folderId ?? null) === cwd),
    }),
    [folders, docs, cwd],
  );

  const guard = (job: Promise<unknown>) =>
    job.then(refresh).catch((err) => setError(err instanceof Error ? err.message : String(err)));

  const commit = () => {
    if (!editing) return;
    const value = editing.value.trim();
    setEditing(null);
    if (!value) return;
    if (editing.kind === 'new-folder') guard(createLibraryFolder(value, cwd));
    else if (editing.kind === 'folder') guard(renameLibraryFolder(editing.id, value));
    else guard(updateDocumentMeta(editing.id, { name: value }));
  };

  return (
    <div className="library">
      <header className="library-head">
        <div className="crumbs">
          <button className="crumb" onClick={() => setCwd(null)}>
            All schematics
          </button>
          {path.map((f) => (
            <span key={f.id}>
              <span className="sep">/</span>
              <button className="crumb" onClick={() => setCwd(f.id)}>
                {f.name}
              </button>
            </span>
          ))}
        </div>
        <div className="library-actions">
          <span className={`share-pill ${shared ? 'on' : ''}`} title={SHARE_HINT[shared ? 'on' : 'off']}>
            {shared ? '● Shared library' : '○ This device only'}
          </span>
          <button onClick={() => setEditing({ kind: 'new-folder', id: 'new', value: '' })}>New folder</button>
          <button className="primary" onClick={onNew}>
            Analyse a schematic
          </button>
          {onClose && (
            <button onClick={onClose} title="Back to the schematic">
              Close
            </button>
          )}
        </div>
      </header>

      {error && <div className="error-banner inline">{error}</div>}

      <div className="library-body">
        {editing?.kind === 'new-folder' && (
          <div className="row folder editing">
            <span className="row-icon">📁</span>
            <input
              autoFocus
              value={editing.value}
              placeholder="Folder name"
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={commit}
            />
          </div>
        )}

        {here.folders.map((f) => (
          <div key={f.id} className="row folder">
            <span className="row-icon">📁</span>
            {editing?.kind === 'folder' && editing.id === f.id ? (
              <input
                autoFocus
                value={editing.value}
                onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(null);
                }}
                onBlur={commit}
              />
            ) : (
              <button className="row-main" onClick={() => setCwd(f.id)}>
                <b>{f.name}</b>
                <span className="muted small">{countInside(folders, docs, f.id)}</span>
              </button>
            )}
            <div className="row-tools">
              <button onClick={() => setEditing({ kind: 'folder', id: f.id, value: f.name })}>Rename</button>
              {confirming === f.id ? (
                <>
                  <button className="danger" onClick={() => guard(deleteLibraryFolder(f.id)).then(() => setConfirming(null))}>
                    Delete folder
                  </button>
                  <button onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirming(f.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}

        {here.docs.map((d) => (
          <div key={d.id} className={`row doc ${d.id === currentId ? 'current' : ''}`}>
            {d.thumbnail ? (
              <img className="row-thumb" src={d.thumbnail} alt="" />
            ) : (
              <span className="row-icon">📄</span>
            )}

            {editing?.kind === 'doc' && editing.id === d.id ? (
              <input
                autoFocus
                value={editing.value}
                onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(null);
                }}
                onBlur={commit}
              />
            ) : (
              <button className="row-main" onClick={() => onOpen(d.id)}>
                <b>{d.name}</b>
                <span className="muted small">
                  {d.pageCount} sheet{d.pageCount === 1 ? '' : 's'} · {d.netCount} nets ·{' '}
                  {d.componentCount} parts · {new Date(d.updatedAt).toLocaleDateString()}
                  {d.sourceBytes ? ` · ${mb(d.sourceBytes)} of full-resolution detail` : ''}
                  {d.id === currentId ? ' · open' : ''}
                  {shared && d.localOnly ? ' · on this device only, not uploaded yet' : ''}
                </span>
              </button>
            )}

            <div className="row-tools">
              <select
                aria-label="Move to folder"
                value={d.folderId ?? ''}
                onChange={(e) => guard(updateDocumentMeta(d.id, { folderId: e.target.value || null }))}
              >
                <option value="">All schematics</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {folderPath(folders, f.id)
                      .map((p) => p.name)
                      .join(' / ')}
                  </option>
                ))}
              </select>
              <button onClick={() => setEditing({ kind: 'doc', id: d.id, value: d.name })}>Rename</button>
              {d.sourceBytes ? (
                <button
                  onClick={() => guard(dropSources(d.id))}
                  title="Discard the original uploads. The analysis is kept, but zooming in will no longer sharpen."
                >
                  Free {mb(d.sourceBytes)}
                </button>
              ) : null}
              {confirming === d.id ? (
                <>
                  <button className="danger" onClick={() => guard(deleteDocument(d.id)).then(() => setConfirming(null))}>
                    Delete for good
                  </button>
                  <button onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setConfirming(d.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}

        {!loading && !here.folders.length && !here.docs.length && (
          <p className="muted empty">
            {cwd
              ? 'This folder is empty. Move a schematic into it with the dropdown on its row.'
              : 'Nothing analysed yet. Analyse a schematic and it will be saved here automatically.'}
          </p>
        )}
      </div>

      {usage && usage.quota > 0 && (
        <footer className="library-foot muted small">
          {mb(usage.usage)} of roughly {mb(usage.quota)} of browser storage used. Original uploads are kept
          so zooming in stays sharp; free them per document if space runs short.
          {shared &&
            ' The originals stay on this device — the shared library holds the analysis and the sheet images.'}
        </footer>
      )}
    </div>
  );
}

/** Ancestors of a folder, root first, including the folder itself. */
function folderPath(folders: Folder[], id: string | null): Folder[] {
  const out: Folder[] = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cursor = id ? byId.get(id) : undefined;
  // Bounded rather than `while (cursor)`: a cycle from a bad write would hang
  // the render, and no real tree here is anywhere near this deep.
  for (let i = 0; cursor && i < 32; i++) {
    out.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return out;
}

function countInside(folders: Folder[], docs: LibraryEntry[], id: string): string {
  const subs = folders.filter((f) => f.parentId === id).length;
  const files = docs.filter((d) => d.folderId === id).length;
  if (!subs && !files) return 'empty';
  return [
    files ? `${files} schematic${files === 1 ? '' : 's'}` : '',
    subs ? `${subs} folder${subs === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const mb = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
    : `${Math.round(bytes / 1024 / 1024)}MB`;
