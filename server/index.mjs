/**
 * Production server: the built app plus the shared library API.
 *
 * `npm run build && npm start`. This is what makes the library genuinely shared
 * rather than shared-in-development-only -- the schematics live in `data/` next
 * to the app, so every phone and laptop pointed at this URL sees the same set.
 *
 * A consequence worth being explicit about: the app can no longer be deployed
 * to a purely static host (GitHub Pages and the like) *with* the shared library,
 * because a static host has no disk to write to. Built for a host that runs
 * Node and gives the process a persistent directory. The static build still
 * works anywhere on its own -- it just falls back to per-browser storage, which
 * is exactly how it behaved before.
 *
 * Deliberately dependency-free: no Express, nothing to keep patched, and one
 * fewer thing between a bench tool and the drawing on the screen.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryApi } from './store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(process.env.DIST_DIR ?? join(root, 'dist'));
const dataDir = resolve(process.env.DATA_DIR ?? join(root, 'data'));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const api = createLibraryApi({ dataDir });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
  '.webmanifest': 'application/manifest+json',
};

/** Serve one file, or report that it is not there. */
async function serveFile(res, path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;

  // Hashed build assets are immutable; index.html and the service worker must
  // never be, or a deploy would not reach an installed PWA.
  const immutable = /\/assets\/|\.[0-9a-f]{8}\./.test(path);
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(path).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://localhost');
    // normalize() then a prefix check: without it, "/../../etc/passwd" walks
    // straight out of the build directory.
    const requested = resolve(distDir, '.' + normalize(decodeURIComponent(url.pathname)));
    const path = requested.startsWith(distDir) ? requested : distDir;

    if (await serveFile(res, path)) return;
    // Single-page app: any unknown path is a route, not a missing file.
    if (await serveFile(res, join(distDir, 'index.html'))) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. Run `npm run build` first.');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(err instanceof Error ? err.message : String(err));
  }
});

server.listen(port, host, () => {
  console.log(`Schematic Analyzer — http://localhost:${port}`);
  console.log(`  serving   ${distDir}`);
  console.log(`  shared library in ${dataDir}`);
});
