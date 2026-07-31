/**
 * pdf.js worker entry point.
 *
 * pdf.js ships its worker as a standalone module, but that module needs the
 * same compatibility shims the main thread does — a worker starts with fresh
 * globals, so a `Map.prototype` patched on the page means nothing here.
 * Wrapping the stock worker is the only place the shim can be installed before
 * pdf.js runs, and it is why `loadPdf` builds its worker from this file rather
 * than pointing `workerSrc` straight at the package.
 */

import './compat'
import 'pdfjs-dist/build/pdf.worker.mjs'
