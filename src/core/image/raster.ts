/**
 * Raster ingest and clean-up.
 *
 * Scanned service manuals arrive with uneven illumination, JPEG mush and a
 * degree or two of skew from the platen. Everything downstream (line finding,
 * OCR) is far more accurate on a deskewed binary image, so we do that work
 * once here and hand a clean `Bitmap` to the rest of the pipeline.
 */

import type { PageOrigin, SourcePage } from '../model/types';
import type { SourceRecord } from '../../storage/db';
import { OFFSCREEN_INTENT, pdfAssetOptions } from './pdf-assets';

/** 1-bit-per-pixel ink mask. `data[i] === 1` means ink (dark). */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Target long-edge resolution. Big enough for OCR, small enough to stay fast. */
const MAX_DIMENSION = 2600;
/** Render PDFs at a scale that lands near MAX_DIMENSION. */
const PDF_BASE_SCALE = 2.0;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Sheets, plus the original bytes they were made from. */
export interface LoadedPages {
  pages: SourcePage[];
  /** One record per input file, to be stored under the document's id. */
  sources: SourceRecord[];
}

/**
 * The biggest original we are willing to keep for high-resolution redraws.
 *
 * A 48-megapixel phone photo is nearly all noise at the scale that matters
 * here, and twenty of them would fill a phone's storage quota on their own.
 */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

/**
 * Turn everything the user gave us into one ordered list of sheets.
 *
 * A board's schematic arrives as a multi-page PDF, or as a folder of scans, or
 * -- on a phone -- as a handful of photos taken one after another. All three
 * are the same document, so they are flattened into a single sheet list in the
 * order the files were given, with each PDF contributing its pages in order.
 *
 * Each file is also handed back untouched, so the viewport can redraw from the
 * real thing instead of magnifying the analysis raster. `keyPrefix` namespaces
 * those records, and `startIndex` lets sheets be appended to a document later.
 */
export async function loadPages(
  files: File[] | File,
  startIndex = 0,
  onProgress?: (loaded: number, name: string) => void,
  keyPrefix = 'doc',
): Promise<LoadedPages> {
  const list = Array.isArray(files) ? files : [files];
  const pages: SourcePage[] = [];
  const sources: SourceRecord[] = [];

  for (const [i, file] of list.entries()) {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    // Namespaced by the sheet the file starts at, so appending files to a
    // document later cannot collide with the keys already stored.
    const key = `${keyPrefix}/f${startIndex + i}`;
    const keep = file.size <= MAX_SOURCE_BYTES;

    const loaded = isPdf ? await loadPdf(file, keep ? key : undefined) : [await loadImage(file, keep ? key : undefined)];
    for (const page of loaded) {
      pages.push({ ...page, index: startIndex + pages.length, sourceName: file.name });
    }
    if (keep) {
      sources.push({ key, docId: keyPrefix, blob: file, kind: isPdf ? 'pdf' : 'image' });
    }
    onProgress?.(pages.length, file.name);
  }

  return { pages, sources };
}

async function loadImage(file: File, originKey?: string): Promise<SourcePage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const origin: PageOrigin | undefined = originKey
    ? { key: originKey, kind: 'image', naturalWidth: bitmap.width, naturalHeight: bitmap.height }
    : undefined;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return {
    index: 0,
    width: w,
    height: h,
    dataUrl: encodePage(canvas, file.type),
    deskewAngle: 0,
    sourcePage: 1,
    origin,
  };
}

/**
 * Encode a sheet's raster for storage.
 *
 * A twenty-sheet manual is twenty full-page rasters held in memory and written
 * to IndexedDB, and PNG of a photographed page runs to several megabytes each
 * -- enough to exhaust a phone. Photos are already lossy, so re-encoding them
 * as high-quality JPEG costs nothing real and cuts that by roughly a factor of
 * five. Line art that arrived lossless (PNG, or a vector PDF we rendered
 * ourselves) stays lossless, because JPEG ringing on hairline conductors is
 * exactly the kind of damage this app must not introduce.
 */
