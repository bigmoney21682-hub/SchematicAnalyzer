/**
 * Where pdf.js should look for its data files.
 *
 * pdf.js keeps four things outside its bundle -- the standard Type1 fonts, the
 * Adobe CJK character maps, the ICC colour profiles and the wasm image decoders
 * -- and will not guess where they are. Given no URL it asks for them on a path
 * relative to its worker, which in this app lands on the SPA fallback: it gets
 * an HTML document where it expected a font, and the render promise never
 * settles. The symptom is a page stuck on "Loading" with an empty console,
 * which is a genuinely hard thing to track down from the outside.
 *
 * The character maps are the ones that matter most here. A Japanese schematic
 * drawn as vector PDF -- rather than scanned -- references its kanji through one
 * of these maps, and without them that text cannot be read at all.
 *
 * The files themselves are copied out of the package into `public/pdfjs` by a
 * plugin in `vite.config.ts`.
 */

/**
 * Base URL for the data directories, honouring the app's relative `base`.
 *
 * `import.meta.env.BASE_URL` is what makes this work from a subpath as well as
 * from a domain root, which the build is deliberately set up to allow.
 */
function assetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(`${base.endsWith('/') ? base : `${base}/`}pdfjs/`, window.location.href).href;
}

/** Spread into every `getDocument` call. */
export function pdfAssetOptions() {
  const base = assetBase();
  return {
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    // The shipped maps are the binary ones.
    cMapPacked: true,
    iccUrl: `${base}iccs/`,
    wasmUrl: `${base}wasm/`,
  };
}

/**
 * Render intent for every PDF raster this app produces.
 *
 * Nothing here paints a PDF to the screen. Each render is an offscreen
 * rasterisation -- the analysis raster, a zoomed-in detail tile, the sheet OCR
 * reads -- which is drawn to a canvas we then copy pixels out of.
 *
 * That distinction matters more than it looks. For its default 'display'
 * intent, pdf.js drives the render loop with `requestAnimationFrame`, and a
 * browser does not fire those for a tab that is not visible. Background the tab
 * -- switch apps on a phone while a twenty-sheet manual is being analysed,
 * which is the normal thing to do while waiting -- and every render in flight
 * stops dead and never resolves. No error, no timeout: analysis simply hangs on
 * a progress bar until the app is reloaded, losing the run.
 *
 * 'print' is the intent pdf.js provides for exactly this -- rendering to an
 * offscreen surface at full fidelity -- and it schedules its work without
 * `requestAnimationFrame`, so a render started here finishes whether the tab is
 * on screen or not.
 */
export const OFFSCREEN_INTENT = 'print' as const;
