/**
 * Quarter-turn rotation of a sheet.
 *
 * Phone photographs and scanner output land sideways often enough that a
 * landscape schematic on a portrait screen is the normal case, not the odd one.
 * Rotation is applied to the sheet itself -- the raster is re-encoded and every
 * entity extracted from it is carried through the same transform -- rather than
 * being a property of the viewport. That keeps one coordinate system in the
 * document: hit testing, the exporters and the SVG all keep working with no
 * knowledge that a rotation ever happened, and the rotation survives a reload
 * because it is baked into what was saved.
 *
 * Only quarter turns are offered. They are exact: no resampling, no cropping,
 * and no loss on the hairline conductors this whole app exists to read.
 */

import type {
  Annotation,
  Component,
  FunctionalBlock,
  Junction,
  Net,
  Pin,
  Point,
  Rect,
  SchematicDoc,
  SourcePage,
  TextItem,
  WireSegment,
} from '../model/types';
import { decodeDataUrl } from '../image/raster';

export type Turn = 'cw' | 'ccw';

/**
 * Map a point from the old raster into the rotated one.
 *
 * Clockwise sends (x, y) to (H - y, x); anticlockwise sends it to (y, W - x).
 * Both land inside the rotated page, whose width and height are swapped.
 */
function mapPoint(p: Point, turn: Turn, w: number, h: number): Point {
  return turn === 'cw' ? { x: h - p.y, y: p.x } : { x: p.y, y: w - p.x };
}

/** Rotate a rect by mapping opposite corners and re-normalising. */
function mapRect(r: Rect, turn: Turn, w: number, h: number): Rect {
  const a = mapPoint({ x: r.x, y: r.y }, turn, w, h);
  const b = mapPoint({ x: r.x + r.w, y: r.y + r.h }, turn, w, h);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Re-encode in the format the sheet already used -- see `encodePage`. */
function encodeLike(canvas: HTMLCanvasElement, dataUrl: string): string {
  return dataUrl.startsWith('data:image/jpeg')
    ? canvas.toDataURL('image/jpeg', 0.92)
    : canvas.toDataURL('image/png');
}

/** Rotate a page's raster a quarter turn, returning the new page. */
async function rotateRaster(page: SourcePage, turn: Turn): Promise<SourcePage> {
  const img = await decodeDataUrl(page.dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = page.height;
  canvas.height = page.width;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (turn === 'cw') {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  img.close();

  return {
    ...page,
    width: page.height,
    height: page.width,
    dataUrl: encodeLike(canvas, page.dataUrl),
    rotation: (((page.rotation ?? 0) + (turn === 'cw' ? 90 : 270)) % 360 + 360) % 360,
  };
}

/**
 * Rotate one sheet of a document a quarter turn.
 *
 * Returns a new document; entities on other sheets are passed through by
 * reference, so rotating sheet 3 of a fifteen-sheet manual copies almost
 * nothing. Text *content* is untouched -- a caption OCR'd from a sideways scan
 * stays as misread as it was, and only a re-analysis will fix that -- but its
 * box follows the rotation, so nothing drifts off the ink it belongs to.
 */
export async function rotateSheet(
  doc: SchematicDoc,
  pageIndex: number,
  turn: Turn,
): Promise<SchematicDoc> {
  const page = doc.pages[pageIndex];
  if (!page) return doc;

  const { width: w, height: h } = page;
  const pt = (p: Point) => mapPoint(p, turn, w, h);
  const rect = (r: Rect) => mapRect(r, turn, w, h);
  /** Apply `fn` to the entities on this sheet, leaving the rest untouched. */
  const on = <T extends { page: number }>(xs: T[], fn: (x: T) => T): T[] =>
    xs.map((x) => (x.page === pageIndex ? fn(x) : x));

  const rotated = await rotateRaster(page, turn);

  return {
    ...doc,
    pages: doc.pages.map((p, i) => (i === pageIndex ? rotated : p)),
    // A quarter turn swaps the axes, so runs that were horizontal are now
    // vertical. The tracer's orientation flag drives net rendering and the
    // bus/rail heuristics, and would be inverted on this sheet if left alone.
    segments: on(
      doc.segments,
      (s): WireSegment => ({
        ...s,
        a: pt(s.a),
        b: pt(s.b),
        orientation: s.orientation === 'h' ? 'v' : 'h',
      }),
    ),
    junctions: on(doc.junctions, (j): Junction => ({ ...j, at: pt(j.at) })),
    nets: on(doc.nets, (n): Net => ({ ...n, bbox: rect(n.bbox) })),
    pins: on(doc.pins, (p): Pin => ({ ...p, at: pt(p.at) })),
    components: on(
      doc.components,
      (c): Component => ({
        ...c,
        bbox: rect(c.bbox),
        // `Component.pins` mirrors the entries in the flat pins array, so both
        // copies have to move together or a component's own pin list would
        // still describe the pre-rotation sheet.
        pins: c.pins.map((p) => ({ ...p, at: pt(p.at) })),
      }),
    ),
    texts: on(doc.texts, (t): TextItem => ({ ...t, bbox: rect(t.bbox) })),
    blocks: on(doc.blocks, (b): FunctionalBlock => ({ ...b, bbox: rect(b.bbox) })),
    annotations: on(
      doc.annotations,
      (a): Annotation => ({
        ...a,
        at: pt(a.at),
        target: a.target && pt(a.target),
      }),
    ),
    updatedAt: Date.now(),
  };
}
