import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Where the built app will be served from.
 *
 * A relative base is the default because it works from any subpath without a
 * rebuild. GitHub Pages project sites need the real path anyway: the service
 * worker's navigation fallback and the manifest's scope are resolved against
 * the origin, not against the page, so './' would scope the PWA to the domain
 * root and the installed app would open a 404. CI sets BASE_PATH=/<repo>/.
 */
const base = process.env.BASE_PATH ?? './'
const relativeBase = base === './'

/**
 * Phones reach the dev server by LAN IP, which isn't a secure context over
 * plain http — no service worker, no install prompt, no crypto.randomUUID.
 * A self-signed cert buys those back. Off by default: localhost is already
 * secure, and the cert costs you an interstitial.
 */
const httpsDev = process.env.HTTPS === '1'

/**
 * Put pdf.js's data files where the app can fetch them.
 *
 * pdf.js ships its standard fonts, CJK character maps, ICC profiles and wasm
 * decoders as loose files rather than bundling them, and refuses to guess where
 * they live: given no URL it asks for them on a path relative to the worker,
 * which under a dev server resolves to the SPA fallback. It then receives HTML
 * where it expected a font and the render promise never settles — the page
 * simply hangs with nothing in the console.
 *
 * The CJK maps matter most here. A Japanese service manual drawn as vector PDF
 * references its kanji through an Adobe CMap, and without these files none of
 * that text renders at all.
 *
 * Copied into public/ rather than imported, because these are hundreds of loose
 * files that no bundler should be asked to graph.
 */
function pdfjsAssets(): Plugin {
  const copy = () => {
    const from = resolve(root, 'node_modules/pdfjs-dist')
    const to = resolve(root, 'public/pdfjs')
    if (!existsSync(from)) return
    mkdirSync(to, { recursive: true })
    for (const dir of ['standard_fonts', 'cmaps', 'iccs', 'wasm']) {
      if (existsSync(resolve(from, dir))) {
        cpSync(resolve(from, dir), resolve(to, dir), { recursive: true })
      }
    }
  }
  return {
    name: 'pdfjs-assets',
    // Runs for dev, build and preview alike, so the files are never missing in
    // one mode and present in another.
    config: copy,
  }
}

export default defineConfig({
  base,

  server: {
    // Deliberately clear of the other dev servers on this machine (3000, 5000,
    // 5005, 5173, 5180, 8000, 8080, 8443). strictPort surfaces a collision
    // loudly rather than silently drifting onto another port.
    port: 5190,
    strictPort: true,
    // Listen on all interfaces so a phone on the same Wi-Fi can reach this for
    // real-device testing. Note this makes the dev server visible to anything
    // on the local network — fine on a home LAN, not on shared Wi-Fi.
    host: true,
  },

  preview: {
    port: 4190,
    strictPort: true,
    // Vite's host check 403s anything but localhost, which blocks a tunnelled
    // or Tailscale-fronted preview.
    allowedHosts: ['.ts.net'],
  },

  plugins: [
    pdfjsAssets(),
    react(),
    ...(httpsDev ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      // The service worker is production-only by default, so opt in for the
      // https dev run — otherwise there's nothing on-device to test.
      devOptions: { enabled: httpsDev, type: 'module' },
      manifest: {
        name: 'Schematic Analyzer',
        short_name: 'Schematic',
        description:
          'Upload a schematic and get a block diagram, the power rails, the grounds, the test points and what every LED means.',
        theme_color: '#070b12',
        background_color: '#070b12',
        display: 'standalone',
        orientation: 'any',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The pdf.js worker alone is over the 2MB default.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
        // pdf.js's data files are nearly 4MB of fonts, CJK maps and decoders,
        // and most of any given install will never touch them. Precaching all
        // of it would put four megabytes on a phone before the first sheet is
        // opened, so they are fetched on demand and kept from then on instead.
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
        ],
        // Left bare under a relative base: workbox resolves this against the
        // service worker's own scope, and a leading './' there is not the same
        // thing as the served path.
        navigateFallback: relativeBase ? 'index.html' : `${base}index.html`,
      },
    }),
  ],
})
