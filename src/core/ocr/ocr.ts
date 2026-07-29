/**
 * OCR over the schematic raster.
 *
 * Runs Tesseract with Japanese + English together, because these drawings mix
 * scripts constantly -- a katakana caption sitting next to "TA7358AP". The
 * language packs are fetched once and cached by tesseract.js in IndexedDB, so
 * subsequent (and offline) runs do not need the network.
 *
 * Recognition on a dense schematic is noisy by nature. We keep low-confidence
 * results rather than dropping them, but tag them so the UI can grey them out
 * and the rules engine can weight them down.
 *
 * Every sheet is read twice, in two different page-segmentation modes, because
 * a schematic is two documents superimposed. Tesseract's default mode does
 * layout analysis first -- it looks for columns and paragraphs, and it is what
 * gets the Japanese captions and the title block right. But a reference
 * designator is two or three characters floating alone in a field of wires,
 * with no block to belong to, and layout analysis discards it before the
 * classifier ever sees it. Sparse mode does no layout analysis at all and finds
 * exactly those. Neither mode alone reads a service manual; the union does, and
 * the second pass costs time rather than accuracy because the merge keeps
 * whichever reading was more confident.
 */

import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { Rect, TextItem } from '../model/types';
import { decodeDataUrl } from '../image/raster';
import { hasJapanese, reading, scriptOf, translate } from '../jp/lexicon';

let workerPromise: Promise<Worker> | null = null;

async function getWorker(onProgress?: (msg: string, pct: number) => void): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(['jpn', 'eng'], 1, {
      logger: (m: { status: string; progress: number }) => {
        if (onProgress) onProgress(m.status, m.progress);
      },
    });
  }
  return workerPromise;
}

export async function disposeOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

/**
 * What to recognise, and how its pixels relate to the sheet.
 *
 * `sourceScale` is pixels in this image per page unit. A canvas re-rendered
 * from a PDF's vectors at 1.6x says 1.6, and every box comes back divided by it
 * -- so the rest of the pipeline never has to know which resolution the text
 * was actually read at.
 */
export interface OcrSource {
  image: string | HTMLCanvasElement;
  sourceScale: number;
}

export interface OcrOptions {
  onProgress?: (msg: string, pct: number) => void;
  /** Drop results below this Tesseract confidence entirely. */
  minConfidence: number;
  /**
   * Further upscale applied before recognition; boxes are mapped back after.
   *
   * Tesseract wants roughly 30px of glyph height. Refdes and value text on a
   * schematic is small -- often 12-14px on a 1400px-wide sheet -- and recall
   * collapses at that size. Interpolation invents no detail, but Tesseract's
   * own line-finding and classifier genuinely do better on larger glyphs, so
   * this is worth doing even when there is no sharper original to draw on.
   */
  scale?: number;
}

/**
 * Choose an OCR upscale so small text lands in Tesseract's comfortable range.
 *
 * `longest` is the long edge of the image that will actually be recognised, so
 * a page already re-rendered at OCR resolution asks for no further upscale and
 * one stuck at the analysis raster's size asks for as much as it can get. The
 * ceiling exists because iOS refuses canvases past about 4096px on an axis.
 */
export function suggestOcrScale(pageWidth: number, pageHeight: number): number {
  const longest = Math.max(pageWidth, pageHeight);
  if (longest >= 3400) return 1;
  if (longest >= 2400) return 1.4;
  if (longest >= 1600) return 1.8;
  return 2.4;
}

/**
 * Upscale to a canvas rather than a data URL.
 *
 * Tesseract takes a canvas directly, and a full-page PNG encode plus decode of
 * a ten-megapixel image is several seconds and a second copy of the pixels --
 * on a phone, the thing that made a higher OCR resolution unaffordable at all.
 */
async function upscale(source: OcrSource['image'], factor: number): Promise<HTMLCanvasElement | string> {
  if (factor === 1) return source;
  const img = typeof source === 'string' ? await decodeDataUrl(source) : source;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * factor);
  canvas.height = Math.round(img.height * factor);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if ('close' in img) img.close();
  return canvas;
}

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Serialises access to the shared worker.
 *
 * There is one Tesseract worker for the whole app. Issuing a second
 * `recognize` while one is in flight does not queue -- it wedges, and the UI
 * sits on a progress screen forever. Chaining every call through one promise
 * makes overlapping requests wait their turn instead.
 */
let ocrQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = ocrQueue.then(job, job);
  // Keep the chain alive even if this job rejects.
  ocrQueue = run.catch(() => undefined);
  return run;
}

/**
 * Read a sheet, in both segmentation modes, and merge the two readings.
 *
 * The whole job is queued as one unit rather than as two, so the passes cannot
 * be separated by another sheet's work and leave the worker's page-segmentation
 * mode set to whatever the other sheet wanted.
 */
