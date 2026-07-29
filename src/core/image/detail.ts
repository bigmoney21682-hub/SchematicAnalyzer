/**
 * High-resolution redraw of the patch you are looking at.
 *
 * The analysis raster is capped at 2600px on its long edge -- the resolution
 * the tracer and OCR want, and no more. Past roughly 150% zoom the viewport is
 * magnifying that raster, so the drawing's own printed text goes soft exactly
 * when you lean in to read a part number.
 *
 * The fix is not a bigger raster: a full-page scan at screen resolution is tens
 * of megabytes decoded, and several of those is how a phone loses its canvas.
 * Instead the original upload is kept, and only the *visible rectangle* is
 * re-rendered, at the resolution the screen can actually show:
 *
 *   - a photo or scan is re-cropped from the full-resolution original;
 *   - a PDF is re-rendered from its vectors, which is sharp at any zoom.
 *
 * Cost is bounded by the size of the window, not by the size of the drawing, so
 * a fifteen-sheet manual costs exactly as much as a one-sheet one.
 *
 * The catch is that the sheet on screen is not the source: it has been scaled
 * to the analysis size, deskewed by a fraction of a degree, and possibly turned
 * by the user. `originToPage` composes those three into one matrix so the
 * re-rendered patch lands on the ink it replaces, to the pixel.
 */

import type { PageOrigin, Rect, SourcePage } from '../model/types';
import { getSource } from '../../storage/db';
import { OFFSCREEN_INTENT, pdfAssetOptions } from './pdf-assets';

