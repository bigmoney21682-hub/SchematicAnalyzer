/**
 * The shared library: schematics on disk, in the project folder.
 *
 * Until now every analysed schematic lived in one browser's IndexedDB, which
 * means the manual you spent twenty minutes of OCR on exists on exactly one
 * phone. This is the other half: a plain folder of JSON files that any browser
 * pointed at this server can list, open and edit. There are no accounts and no
 * per-user partitioning by design -- it is a shared workbench, and anyone with
 * the URL sees the same schematics.
 *
 *   data/schematics/<id>.json        the document: analysis + sheet rasters
 *   data/schematics/<id>.meta.json   name, folder, counts, thumbnail
 *   data/folders.json                the library tree
 *
 * Meta is a separate file for the same reason it is a separate IndexedDB store:
 * listing the library must not read fifteen sheets of PNG per row.
 *
 * The originals a document was made from -- the 30MB PDF, the phone photos --
 * are deliberately *not* uploaded. They exist to redraw a zoomed-in patch
 * sharply, they are ten to twenty times the size of everything else, and they
 * stay on the device that did the analysis.
 *
 * Written with no dependencies and no framework: this same handler is mounted
 * as Vite middleware in development and by `server/index.mjs` in production, so
 * there is one implementation of the API rather than two that drift.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Refuse a body larger than this. A big multi-sheet manual is ~40MB. */
const MAX_BODY = 192 * 1024 * 1024;

/** Ids come from the client, so they are treated as hostile until proven flat. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createLibraryApi({ dataDir }) {
  const docsDir = join(dataDir, 'schematics');
  const foldersFile = join(dataDir, 'folders.json');

  const ready = mkdir(docsDir, { recursive: true });

  const docPath = (id) => join(docsDir, `${id}.json`);
  const metaPath = (id) => join(docsDir, `${id}.meta.json`);

  /**
   * Write a file such that a reader never sees a half-written one.
   *
   * Autosave fires while the user is still editing, and a document is tens of
   * megabytes; a phone that pulled the library mid-write would otherwise get
   * truncated JSON and report the schematic as corrupt.
   */
  async function writeAtomic(path, contents) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, contents);
    await rename(tmp, path);
  }

  const readJson = async (path, fallback = undefined) => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  };

  const listFolders = () => readJson(foldersFile, []).then((f) => (Array.isArray(f) ? f : []));
  const saveFolders = (folders) => writeAtomic(foldersFile, JSON.stringify(folders));

  async function listMeta() {
    const names = await readdir(docsDir).catch(() => []);
    const metas = await Promise.all(
      names.filter((n) => n.endsWith('.meta.json')).map((n) => readJson(join(docsDir, n))),
    );
    return metas.filter(Boolean).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Document too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  const send = (res, status, body) => {
    const json = JSON.stringify(body ?? null);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
    });
    res.end(json);
    return true;
  };

  /**
   * Handle one request. Returns false if the URL is not ours, so the caller can
   * fall through to the dev server or the static file handler.
   */
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    try {
      await ready;
      const path = url.pathname.slice(5); // after "/api/"
      const method = req.method ?? 'GET';

      // --- Status -----------------------------------------------------------
      // What the client probes on startup to decide whether it is working
      // against the shared library or only against this browser.
      if (path === 'status') {
        const metas = await listMeta();
        return send(res, 200, { shared: true, docs: metas.length, dataDir: resolve(dataDir) });
      }

      // --- The listing ------------------------------------------------------
      if (path === 'library' && method === 'GET') {
        const [docs, folders] = await Promise.all([listMeta(), listFolders()]);
        return send(res, 200, { docs, folders });
      }

      // --- Documents --------------------------------------------------------
      const docMatch = /^docs\/([^/]+)(\/meta)?$/.exec(path);
      if (docMatch) {
        const id = decodeURIComponent(docMatch[1]);
        const isMeta = Boolean(docMatch[2]);
        if (!SAFE_ID.test(id)) return send(res, 400, { error: 'Bad document id' });

        if (method === 'GET' && !isMeta) {
          // Streamed: a document is tens of megabytes and there is no reason to
          // hold a second copy of it in this process's memory to send it.
          const stream = createReadStream(docPath(id));
          stream.on('error', () => send(res, 404, { error: 'No such document' }));
          stream.once('open', () => {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            stream.pipe(res);
          });
          return true;
        }

        if (method === 'PUT' && !isMeta) {
          const body = await readBody(req);
          if (!body?.doc || !body?.meta) return send(res, 400, { error: 'Expected { doc, meta }' });
          await writeAtomic(docPath(id), JSON.stringify(body.doc));
          await writeAtomic(metaPath(id), JSON.stringify({ ...body.meta, id }));
          return send(res, 200, { ok: true });
        }

        if (method === 'PATCH' && isMeta) {
          const patch = await readBody(req);
          const current = await readJson(metaPath(id));
          if (!current) return send(res, 404, { error: 'No such document' });
          const next = { ...current, ...patch, id };
          await writeAtomic(metaPath(id), JSON.stringify(next));
          return send(res, 200, next);
        }

        if (method === 'DELETE' && !isMeta) {
          await rm(docPath(id), { force: true });
          await rm(metaPath(id), { force: true });
          return send(res, 200, { ok: true });
        }
      }

      // --- Folders ----------------------------------------------------------
      if (path === 'folders' && method === 'GET') {
        return send(res, 200, await listFolders());
      }

      const folderMatch = /^folders\/([^/]+)$/.exec(path);
      if (folderMatch) {
        const id = decodeURIComponent(folderMatch[1]);
        if (!SAFE_ID.test(id)) return send(res, 400, { error: 'Bad folder id' });
        const folders = await listFolders();

        if (method === 'PUT') {
          const folder = await readBody(req);
          if (!folder?.name) return send(res, 400, { error: 'Expected a folder' });
          const next = folders.filter((f) => f.id !== id);
          next.push({ ...folder, id });
          await saveFolders(next);
          return send(res, 200, { ok: true });
        }

        if (method === 'DELETE') {
          // Contents are lifted to the parent, never deleted with the folder --
          // an hour of OCR sits behind each of those rows. Mirrors the rule the
          // local store has always followed.
          const target = folders.find((f) => f.id === id);
          if (!target) return send(res, 200, { ok: true });

          const next = folders
            .filter((f) => f.id !== id)
            .map((f) => (f.parentId === id ? { ...f, parentId: target.parentId } : f));
          await saveFolders(next);

          for (const meta of await listMeta()) {
            if (meta.folderId === id) {
              await writeAtomic(metaPath(meta.id), JSON.stringify({ ...meta, folderId: target.parentId }));
            }
          }
          return send(res, 200, { ok: true });
        }
      }

      return send(res, 404, { error: 'No such endpoint' });
    } catch (err) {
      return send(res, err?.status ?? 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