function encodePage(canvas: HTMLCanvasElement, sourceType: string): string {
  const lossy = /jpeg|jpg|heic|heif|webp/i.test(sourceType);
  return lossy ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
}

async function loadPdf(file: File, originKey?: string): Promise<SourcePage[]> {
  // Loaded lazily: pdf.js is heavy and image-only users never need it.
  // The shims must be in place before any of it runs -- see compat/modern.
  await import('../compat/modern');
  const pdfjs = await import('pdfjs-dist');

  // Our own worker module, which installs the same shims worker-side. Only if
  // the browser refuses a module worker do we fall back to the stock one, which
  // is a bigger download and misses the shims -- but it is better than failing
  // outright, and nothing we support is expected to take that path.
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' });
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  } catch {
    pdfjs.GlobalWorkerOptions.workerPort = null;
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
  }

  const buf = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buf, ...pdfAssetOptions() });

  try {
    const doc = await loadingTask.promise;
    const pages: SourcePage[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const fit = MAX_DIMENSION / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale: Math.min(PDF_BASE_SCALE, fit) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: ctx, viewport, intent: OFFSCREEN_INTENT }).promise;

      pages.push({
        index: i - 1,
        width: canvas.width,
        height: canvas.height,
        dataUrl: canvas.toDataURL('image/png'),
        deskewAngle: 0,
        sourcePage: i,
        origin: originKey
          ? {
              key: originKey,
              kind: 'pdf',
              pdfPage: i,
              naturalWidth: base.width,
              naturalHeight: base.height,
            }
          : undefined,
      });
    }

    return pages;
  } finally {
    // A port-provided worker is pdf.js's to talk to but ours to shut down; it
    // only terminates workers it spawned itself, so one would leak per PDF.
    await loadingTask.destroy().catch(() => {});
    pdfjs.GlobalWorkerOptions.workerPort = null;
    worker?.terminate();
  }
}

/**
 * Decode a data URL to an ImageBitmap.
 *
 * Deliberately avoids `HTMLImageElement.decode()`: on a detached image element
 * that promise can simply never settle in Chrome, which strands the whole
 * pipeline on a progress screen with no error to show. `createImageBitmap`
 * over a Blob is reliable, faster, and off the main thread.
 */
export async function decodeDataUrl(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

export async function pageToImageData(page: SourcePage): Promise<ImageData> {
  const bitmap = await decodeDataUrl(page.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, page.width, page.height);
}

// ---------------------------------------------------------------------------
// Greyscale + threshold
// ---------------------------------------------------------------------------

export function toGray(img: ImageData): Uint8Array {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma, integer-scaled to avoid float work in a hot loop.
    out[p] = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8;
  }
  return out;
}

/**
 * Adaptive threshold using an integral image.
 *
 * A global Otsu threshold loses whole regions on scans with a shadow gradient
 * down one side -- extremely common when a thick manual is photographed. A
 * local mean with a small bias handles that robustly and runs in O(n).
 */
export function binarize(gray: Uint8Array, width: number, height: number): Bitmap {
  const radius = Math.max(8, Math.round(Math.min(width, height) / 100));
  const bias = 0.9; // ink must be this much darker than local mean

  // Integral image, padded by one row/column for clean edge handling.
  const iw = width + 1;
  const integral = new Float64Array(iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      const mean = sum / area;
      data[y * width + x] = gray[y * width + x] < mean * bias ? 1 : 0;
    }
  }

  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Deskew
// ---------------------------------------------------------------------------

/**
 * Estimate skew by maximising the variance of the horizontal projection.
 *
 * Schematics are dense with long horizontal rules; when the image is square to
 * the axes those rules pile into a few projection bins and variance peaks.
 * We search +/-3 degrees, which covers realistic scanner/phone skew.
 */