export function runOcr(
  source: OcrSource,
  opts: OcrOptions = { minConfidence: 30 },
): Promise<TextItem[]> {
  return enqueue(async () => {
    // Prepared once and recognised twice: the upscale is the expensive part,
    // and doing it per pass would double the memory for no benefit.
    const image = await upscale(source.image, opts.scale ?? 1);
    const scale = (opts.scale ?? 1) * source.sourceScale;

    const layout = await recognizeOnce(image, scale, PSM.AUTO, opts);
    const sparse = await recognizeOnce(image, scale, PSM.SPARSE_TEXT, opts).catch(() => []);
    return mergeReadings(layout, sparse);
  });
}

/**
 * Combine two readings of the same sheet, preferring the confident one.
 *
 * Two passes over one drawing return the same string twice for most of it, so
 * anything that lands on top of an existing box is a re-reading rather than a
 * new find: keep whichever Tesseract was surer of, and keep everything that
 * only one pass saw at all -- which, for the sparse pass, is the designators
 * this exists to recover.
 */
function mergeReadings(primary: TextItem[], extra: TextItem[]): TextItem[] {
  const out = [...primary];

  for (const cand of extra) {
    const hitIndex = out.findIndex((t) => overlapRatio(t.bbox, cand.bbox) > 0.5);
    if (hitIndex < 0) {
      out.push({ ...cand, id: `${cand.id}s` });
      continue;
    }
    const held = out[hitIndex];
    if (held.text === cand.text) continue;
    if (cand.confidence > held.confidence + 8) out[hitIndex] = { ...cand, id: held.id };
  }

  return out;
}

/** Intersection over the smaller of the two boxes. */
function overlapRatio(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? (ox * oy) / smaller : 0;
}

async function recognizeOnce(
  image: HTMLCanvasElement | string,
  scale: number,
  mode: PSM,
  opts: OcrOptions,
): Promise<TextItem[]> {
  const worker = await getWorker(opts.onProgress);
  await worker.setParameters({ tessedit_pageseg_mode: mode });
  const result = await worker.recognize(image, {}, { blocks: true });

  // tesseract.js surfaces words through blocks -> paragraphs -> lines -> words.
  const words: TessWord[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          words.push(w as unknown as TessWord);
        }
      }
    }
  }

  const tag = mode === PSM.SPARSE_TEXT ? 'p' : 't';
  const items: TextItem[] = [];
  words.forEach((w, i) => {
    const text = w.text.trim();
    if (!text) return;
    if (w.confidence < opts.minConfidence) return;
    // Single stray punctuation marks are almost always noise from wire ends.
    if (text.length === 1 && /[^A-Za-z0-9　-鿿]/.test(text)) return;

    // Map coordinates back into original page space.
    const bbox: Rect = {
      x: w.bbox.x0 / scale,
      y: w.bbox.y0 / scale,
      w: (w.bbox.x1 - w.bbox.x0) / scale,
      h: (w.bbox.y1 - w.bbox.y0) / scale,
    };

    const script = scriptOf(text);
    const item: TextItem = {
      id: `${tag}${i}`,
      page: 0, // stamped by tagSheet

      text,
      bbox,
      confidence: w.confidence,
      script,
      kind: classifyText(text),
    };

    if (hasJapanese(text)) attachTranslation(item);

    items.push(item);
  });

  return items;
}

/**
 * Fill in the English rendering, reading and coverage for a Japanese item.
 *
 * Every Japanese string gets a translation, including ones the lexicon only
 * partly understood -- a partial rendering carrying an explicit coverage figure
 * is more useful on the overlay than no rendering at all, and the UI greys down
 * the weak ones rather than presenting them as equals.
 */
function attachTranslation(item: TextItem): void {
  const { text: en, coverage } = translate(item.text);
  if (en && en !== item.text) item.translation = en;
  item.translationCoverage = coverage;
  const r = reading(item.text);
  if (r && r !== item.text) item.romaji = r;
}

// ---------------------------------------------------------------------------
// Text classification
// ---------------------------------------------------------------------------

/** Western convention: the letter leads. R12, IC3, CN1. */
const REFDES_RE = /^(?:R|C|CE|L|D|ZD|DZ|Q|TR|IC|U|VR|RV|X|XT|Y|J|CN|P|SW|S|RY|K|T|F|FU|TP|FB|LED)\d{1,4}[A-Z]?$/i;