/** Canvas-order affine matrix: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

/** `outer` applied after `inner`. */
function mul(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Axis-aligned box containing a rect after it is put through a matrix. */
function mapRect(m: Matrix, r: Rect): Rect {
  const pts = [
    apply(m, r.x, r.y),
    apply(m, r.x + r.w, r.y),
    apply(m, r.x, r.y + r.h),
    apply(m, r.x + r.w, r.y + r.h),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Page units per unit of the original.
 *
 * Deskew and quarter turns are rigid, so the whole chain has exactly one scale
 * factor in it and this is it.
 */
function originScale(page: SourcePage, origin: PageOrigin): number {
  const rot = ((((page.rotation ?? 0) % 360) + 360) % 360);
  const bw = rot === 90 || rot === 270 ? page.height : page.width;
  return bw / origin.naturalWidth;
}

/**
 * The transform from the original's own coordinates into page coordinates.
 *
 * Three steps, in the order the pipeline applied them: scale to the analysis
 * size, rotate by the deskew correction about the sheet's centre, then apply
 * whatever quarter turns the user has made. The quarter-turn matrices are the
 * same mappings `edit/rotate` uses on the geometry, written as matrices.
 */
export function originToPage(page: SourcePage, origin: PageOrigin): Matrix {
  const rot = ((((page.rotation ?? 0) % 360) + 360) % 360);
  const swapped = rot === 90 || rot === 270;
  // Size of the raster before any quarter turns -- the frame deskew worked in.
  const bw = swapped ? page.height : page.width;
  const bh = swapped ? page.width : page.height;

  const s = originScale(page, origin);
  let m: Matrix = [s, 0, 0, s, 0, 0];

  // `deskewPage` rotates the image by -angle about the centre of the sheet.
  const theta = (-(page.deskewAngle || 0) * Math.PI) / 180;
  if (theta) {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const cx = bw / 2;
    const cy = bh / 2;
    m = mul([cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy], m);
  }

  if (rot === 90) m = mul([0, 1, -1, 0, bh, 0], m);
  else if (rot === 180) m = mul([-1, 0, 0, -1, bw, bh], m);
  else if (rot === 270) m = mul([0, -1, 1, 0, 0, bw], m);

  return m;
}

/**
 * The rigid half of `originToPage`, restated in a raster scaled by `k`.
 *
 * `originToPage` is one scale factor followed by a rotation and a translation.
 * pdf.js is given the scale through its viewport, so what it still needs is the
 * rotation and translation on their own -- with the translation expressed in
 * the output raster's pixels rather than in page units.
 */
function rigidPart(toPage: Matrix, s: number, k: number): Matrix {
  const r = mul(toPage, [1 / s, 0, 0, 1 / s, 0, 0]);
  return [r[0], r[1], r[2], r[3], r[4] * k, r[5] * k];
}

// ---------------------------------------------------------------------------

export interface DetailTile {
  /** Sheet this belongs to. */
  page: number;
  /** Region of the sheet it covers, in page coordinates. */
  rect: Rect;
  /** Device pixels per page unit that it was rendered at. */
  scale: number;
  bitmap: ImageBitmap;
}

/**
 * Ceiling on a tile's pixels.
 *
 * Sized for the window rather than the drawing. It has to be at least the
 * canvas backing store's own budget, because a tile smaller than the canvas it
 * is painted into arrives pre-blurred no matter how sharp the source was --
 * which is exactly what a laptop-sized window used to get.
 */
const MAX_TILE_PIXELS = 4_200_000;

/** Below this magnification the analysis raster is already sharp enough. */
const MIN_USEFUL_SCALE = 1.15;

/** A PDF is vector, but re-rendering it at 30x costs real time for no gain. */
const MAX_PDF_SCALE = 12;

/** Grow the requested region a little, so a small pan does not need a new tile. */
const MARGIN = 0.12;

/**
 * The loading task rather than the document, because tearing a PDF down goes
 * through the task -- and leaking one leaks the worker behind it.
 */
type PdfTask = ReturnType<(typeof import('pdfjs-dist'))['getDocument']>;

/**
 * Per-document access to the originals.
 *
 * Holds the decoded PDF handles and the fetched blobs, because re-opening a
 * 30MB PDF for every pan would be far more expensive than the render itself.
 * Owned by the viewport and disposed with it.
 */
export class DetailSource {
  private blobs = new Map<string, { blob: Blob; kind: 'image' | 'pdf' } | null>();
  private pdfs = new Map<string, Promise<PdfTask>>();
  private worker: Worker | null = null;
  private disposed = false;

  /**
   * Seed the blob cache with originals already in hand.
   *
   * The viewport looks its originals up in IndexedDB, but analysis runs before
   * they have been written there -- the caller buffers them and stores them
   * once the run succeeds. Handing them over directly is what lets a sheet be
   * OCR'd from its own vectors on the very first pass rather than the next one.
   */
  prime(records: Array<{ key: string; blob: Blob; kind: 'image' | 'pdf' }>): void {
    for (const r of records) this.blobs.set(r.key, { blob: r.blob, kind: r.kind });
  }

  /** True if this sheet has an original worth re-rendering from. */
  static canRefine(page: SourcePage): boolean {
    if (!page.origin) return false;
    if (page.origin.kind === 'pdf') return true;
    const rot = ((((page.rotation ?? 0) % 360) + 360) % 360);
    const bw = rot === 90 || rot === 270 ? page.height : page.width;
    // An original no bigger than the analysis raster has nothing more to give.
    return page.origin.naturalWidth > bw * MIN_USEFUL_SCALE;
  }

  /**
   * The magnification a sheet can usefully be redrawn at, in device pixels per
   * page unit. Beyond this the original has no more detail to offer.
   */
  static ceiling(page: SourcePage): number {
    const origin = page.origin;
    if (!origin) return 1;
    if (origin.kind === 'pdf') return MAX_PDF_SCALE;
    const rot = ((((page.rotation ?? 0) % 360) + 360) % 360);
    const bw = rot === 90 || rot === 270 ? page.height : page.width;
    return origin.naturalWidth / bw;
  }

  /**
   * Render the visible region of a sheet at `deviceScale` device px per page
   * unit, or resolve null when the base raster is already good enough.
   */
  async tile(
    page: SourcePage,
    visible: Rect,
    deviceScale: number,
    signal?: AbortSignal,
  ): Promise<DetailTile | null> {
    const origin = page.origin;
    if (!origin || this.disposed) return null;

    let scale = Math.min(deviceScale, DetailSource.ceiling(page));
    if (scale < MIN_USEFUL_SCALE) return null;

    // The margin is a convenience -- it saves a re-render when you nudge the
    // view -- so it is the first thing to go when the budget is tight. Spending
    // the budget on off-screen padding and then paying for it by softening what
    // is actually on screen is the wrong trade in every case.
    const onScreen = clipRect(visible, page.width, page.height);
    if (onScreen.w < 1 || onScreen.h < 1) return null;

    let margin = MARGIN;
    const needed = (m: number) =>
      (onScreen.w * (1 + 2 * m)) * (onScreen.h * (1 + 2 * m)) * scale * scale;
    while (margin > 0 && needed(margin) > MAX_TILE_PIXELS) {
      margin = Math.max(0, margin - 0.02);
    }

    const pad = { x: visible.w * margin, y: visible.h * margin };
    const rect = clipRect(
      { x: visible.x - pad.x, y: visible.y - pad.y, w: visible.w + pad.x * 2, h: visible.h + pad.y * 2 },
      page.width,
      page.height,
    );
    if (rect.w < 1 || rect.h < 1) return null;

    // Only once there is no padding left to give does magnification suffer: a
    // sharp-but-not-quite-native patch still beats a correctly-scaled quarter
    // of one. In practice this is reached only on a very large window.
    const demand = rect.w * rect.h * scale * scale;
    if (demand > MAX_TILE_PIXELS) scale *= Math.sqrt(MAX_TILE_PIXELS / demand);
    if (scale < MIN_USEFUL_SCALE) return null;

    const source = await this.load(origin.key);
    if (!source || signal?.aborted || this.disposed) return null;

    const toPage = originToPage(page, origin);
    const toOrigin = invert(toPage);
    // Device pixels per unit of the original -- the resolution to fetch at.
    const pixelsPerOriginUnit = scale * originScale(page, origin);

    const region = clipRect(mapRect(toOrigin, rect), origin.naturalWidth, origin.naturalHeight);
    if (region.w < 1 || region.h < 1) return null;

    const patch =
      source.kind === 'pdf'
        ? await this.renderPdfRegion(origin, region, pixelsPerOriginUnit)
        : await this.decodeImageRegion(source.blob, region);
    if (!patch || signal?.aborted || this.disposed) {
      close(patch);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.w * scale));
    canvas.height = Math.max(1, Math.round(rect.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      close(patch);
      return null;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Tile pixels -> page units -> the original's own units, so the patch can be
    // painted at the place in the original it was cut from.
    ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
    ctx.transform(...toPage);
    ctx.drawImage(patch, region.x, region.y, region.w, region.h);
    close(patch);

    if (signal?.aborted || this.disposed) return null;
    const bitmap = await createImageBitmap(canvas);
    if (signal?.aborted || this.disposed) {
      bitmap.close();
      return null;
    }

    return { page: page.index, rect, scale, bitmap };
  }

  /**
   * Render a whole sheet at OCR resolution, in page coordinates.
   *
   * The analysis raster is capped at 2600px on its long edge because that is
   * what the tracer needs, and on a service-manual sheet that leaves a printed
   * reference designator about twelve pixels tall. Tesseract wants nearer
   * thirty, and below roughly twenty its recall on short tokens collapses --
   * which is why a perfectly legible "55C" came back as nothing at all.
   *
   * Upscaling the 2600px raster does help Tesseract, but it invents no detail.
   * A PDF has the real thing still in it, so this re-renders the page from the
   * vectors at the resolution the recogniser actually wants. Sized so neither
   * axis passes 4096px, which is where the oldest iOS devices we care about
   * stop allocating canvases at all.
   *
   * Output is in page coordinates scaled by the returned `scale`, so a box at
   * (x, y) on this canvas is at (x/scale, y/scale) on the sheet -- deskew and
   * user rotation included, because `originToPage` carries both.
   *
   * Resolves null when there is nothing better than the analysis raster.
   */
  async ocrPage(page: SourcePage, longEdge: number, maxPixels: number): Promise<{ canvas: HTMLCanvasElement; scale: number } | null> {
    const origin = page.origin;
    if (!origin || this.disposed) return null;

    const source = await this.load(origin.key);
    if (!source || this.disposed) return null;

    // Page units per page unit -- how much bigger than the analysis raster.
    let scale = longEdge / Math.max(page.width, page.height);
    const area = page.width * page.height * scale * scale;
    if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
    // A photo cannot be sharpened past its own resolution, and re-rendering a
    // page for a few percent is not worth the seconds it costs on a phone.
    scale = Math.min(scale, DetailSource.ceiling(page));
    if (scale < 1.2) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(page.width * scale);
    canvas.height = Math.round(page.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const toPage = originToPage(page, origin);

    if (source.kind === 'pdf') {
      try {
        const doc = await (await this.pdfTask(origin.key)).promise;
        const pdfPage = await doc.getPage(origin.pdfPage ?? 1);
        // The viewport carries the whole magnification, so pdf.js rasterises
        // the vectors at final resolution rather than scaling a smaller render.
        // What is left for `transform` is the rigid part of `originToPage` --
        // deskew and quarter turns -- with its translation put into output px.
        const pixelsPerOriginUnit = scale * originScale(page, origin);
        const rigid = rigidPart(toPage, originScale(page, origin), scale);
        await pdfPage.render({
          canvas,
          canvasContext: ctx,
          viewport: pdfPage.getViewport({ scale: pixelsPerOriginUnit }),
          transform: rigid,
          intent: OFFSCREEN_INTENT,
        }).promise;
      } catch {
        return null;
      }
    } else {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(source.blob);
      } catch {
        return null;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.transform(...toPage);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    if (this.disposed) return null;
    return { canvas, scale };
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pdfs.values()) {
      pending.then((task) => task.destroy()).catch(() => {});
    }
    this.pdfs.clear();
    this.blobs.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  // -------------------------------------------------------------------------

  private async load(key: string) {
    const hit = this.blobs.get(key);
    if (hit !== undefined) return hit;
    const record = await getSource(key).catch(() => undefined);
    const value = record ? { blob: record.blob, kind: record.kind } : null;
    // A miss is cached too: documents analysed before originals were kept have
    // none, and re-asking the database on every frame would be pure cost.
    this.blobs.set(key, value);
    return value;
  }

  /** Crop straight out of the original file, without decoding all of it. */
  private async decodeImageRegion(blob: Blob, region: Rect): Promise<ImageBitmap | null> {
    const sx = Math.floor(region.x);
    const sy = Math.floor(region.y);
    const sw = Math.ceil(region.x + region.w) - sx;
    const sh = Math.ceil(region.y + region.h) - sy;
    try {
      return await createImageBitmap(blob, sx, sy, Math.max(1, sw), Math.max(1, sh));
    } catch {
      return null;
    }
  }

  /** Re-render a slice of the PDF's vectors at the resolution being displayed. */
  private async renderPdfRegion(
    origin: PageOrigin,
    region: Rect,
    pixelsPerUnit: number,
  ): Promise<HTMLCanvasElement | null> {
    try {
      const doc = await (await this.pdfTask(origin.key)).promise;
      const pdfPage = await doc.getPage(origin.pdfPage ?? 1);
      const viewport = pdfPage.getViewport({ scale: pixelsPerUnit });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(region.w * pixelsPerUnit));
      canvas.height = Math.max(1, Math.round(region.h * pixelsPerUnit));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Slide the page so the requested region lands at the canvas origin.
      await pdfPage.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, -region.x * pixelsPerUnit, -region.y * pixelsPerUnit],
        intent: OFFSCREEN_INTENT,
      }).promise;

      return canvas;
    } catch {
      // A PDF that will not re-render is not an error worth surfacing: the base
      // raster is still on screen and still correct, just softer.
      return null;
    }
  }

  private pdfTask(key: string): Promise<PdfTask> {
    const open = this.pdfs.get(key);
    if (open) return open;

    const pending = (async () => {
      const source = await this.load(key);
      if (!source) throw new Error('No stored original for this sheet.');

      await import('../compat/modern');
      const pdfjs = await import('pdfjs-dist');

      // One worker for the life of the viewport. `raster.ts` spins one up per
      // import because it runs once; this runs on every pan.
      if (!this.worker) {
        try {
          this.worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' });
        } catch {
          this.worker = null;
        }
      }
      if (this.worker) pdfjs.GlobalWorkerOptions.workerPort = this.worker;

      return pdfjs.getDocument({ data: await source.blob.arrayBuffer(), ...pdfAssetOptions() });
    })();

    this.pdfs.set(key, pending);
    pending.catch(() => this.pdfs.delete(key));
    return pending;
  }
}

function clipRect(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(r.x, w));
  const y = Math.max(0, Math.min(r.y, h));
  return { x, y, w: Math.max(0, Math.min(r.x + r.w, w) - x), h: Math.max(0, Math.min(r.y + r.h, h) - y) };
}

function close(source: ImageBitmap | HTMLCanvasElement | null): void {
  if (source && 'close' in source) source.close();
}