export function estimateSkew(bm: Bitmap): number {
  const { width, height, data } = bm;
  // Subsample: skew estimation does not need full resolution.
  const step = Math.max(1, Math.floor(Math.min(width, height) / 600));
  let best = 0;
  let bestScore = -Infinity;

  for (let deg = -3; deg <= 3; deg += 0.25) {
    const slope = Math.tan((deg * Math.PI) / 180);
    const bins = new Float64Array(height);
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (!data[y * width + x]) continue;
        const yy = Math.round(y - (x - width / 2) * slope);
        if (yy >= 0 && yy < height) bins[yy]++;
      }
    }
    let mean = 0;
    for (let i = 0; i < height; i++) mean += bins[i];
    mean /= height;
    let variance = 0;
    for (let i = 0; i < height; i++) {
      const d = bins[i] - mean;
      variance += d * d;
    }
    if (variance > bestScore) {
      bestScore = variance;
      best = deg;
    }
  }
  return best;
}

/** Rotate a page's raster by `-angle` degrees, returning a new data URL. */
export async function deskewPage(page: SourcePage, angle: number): Promise<SourcePage> {
  if (Math.abs(angle) < 0.15) return page;

  const img = await decodeDataUrl(page.dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((-angle * Math.PI) / 180);
  ctx.drawImage(img, -page.width / 2, -page.height / 2);
  img.close();

  return { ...page, dataUrl: canvas.toDataURL('image/png'), deskewAngle: angle };
}

// ---------------------------------------------------------------------------
// Morphology helpers used by the tracer
// ---------------------------------------------------------------------------

/** Count of ink pixels -- used for the trace-coverage statistic. */
export function inkCount(bm: Bitmap): number {
  let n = 0;
  for (let i = 0; i < bm.data.length; i++) n += bm.data[i];
  return n;
}

/** Copy a bitmap. */
export function cloneBitmap(bm: Bitmap): Bitmap {
  return { width: bm.width, height: bm.height, data: new Uint8Array(bm.data) };
}

/**
 * Keep only runs of ink at least `minRun` long in the given direction.
 *
 * This is the classic "extract the rules from a form" trick: it isolates wire
 * runs and drops text glyphs, symbol bodies and dust in one pass.
 */
export function keepLongRuns(bm: Bitmap, dir: 'h' | 'v', minRun: number): Bitmap {
  const { width, height, data } = bm;
  const out = new Uint8Array(width * height);

  const outer = dir === 'h' ? height : width;
  const inner = dir === 'h' ? width : height;
  const idx = (o: number, i: number) => (dir === 'h' ? o * width + i : i * width + o);

  for (let o = 0; o < outer; o++) {
    let runStart = -1;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && data[idx(o, i)] === 1;
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        if (i - runStart >= minRun) {
          for (let k = runStart; k < i; k++) out[idx(o, k)] = 1;
        }
        runStart = -1;
      }
    }
  }
  return { width, height, data: out };
}

/** Pixel-wise OR. */
export function union(a: Bitmap, b: Bitmap): Bitmap {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] | b.data[i];
  return { width: a.width, height: a.height, data };
}

/** Pixels in `a` that are not in `b`. */
export function subtract(a: Bitmap, b: Bitmap): Bitmap {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i++) data[i] = a.data[i] && !b.data[i] ? 1 : 0;
  return { width: a.width, height: a.height, data };
}

/** Grow ink by one pixel in the 4-neighbourhood, `times` times. */
export function dilate(bm: Bitmap, times = 1): Bitmap {
  let cur = bm;
  for (let t = 0; t < times; t++) {
    const { width, height, data } = cur;
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (
          data[i] ||
          (x > 0 && data[i - 1]) ||
          (x < width - 1 && data[i + 1]) ||
          (y > 0 && data[i - width]) ||
          (y < height - 1 && data[i + width])
        ) {
          out[i] = 1;
        }
      }
    }
    cur = { width, height, data: out };
  }
  return cur;
}