/**
 * Japanese convention: the number leads. 55C, 12L, 3R, 7CN.
 *
 * Sony, Panasonic, Yamaha and most other Japanese service manuals number a
 * part and then say what it is -- the exact reverse of the western style -- and
 * nothing in the app understood it, so every one of these came back
 * unclassified and the symbol beside it stayed "unidentified".
 *
 * The suffix set is deliberately narrower than the prefix set above, because a
 * trailing letter after digits is also how printed *values* are written and a
 * refdes match wins the tie. Excluded for that reason: P (100P is 100pF), K and
 * M (kilo/mega), V, W, A, H, F, S. What is left cannot be read as a value:
 * "100R" is the one genuine collision, and in a manual that uses this
 * convention at all it is far more often resistor 100 than 100 ohms.
 */
const REFDES_SUFFIX_RE = /^\d{1,4}(?:CE|CN|VC|VR|ZD|SW|FB|TP|RY|LED|IC|TR|C|L|R|D|Q|X|T)$/i;

/** True if the token names a part, in either convention. */
export function isRefdes(text: string): boolean {
  const t = text.trim();
  return REFDES_RE.test(t) || REFDES_SUFFIX_RE.test(t);
}

const NETLABEL_RE =
  /^(?:[+-]?\d{1,3}(?:\.\d)?V|B\+|VCC|VDD|VSS|VEE|AVCC|AVDD|GND|AGND|DGND|PGND|SGND|EARTH|COM|VBAT|VIN|VOUT|VREF|SDA|SCL|SCK|SCLK|MOSI|MISO|MOMI|SS|CS|NSS|TX|RX|TXD|RXD|CTS|RTS|CLK|XTAL|OSC|RST|RESET|NRST|MCLR|EN|INT|IRQ|NMI|D[+-]|CAN[HL]|A|K)$/i;

const VALUE_RE =
  /^(?:\d+(?:[.,]\d+)?\s*[pnuμµmkKMG]?(?:F|H|Ω|OHM)?|\d+(?:[.,]\d+)?[pnuμµmkKMR]\d*|[0-9]+[VW]|\d+(?:\.\d+)?MHz|\d+(?:\.\d+)?kHz)$/i;

const PARTNUM_RE = /^(?:2S[ABCDJK]|[ABCDJK]|1N|1S|RD|TA|TC|AN|BA|HA|HD|LA|M5|UPC|UPD|LM|NE|TL|UA|MC|SN|CD|KIA|KA|S)\d{2,5}[A-Z]*$/i;

function classifyText(text: string): TextItem['kind'] {
  const t = text.trim();
  if (isRefdes(t)) return 'refdes';
  if (NETLABEL_RE.test(t)) return 'netlabel';
  if (PARTNUM_RE.test(t)) return 'value';
  if (VALUE_RE.test(t)) return 'value';
  if (hasJapanese(t)) return 'annotation';
  if (t.length > 12) return 'annotation';
  return 'unknown';
}

/**
 * Group adjacent OCR words into phrases.
 *
 * Tesseract splits Japanese captions aggressively; rejoining words that sit on
 * the same baseline within a character width produces far better lexicon hits
 * than translating fragments one at a time.
 */
export function groupIntoPhrases(items: TextItem[]): TextItem[] {
  const remaining = [...items].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  const out: TextItem[] = [];

  while (remaining.length) {
    const seed = remaining.shift()!;
    const group = [seed];
    const lineY = seed.bbox.y + seed.bbox.h / 2;
    const gapLimit = seed.bbox.h * 1.2;

    for (let i = 0; i < remaining.length; ) {
      const cand = remaining[i];
      const candY = cand.bbox.y + cand.bbox.h / 2;
      const last = group[group.length - 1];
      const gap = cand.bbox.x - (last.bbox.x + last.bbox.w);
      if (Math.abs(candY - lineY) <= seed.bbox.h * 0.5 && gap >= -2 && gap <= gapLimit) {
        group.push(cand);
        remaining.splice(i, 1);
      } else {
        i++;
      }
    }

    if (group.length === 1) {
      out.push(seed);
      continue;
    }

    const x = Math.min(...group.map((g) => g.bbox.x));
    const y = Math.min(...group.map((g) => g.bbox.y));
    const x2 = Math.max(...group.map((g) => g.bbox.x + g.bbox.w));
    const y2 = Math.max(...group.map((g) => g.bbox.y + g.bbox.h));
    const joined = group.map((g) => g.text).join(hasJapanese(seed.text) ? '' : ' ');

    const merged: TextItem = {
      id: `${seed.id}g`,
      page: seed.page,
      text: joined,
      bbox: { x, y, w: x2 - x, h: y2 - y },
      confidence: group.reduce((s, g) => s + g.confidence, 0) / group.length,
      script: scriptOf(joined),
      kind: classifyText(joined),
    };
    if (hasJapanese(joined)) attachTranslation(merged);

    // Keep the individual words too -- refdes matching wants the atoms.
    out.push(merged, ...group);
  }

  return out;
}
