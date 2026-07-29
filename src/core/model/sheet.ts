/**
 * Sheets within a document.
 *
 * The pipeline analyses one sheet at a time and hands back entities with
 * sheet-local ids (`net12`, `cmp3`). A twenty-sheet manual would collide on
 * every one of them, so `tagSheet` stamps each entity with its sheet and
 * rewrites ids into a namespace (`s7/net12`) before they join the document's
 * flat arrays. `pageView` is the other direction: the slice of the document
 * that belongs to one sheet, which is what the renderer and the per-sheet UI
 * actually work with.
 */

import type {
  Annotation,
  Component,
  FunctionalBlock,
  Junction,
  Net,
  Pin,
  SchematicDoc,
  TextItem,
  WireSegment,
} from './types';

/** Everything one pass of the pipeline produces for a single sheet. */
export interface SheetEntities {
  segments: WireSegment[];
  junctions: Junction[];
  nets: Net[];
  components: Component[];
  pins: Pin[];
  texts: TextItem[];
  blocks: FunctionalBlock[];
  annotations: Annotation[];
}

export const emptySheetEntities = (): SheetEntities => ({
  segments: [],
  junctions: [],
  nets: [],
  components: [],
  pins: [],
  texts: [],
  blocks: [],
  annotations: [],
});

/** The sheet an id belongs to, or undefined for an id from a single-sheet doc. */
export function sheetOfId(id: string): number | undefined {
  const m = /^s(\d+)\//.exec(id);
  return m ? Number(m[1]) : undefined;
}

/**
 * An id with its sheet namespace stripped, for display.
 *
 * Internal ids surface whenever a net has no label of its own, and "s3/net12"
 * is noise to a reader who is already being told which sheet they are on.
 */
export const localId = (id: string): string => id.replace(/^s\d+\//, '');

/**
 * Namespace a sheet's entities into a document, in place.
 *
 * Mutation is deliberate: `Component.pins` holds the very same `Pin` objects as
 * the flat pins array, and rewriting them once keeps the two views consistent
 * for free. The entities have just been created by the pipeline and are not
 * shared with anything else at this point.
 */
export function tagSheet(e: SheetEntities, page: number): SheetEntities {
  const ns = (id: string) => `s${page}/${id}`;
  const nsOpt = (id: string | undefined) => (id === undefined ? undefined : ns(id));

  for (const s of e.segments) {
    s.id = ns(s.id);
    s.netId = nsOpt(s.netId);
    s.page = page;
  }
  for (const j of e.junctions) {
    j.id = ns(j.id);
    j.netId = nsOpt(j.netId);
    j.page = page;
  }
  for (const p of e.pins) {
    p.id = ns(p.id);
    p.componentId = ns(p.componentId);
    p.netId = nsOpt(p.netId);
    p.page = page;
  }
  for (const c of e.components) {
    c.id = ns(c.id);
    c.page = page;
    // Pins were rewritten above; these are the same objects.
  }
  for (const n of e.nets) {
    n.id = ns(n.id);
    n.segmentIds = n.segmentIds.map(ns);
    n.junctionIds = n.junctionIds.map(ns);
    n.pinIds = n.pinIds.map(ns);
    n.page = page;
  }
  for (const t of e.texts) {
    t.id = ns(t.id);
    t.page = page;
  }
  for (const b of e.blocks) {
    b.id = ns(b.id);
    b.componentIds = b.componentIds.map(ns);
    b.netIds = b.netIds.map(ns);
    b.page = page;
  }
  for (const a of e.annotations) {
    a.id = ns(a.id);
    a.page = page;
  }

  return e;
}

/** Append one sheet's entities onto a document's flat arrays. */
export function mergeSheet(doc: SheetEntities, sheet: SheetEntities): void {
  doc.segments.push(...sheet.segments);
  doc.junctions.push(...sheet.junctions);
  doc.nets.push(...sheet.nets);
  doc.components.push(...sheet.components);
  doc.pins.push(...sheet.pins);
  doc.texts.push(...sheet.texts);
  doc.blocks.push(...sheet.blocks);
  doc.annotations.push(...sheet.annotations);
}

// ---------------------------------------------------------------------------
// Per-sheet views
// ---------------------------------------------------------------------------

/**
 * Cache of the per-sheet slices, keyed by the document object itself.
 *
 * The canvas redraws on every frame of a pan, and filtering forty thousand
 * segments each time would cost more than the drawing does. Edits replace the
 * document object rather than mutating it, so a stale slice can never be
 * handed back: a new object simply misses the cache, and the old entry is
 * collected with the old document.
 */
const views = new WeakMap<SheetEntities, Map<number, SheetEntities>>();

/** The slice of `doc` that lives on one sheet. Cached per document object. */
export function pageView(doc: SchematicDoc, page: number = doc.activePage): SheetEntities {
  let byPage = views.get(doc);
  if (!byPage) {
    byPage = new Map();
    views.set(doc, byPage);
  }
  const hit = byPage.get(page);
  if (hit) return hit;

  const on = <T extends { page: number }>(xs: T[]) => xs.filter((x) => x.page === page);
  const view: SheetEntities = {
    segments: on(doc.segments),
    junctions: on(doc.junctions),
    nets: on(doc.nets),
    components: on(doc.components),
    pins: on(doc.pins),
    texts: on(doc.texts),
    blocks: on(doc.blocks),
    annotations: on(doc.annotations),
  };
  byPage.set(page, view);
  return view;
}

/** Sheet index an entity id refers to, resolved against the document. */
export function pageOf(doc: SchematicDoc, id: string | undefined): number | undefined {
  if (!id) return undefined;
  const fromId = sheetOfId(id);
  if (fromId !== undefined) return fromId;
  const found =
    doc.nets.find((n) => n.id === id) ??
    doc.components.find((c) => c.id === id) ??
    doc.blocks.find((b) => b.id === id);
  return found?.page;
}
