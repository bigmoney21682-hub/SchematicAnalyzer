/**
 * PDF support exists because that is the form a schematic actually arrives in.
 * Service manuals are PDFs; the sheet you want is page 47 of 210, and asking
 * someone to screenshot it on a phone first is exactly the friction this app is
 * meant to remove.
 *
 * Two things matter here and nothing else does:
 *
 * 1. Render at the resolution the text needs, not at the PDF's nominal size. A
 *    vector schematic has infinite detail available; rasterising it at 72 dpi
 *    throws that away and no later step gets it back. We scale so the long edge
 *    lands near what the analysis wants.
 * 2. Composite onto white. PDF pages have no background of their own, and a
 *    schematic rendered onto transparency is black lines on nothing — which
 *    encodes to black-on-black the moment it hits a JPEG.
 */
// Must come first: pdf.js calls a handful of very recent JS methods unguarded,
// and on iOS Safari the failure is an opaque "getOrInsertComputed is not a
// function" before a single page renders.
import './compat'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * pdf.js ships its character maps and standard fonts as loose files and refuses
 * to guess where they live. The CJK maps are the ones that matter here: a
 * Japanese service manual drawn as vector PDF references its kanji through an
 * Adobe CMap, and without these files that text renders as nothing at all.
 * A Vite plugin copies them into public/pdfjs at build and dev time.
 */
const assetRoot = new URL('pdfjs/', document.baseURI).href
const DOC_OPTIONS = {
  cMapUrl: `${assetRoot}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetRoot}standard_fonts/`,
  wasmUrl: `${assetRoot}wasm/`,
  iccUrl: `${assetRoot}iccs/`,
}

/** Long edge for the page actually sent for analysis. Matches image.ts. */
const RENDER_EDGE = 3072

/** Long edge for the page chips in the picker. Small enough to build 200 of. */
const THUMB_EDGE = 260

/**
 * Above this, rendering every page up front would lock the phone up for a
 * minute. Past it the picker renders thumbnails lazily as they scroll in.
 */
const EAGER_THUMB_LIMIT = 24

export interface PdfPage {
  /** 1-based, as printed in every PDF UI on earth. */
  number: number
  /** data: URL of the preview chip. Empty until it has been rendered. */
  thumbnail: string
}

export interface LoadedPdf {
  name: string
  pageCount: number
  /** Renders one page at analysis resolution. */
  render(pageNumber: number): Promise<Blob>
  /** Renders one page small, for the picker. */
  thumbnail(pageNumber: number): Promise<string>
  /** Whether the picker should render every thumbnail up front. */
  eagerThumbnails: boolean
  close(): void
}

export async function loadPdf(file: File): Promise<LoadedPdf> {
  const data = new Uint8Array(await file.arrayBuffer())

  // Our own worker module, which installs the same shims worker-side. Only if
  // the browser refuses a module worker do we fall back to the stock one, which
  // misses the shims — but that beats failing outright, and nothing we support
  // is expected to take that path.
  let worker: Worker | null = null
  try {
    worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' })
    pdfjs.GlobalWorkerOptions.workerPort = worker
  } catch {
    pdfjs.GlobalWorkerOptions.workerPort = null
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.mjs?url')
    ).default
  }

  let doc: PDFDocumentProxy
  try {
    doc = await pdfjs.getDocument({ data, ...DOC_OPTIONS }).promise
  } catch (e) {
    worker?.terminate()
    const message = e instanceof Error ? e.message : ''
    if (/password/i.test(message))
      throw new Error('This PDF is password-protected. Unlock it and try again.')
    throw new Error('Could not open that PDF. It may be damaged or not really a PDF.')
  }

  async function draw(pageNumber: number, longEdge: number): Promise<HTMLCanvasElement> {
    const page = await doc.getPage(pageNumber)
    const base = page.getViewport({ scale: 1 })
    const scale = longEdge / Math.max(base.width, base.height)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D canvas context.')

    // See the note at the top: a schematic on transparency is invisible.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // 'print', not the default 'display'. Nothing here paints a PDF to the
    // screen — every render is an offscreen rasterisation whose pixels are then
    // copied out. That matters because for the display intent pdf.js drives its
    // render loop with requestAnimationFrame, which a browser does not fire for
    // a hidden tab: switch apps on a phone while a page is rendering, which is
    // the normal thing to do while waiting, and the render stops dead with no
    // error and no timeout. The print intent schedules without rAF and finishes
    // whether the tab is on screen or not.
    await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise
    page.cleanup()
    return canvas
  }

  return {
    name: file.name,
    pageCount: doc.numPages,
    eagerThumbnails: doc.numPages <= EAGER_THUMB_LIMIT,

    async render(pageNumber: number): Promise<Blob> {
      const canvas = await draw(pageNumber, RENDER_EDGE)
      // PNG, not JPEG: this is line art going straight into the analysis path,
      // and prepareImage will hand a lossless page through untouched rather
      // than re-encoding it. JPEG here would bake ringing around every glyph
      // before anything else got a look at it.
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not render that page.')
      return blob
    },

    async thumbnail(pageNumber: number): Promise<string> {
      try {
        const canvas = await draw(pageNumber, THUMB_EDGE)
        return canvas.toDataURL('image/jpeg', 0.7)
      } catch {
        // One bad page should not empty the whole picker.
        return ''
      }
    },

    close() {
      // Teardown lives on the loading task, not the document. And a
      // port-provided worker is pdf.js's to talk to but ours to shut down — it
      // only terminates workers it spawned itself, so one would leak per PDF.
      doc.loadingTask
        .destroy()
        .catch(() => {})
        .finally(() => {
          if (pdfjs.GlobalWorkerOptions.workerPort === worker) {
            pdfjs.GlobalWorkerOptions.workerPort = null
          }
          worker?.terminate()
        })
    },
  }
}
