import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
// @ts-expect-error -- plain JS, shared verbatim with the production server.
import { createLibraryApi } from './server/store.mjs';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Put pdf.js's data files where the app can fetch them.
 *
 * pdf.js ships its standard fonts, CJK character maps, ICC profiles and wasm
 * decoders as loose files rather than bundling them, and refuses to guess where
 * they live: given no URL it asks for them on a path relative to the worker,
 * which under a dev server resolves to the SPA fallback. It then receives HTML
 * where it expected a font and the render promise never settles -- the page
 * simply hangs on "Loading" with nothing in the console.
 *
 * The CJK maps are the ones that matter most here. A Japanese schematic drawn
 * as vector PDF references its kanji through an Adobe CMap, and without these
 * files none of that text can be read at all.
 *
 * Copied into `public/` rather than imported, because these are hundreds of
 * loose files that no bundler should be asked to graph.
 */
function pdfjsAssets(): Plugin {
  const copy = () => {
    const from = resolve(root, 'node_modules/pdfjs-dist');
    const to = resolve(root, 'public/pdfjs');
    if (!existsSync(from)) return;
    mkdirSync(to, { recursive: true });
    for (const dir of ['standard_fonts', 'cmaps', 'iccs', 'wasm']) {
      if (existsSync(resolve(from, dir))) {
        cpSync(resolve(from, dir), resolve(to, dir), { recursive: true });
      }
    }
  };
  return {
    name: 'pdfjs-assets',
    // Runs for `vite dev`, `vite build` and `vite preview` alike, so the files
    // are never missing in one mode and present in another.
    config: copy,
  };
}

/**
 * Mount the shared library API on the dev and preview servers.
 *
 * The same handler the production server uses, so development is not a
 * different app with a different store -- and so a phone on the Wi-Fi is
 * editing the same schematics as the laptop that started the server.
 */
function sharedLibrary(): Plugin {
  const api = createLibraryApi({ dataDir: resolve(root, 'data') });
  const middleware = (req: unknown, res: unknown, next: () => void) => {
    Promise.resolve(api(req, res)).then((handled: boolean) => {
      if (!handled) next();
    }, next);
  };
  return {
    name: 'shared-library',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  // Relative base so the built app works from a subpath (GitHub Pages) as well
  // as from a domain root, without needing a rebuild.
  base: './',

  server: {
    // Fixed and deliberately clear of the other dev servers on this machine
    // (3000, 5005, 8000, 8080, 8443). strictPort surfaces a collision loudly
    // rather than silently drifting onto another port.
    port: 5173,
    strictPort: true,
    // Listen on all interfaces so a phone on the same Wi-Fi can reach this for
    // real-device testing. Note this makes the dev server visible to anything
    // on the local network -- fine on a home LAN, not on shared/public Wi-Fi.
    host: true,
  },

  preview: {
    port: 4173,
    strictPort: true,
  },

  plugins: [
    pdfjsAssets(),
    sharedLibrary(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Schematic Analyzer',
        short_name: 'Schematic',
        description:
          'Analyse scanned Japanese schematics: trace nets, classify rails and buses, translate annotations, and export an annotated overlay.',
        theme_color: '#0a84ff',
        background_color: '#f2f2f7',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // pdf.js and tesseract.js are large; the default 2MB cap would quietly
        // leave them out of the offline precache.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        // pdf.js's data files are nearly 4MB of fonts, CJK maps and decoders,
        // and most of any given install will never touch them -- the JPEG2000
        // and PDF-JavaScript engines in particular. Precaching all of it would
        // put four megabytes on a phone before the first schematic is opened,
        // so they are fetched on demand and kept from then on instead. First
        // use of a PDF needs the network; every use after that does not.
        globIgnores: ['**/pdfjs/**'],
        runtimeCaching: [
          {
            urlPattern: /\/pdfjs\/.*\.(?:pfb|bcmap|icc|wasm|js)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-assets',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Tesseract's wasm core and language packs come from jsDelivr on
            // first use. Cached so later runs work with no network at all.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-assets',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Keep the service worker out of the way during development.
        enabled: false,
      },
    }),
  ],

  build: {
    rollupOptions: {
      output: {
        // Split the two heavy dependencies out; neither is needed until a file
        // is actually opened.
        manualChunks(id: string) {
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('tesseract.js')) return 'tesseract';
          return undefined;
        },
      },
    },
  },
});
