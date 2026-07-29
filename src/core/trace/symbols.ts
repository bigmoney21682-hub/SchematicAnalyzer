/**
 * Symbol detection and pin attachment.
 *
 * After the tracer has claimed every long straight run, the ink left behind is
 * component bodies, text and dust. Connected-component labelling over that
 * residue gives candidate symbols; text boxes from OCR are used to veto blobs
 * that are really labels.
 *
 * Kind comes from the reference designator and part number first, because a
 * printed designator is the draughtsman telling you outright what the part is.
 * Where there is neither -- and a ground symbol never has either -- the strokes
 * themselves are measured; see `shapes.ts` for what that can and cannot settle.
 * Shape also does something the designator cannot: it puts a capacitor's two
 * plates back together into one part, which connected-component labelling has
 * no way to know belong to each other.
 */

import type { Bitmap } from '../image/raster';
import { dilate, subtract } from '../image/raster';
import type { Component, Pin, Rect, TextItem, WireSegment } from '../model/types';
import { kindFromRefdes, lookupPart } from '../rules/parts';
import { defaultShapeOptions, detectShapes, type ShapeMatch } from './shapes';

export interface SymbolOptions {
  /** Blobs smaller than this in either axis are dust. */
  minSize: number;
  /** Blobs larger than this fraction of the page are borders or title blocks. */
  maxPageFraction: number;
  /** How far a wire end may sit from a blob and still count as a pin. */
  pinSnap: number;
}

export function defaultSymbolOptions(bm: Bitmap): SymbolOptions {
  const scale = Math.max(bm.width, bm.height);
  return {
    minSize: Math.max(6, Math.round(scale / 300)),
    maxPageFraction: 0.25,
    pinSnap: Math.max(6, Math.round(scale / 200)),
  };
}

interface Blob {
  bbox: Rect;
  pixels: number;
}

/** 8-connected labelling with an explicit stack -- recursion blows up here. */
function findBlobs(bm: Bitmap, opts: SymbolOptions): Blob[] {
  const { width, height, data } = bm;
  const seen = new Uint8Array(width * height);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (data[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < opts.minSize && h < opts.minSize) continue;
    if (w > width * opts.maxPageFraction && h > height * opts.maxPageFraction) continue;

    blobs.push({ bbox: { x: minX, y: minY, w, h }, pixels: count });
  }

  return blobs;
}

function overlaps(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export interface SymbolResult {
  components: Component[];
  pins: Pin[];
}

export function detectSymbols(
  inkMask: Bitmap,
  wireMask: Bitmap,
  segments: WireSegment[],
  texts: TextItem[],
  opts: SymbolOptions,
  /** Closed rectangles the tracer identified as bodies rather than conductors. */
  outlines: Rect[] = [],
): SymbolResult {
  // Residual ink = everything the tracer did not claim. Dilating the wire mask
  // first stops anti-aliased wire edges surviving as thin sliver blobs.
  const residue = subtract(inkMask, dilate(wireMask, 1));
  // The labelling runs on a grown copy so a stroke broken by JPEG noise still
  // comes back as one blob. Shape measurement then has to use that same copy:
  // the bounding boxes belong to it, and measuring ink from the ungrown mask
  // inside a grown box reads every solid stroke as half empty.
  const grown = dilate(residue, 1);
  const blobs = findBlobs(grown, opts);

  // Blobs that are mostly covered by an OCR box are text, not symbols.
  let symbolBlobs = blobs.filter((b) => {
    const area = b.bbox.w * b.bbox.h;
    return !texts.some((t) => overlaps(b.bbox, t.bbox) > area * 0.6);
  });

  // Rectangular bodies are the most reliable symbols we have -- they came from
  // four clean strokes, not from leftover ink. Add them, and drop any residue
  // blob sitting inside one so a part is not reported twice.
  const outlineBlobs: Blob[] = outlines.map((rect) => ({ bbox: rect, pixels: 0 }));
  symbolBlobs = symbolBlobs.filter(
    (b) => !outlines.some((o) => overlaps(b.bbox, o) > b.bbox.w * b.bbox.h * 0.7),
  );

  // Measure the loose strokes before the outlines are mixed in: a shape is read
  // off the residue, and an outline rectangle has no residue behind it.
  const shapes = detectShapes(grown, symbolBlobs, defaultShapeOptions(inkMask), segments);

  // Fold each recognised shape into one blob and drop the fragments it was
  // assembled from. This is what makes a capacitor a single component rather
  // than two anonymous slivers a few pixels apart.
  const consumed = new Set(shapes.flatMap((s) => s.parts));
  const shapeOf = new Map<number, ShapeMatch>();
  const merged: Blob[] = [];
  for (const s of shapes) {
    shapeOf.set(merged.length + outlineBlobs.length, s);
    merged.push({ bbox: s.bbox, pixels: s.parts.reduce((t, i) => t + symbolBlobs[i].pixels, 0) });
  }
  symbolBlobs = [...outlineBlobs, ...merged, ...symbolBlobs.filter((_, i) => !consumed.has(i))];
  // `shapeOf` was keyed against the merged run's position in the final list,
  // which starts after the outlines -- so it needs no further adjustment.

  const components: Component[] = [];
  const pins: Pin[] = [];

  symbolBlobs.forEach((blob, i) => {
    const id = `cmp${i}`;
    const rationale: string[] = [];
    const shape = shapeOf.get(i);

    // Nearest plausible refdes: a short latin token above/below/beside the blob.
    // Measured as a gap from the symbol edge, so the radius is small and
    // absolute rather than scaling with the symbol's own size.
    const labelReach = opts.pinSnap * 3;
    const refdesItem = nearestText(blob.bbox, texts, 'refdes', labelReach);
    const valueItem = nearestText(blob.bbox, texts, 'value', labelReach);

    const refdes = refdesItem?.text.trim();
    const value = valueItem?.text.trim();

    let kind = refdes ? kindFromRefdes(refdes) : undefined;
    let kindSource: Component['kindSource'] = kind ? 'ocr' : undefined;
    let kindConfidence: Component['kindConfidence'] = kind ? 'medium' : 'low';
    if (kind) rationale.push(`Reference designator "${refdes}" indicates a ${kind}.`);

    // What the strokes say. Ranked below the designator, because a designator
    // is the drawing stating the answer and a shape is us inferring it -- but
    // when the two agree that is worth more than either alone, and when there
    // is no designator at all (a ground symbol never has one) it is all there is.
    if (shape) {
      if (!kind) {
        kind = shape.kind;
        kindSource = 'heuristic';
        kindConfidence = shape.confidence;
        rationale.push(`${shape.why} No reference designator was found near it.`);
      } else if (kind === shape.kind) {
        kindConfidence = 'high';
        rationale.push(`${shape.why} This agrees with the designator.`);
      } else {
        rationale.push(
          `The symbol's shape reads as a ${shape.kind} (${shape.why.toLowerCase()}), which does not ` +
            `match the designator "${refdes}". The designator was trusted; check this one.`,
        );
      }
    }

    let description: string | undefined;
    const part = value ? lookupPart(value) : undefined;
    if (part) {
      // A recognised part number is stronger evidence than the refdes prefix.
      kind = part.kind;
      kindSource = 'partdb';
      kindConfidence = 'high';
      description = part.description;
      rationale.push(`Part "${value}" matched ${part.family ?? 'the part database'}: ${part.description}.`);
    }

    const pinPoints = findPins(blob.bbox, segments, opts.pinSnap);
    pinPoints.forEach((p, k) => {
      const pin: Pin = {
        id: `${id}p${k}`,
        page: 0, // stamped by tagSheet

        componentId: id,
        at: p.at,
        number: part?.pinNames ? String(k + 1) : undefined,
        name: part?.pinNames?.[k],
        netId: p.netId,
      };
      pins.push(pin);
    });

    if (pinPoints.length) {
      rationale.push(`${pinPoints.length} conductor(s) terminate on this symbol.`);
    }

    components.push({
      id,
      page: 0, // stamped by tagSheet
      refdes,
      refdesSource: refdes ? 'ocr' : undefined,
      value,
      kind: kind ?? 'unknown',
      kindConfidence,
      kindSource,
      bbox: blob.bbox,
      pins: pins.filter((p) => p.componentId === id),
      description,
      rationale,
    });
  });

  return { components, pins };
}

/**
 * Nearest label of a given kind, measured edge-to-edge.
 *
 * Centre-to-centre distance fails badly on large symbols: an IC's refdes sits
 * a few pixels above the box, but the box centre can be a hundred pixels away,
 * so the label is rejected while a distant unrelated one wins.
 */
function nearestText(
  box: Rect,
  texts: TextItem[],
  kind: TextItem['kind'],
  maxDist: number,
): TextItem | undefined {
  let best: TextItem | undefined;
  let bestD = Infinity;
  for (const t of texts) {
    if (t.kind !== kind) continue;
    const d = rectGap(box, t.bbox);
    if (d < bestD && d <= maxDist) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Shortest distance between two rectangles; 0 when they overlap. */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/** Wire endpoints that land on the symbol's boundary become pins. */
function findPins(
  box: Rect,
  segments: WireSegment[],
  snap: number,
): Array<{ at: { x: number; y: number }; netId?: string }> {
  const zone = expand(box, snap);
  const found: Array<{ at: { x: number; y: number }; netId?: string }> = [];

  for (const s of segments) {
    for (const end of [s.a, s.b]) {
      if (!contains(zone, end)) continue;
      // Skip endpoints deep inside the body -- those are drawing artefacts.
      if (contains(expand(box, -snap / 2), end)) continue;
      const dup = found.some((f) => Math.hypot(f.at.x - end.x, f.at.y - end.y) < snap);
      if (!dup) found.push({ at: { ...end }, netId: s.netId });
    }
  }
  return found;
}
