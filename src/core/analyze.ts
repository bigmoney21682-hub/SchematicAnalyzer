/**
 * Pipeline orchestration: rasters in, annotated `SchematicDoc` out.
 *
 * Two levels. Within a sheet, stages are sequenced so each can use the previous
 * one's output: OCR runs before symbol detection (text boxes veto text blobs),
 * and symbol detection runs before classification (rules need parts and pins).
 * Across sheets, every sheet is analysed independently and only then linked, so
 * one unreadable page cannot poison the rest -- and so a document can grow by
 * appending sheets later without re-analysing what is already there.
 *
 * A twenty-sheet manual is a long job on a phone, so the run is interruptible:
 * cancelling keeps the sheets already finished and says so in the warnings,
 * rather than throwing away ten minutes of OCR.
 */

import {
  binarize,
  cloneBitmap,
  deskewPage,
  estimateSkew,
  inkCount,
  loadPages,
  pageToImageData,
  toGray,
} from './image/raster';
import { DetailSource } from './image/detail';
import { defaultTraceOptions, trace } from './trace/wires';
import { defaultSymbolOptions, detectSymbols } from './trace/symbols';
import { groupIntoPhrases, runOcr, suggestOcrScale } from './ocr/ocr';
import { classifyNets, detectBlocks, detectTestPoints, type ClassifyContext } from './rules/classify';
import {
  applyLearnedKinds,
  applyLearnedRoles,
  emptyOutcome,
  type LearnedModel,
  type LearningOutcome,
} from './learn/model';
import { linkSheets } from './link/sheets';
import type { SourceRecord } from '../storage/db';
import {
  emptyPageStats,
  emptyStats,
  type AnalysisStats,
  type Annotation,
  type PageStats,
  type SchematicDoc,
  type SourcePage,
  type TextItem,
} from './model/types';
import { ROLE_LABELS } from './model/types';
import { emptySheetEntities, mergeSheet, tagSheet, type SheetEntities } from './model/sheet';
import { newId } from './util/id';

export interface AnalyzeProgress {
  stage: string;
  detail?: string;
  /** 0..1 within the overall run. */
  progress: number;
  /** Sheet being worked on, 1-based, and how many there are in total. */
  sheet?: number;
  sheetCount?: number;
}

export interface AnalyzeOptions {
  onProgress?: (p: AnalyzeProgress) => void;
  /** Skip OCR when the user only wants geometry (much faster). */
  skipOcr?: boolean;
  /** Correct page rotation before analysing. */
  deskew?: boolean;
  /** Stop after the sheet in flight; what is finished is kept. */
  signal?: AbortSignal;
  /** What earlier corrections taught us, applied after the rules have run. */
  learned?: LearnedModel;
  /**
   * The original uploads, handed back for storage.
   *
   * Analysis has no business talking to the database, but it is the only place
   * that still holds the files -- so it passes them out and the caller decides
   * whether to keep them. They are what makes a zoomed-in sheet redraw sharply.
   */
  onSources?: (records: SourceRecord[]) => void;
}

/** Stages within one sheet. */
const STAGES = [
  'Preparing image',
  'Reading text (OCR)',
  'Tracing conductors',
  'Detecting components',
  'Interpreting circuit',
  'Writing annotations',
] as const;

/** Share of the run reserved for cross-sheet linking after the last sheet. */
const LINK_SHARE = 0.15;

/**
 * Long edge of the raster OCR reads, when a sharper original exists.
 *
 * Chosen against two ceilings at once. Tesseract wants roughly 30px of glyph
 * height and a service-manual designator is about 1/200th of the sheet, which
 * argues for as much as possible. iOS stops allocating canvases past 4096px on
 * an axis, which argues for less. 4000 is the most that clears both, and it
 * roughly doubles the size every piece of printed text is read at.
 */
const OCR_LONG_EDGE = 4000;

/** And a total-pixel ceiling, for the sheets that are nearly square. */
const OCR_MAX_PIXELS = 12_000_000;

export class AnalysisCancelled extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'AnalysisCancelled';
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Analyse one or more files as a single multi-sheet document. */
export async function analyzeFiles(files: File[] | File, opts: AnalyzeOptions = {}): Promise<SchematicDoc> {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) throw new Error('No files to analyse.');

  const t0 = performance.now();
  opts.onProgress?.({ stage: 'Loading', progress: 0, detail: list[0].name });

  // The id is minted here rather than at the end because the stored originals
  // are keyed by it, and they are collected during loading.
  const docId = newId();
  const { pages, sources } = await loadPages(
    list,
    0,
    (loaded, name) =>
      opts.onProgress?.({ stage: 'Loading', progress: 0, detail: `${name} — ${loaded} sheet(s) so far` }),
    docId,
  );
  if (!pages.length) throw new Error('No pages could be read from the selected file(s).');
  opts.onSources?.(sources);

  const timings: Record<string, number> = { load: performance.now() - t0 };
  const name = documentName(list, pages.length);

  return analyzeSheets(pages, name, opts, timings, undefined, docId, sources);
}

/**
 * Add sheets to a document that has already been analysed.
 *
 * Photographing a manual on a phone happens a few pages at a time, and a sheet
 * that turns out to matter is often found after the first pass. New sheets are
 * analysed on their own and appended; everything already extracted is left
 * exactly as it was, including the user's corrections. Only the links and the
 * pooled statistics are recomputed, because those are the only things that
 * depend on the document as a whole.
 */
export async function addSheets(
  doc: SchematicDoc,
  files: File[] | File,
  opts: AnalyzeOptions = {},
): Promise<SchematicDoc> {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return doc;

  opts.onProgress?.({ stage: 'Loading', progress: 0, detail: list[0].name });
  const { pages: fresh, sources } = await loadPages(
    list,
    doc.pages.length,
    (loaded, name) =>
      opts.onProgress?.({ stage: 'Loading', progress: 0, detail: `${name} — ${loaded} sheet(s) so far` }),
    doc.id,
  );
  if (!fresh.length) throw new Error('No pages could be read from the selected file(s).');
  opts.onSources?.(sources);

  return analyzeSheets(fresh, doc.name, opts, { ...doc.stats.timings }, doc, undefined, sources);
}

/**
 * Re-run interpretation only, after the user has corrected net roles.
 *
 * Blocks are per-sheet, so they are rebuilt sheet by sheet; the links are then
 * recomputed over the whole document, which is what pushes a correction made on
 * one sheet out to its twins on the others.
 *
 * If a model is supplied, the correction just made is also applied to the rest
 * of *this* document before the blocks are rebuilt -- so fixing one "B+" fixes
 * the other eleven on the other sheets in the same click, instead of only
 * helping the next schematic. Nets the user set by hand are left alone.
 */
export function reinterpret(doc: SchematicDoc, learned?: LearnedModel): SchematicDoc {
  const blocks: SchematicDoc['blocks'] = [];
  const nets = emptyOutcome();
  const parts = emptyOutcome();
  let working = doc;

  if (learned) {
    // The learned passes revise entities in place, as the rule engine does.
    // Copy them first so the document React is currently rendering is never the
    // one being edited.
    working = {
      ...doc,
      nets: doc.nets.map((n) => ({ ...n, rationale: [...n.rationale] })),
      components: doc.components.map((c) => ({ ...c, rationale: [...c.rationale] })),
    };
    for (const page of working.pages) {
      const ctx = contextFor(working, page);
      add(parts, applyLearnedKinds(ctx, learned));
      add(nets, applyLearnedRoles(ctx, learned));
    }
  }

  for (const page of working.pages) {
    const sheetBlocks = detectBlocks(contextFor(working, page));
    for (const b of sheetBlocks) {
      // The component and net ids it grouped are already document-wide; only
      // the block's own generated id needs placing in this sheet's namespace.
      b.id = `s${page.index}/${b.id}`;
      b.page = page.index;
    }
    blocks.push(...sheetBlocks);
  }

  const { links, warnings } = linkSheets(working.nets, working.components, working.pages.length);

  return {
    ...working,
    blocks,
    sheetLinks: links,
    stats: poolStats(working.pages, links.length, working.stats.timings, [
      ...working.stats.warnings.filter((w) => !isLinkWarning(w) && !isLearningNote(w)),
      ...warnings,
      ...(describeLearning(nets, parts) ? [describeLearning(nets, parts)!] : []),
    ]),
    updatedAt: Date.now(),
  };
}

function add(into: LearningOutcome, from: LearningOutcome): void {
  into.changed += from.changed;
  into.filled += from.filled;
}

const LINK_WARNING_MARK = 'Reference designators are normally unique';
const isLinkWarning = (w: string) => w.includes(LINK_WARNING_MARK);

const LEARNING_NOTE_MARK = 'Applied what you have taught it';
const isLearningNote = (w: string) => w.includes(LEARNING_NOTE_MARK);

/**
 * Say what the learned model changed, or nothing if it stayed out of the way.
 *
 * Reported alongside the warnings because that is where the user already looks
 * for "things you should know about this run" -- and a tool that silently
 * revises its own conclusions is not one anybody should trust with a schematic.
 */
function describeLearning(nets: LearningOutcome, parts: LearningOutcome): string | undefined {
  const clauses: string[] = [];
  const say = (o: LearningOutcome, noun: string) => {
    if (o.filled) clauses.push(`${o.filled} ${noun}(s) identified that were unclassified`);
    if (o.changed) clauses.push(`${o.changed} ${noun}(s) reclassified`);
  };
  say(parts, 'part');
  say(nets, 'net');
  if (!clauses.length) return undefined;
  return `${LEARNING_NOTE_MARK}: ${clauses.join(', ')}. Each one says so in its own reasoning.`;
}

// ---------------------------------------------------------------------------
// Multi-sheet driver
// ---------------------------------------------------------------------------

async function analyzeSheets(
  pagesIn: SourcePage[],
  name: string,
  opts: AnalyzeOptions,
  timings: Record<string, number>,
  base?: SchematicDoc,
  docId?: string,
  sources: SourceRecord[] = [],
): Promise<SchematicDoc> {
  const startIndex = base?.pages.length ?? 0;
  const totalSheets = startIndex + pagesIn.length;

  const pages: SourcePage[] = base ? [...base.pages] : [];
  const entities: SheetEntities = base
    ? {
        segments: [...base.segments],
        junctions: [...base.junctions],
        nets: [...base.nets],
        components: [...base.components],
        pins: [...base.pins],
        texts: [...base.texts],
        blocks: [...base.blocks],
        annotations: [...base.annotations],
      }
    : emptySheetEntities();

  const docWarnings: string[] = [];
  let cancelled = false;
  let done = 0;

  // One reader of the originals for the whole run: it caches the decoded PDF,
  // so a twenty-sheet manual opens its PDF once rather than twenty times.
  const detail = new DetailSource();
  detail.prime(sources);

  for (const [i, raw] of pagesIn.entries()) {
    const index = startIndex + i;
    const report = (stage: number, note?: string) =>
      opts.onProgress?.({
        stage: STAGES[stage],
        detail: note,
        sheet: index + 1,
        sheetCount: totalSheets,
        // Sheets already in the document are done; only the new ones progress.
        progress: ((i + stage / STAGES.length) / pagesIn.length) * (1 - LINK_SHARE),
      });

    try {
      throwIfAborted(opts.signal);
      const sheet = await analyzeSheet({ ...raw, index }, opts, report, detail);
      pages.push(sheet.page);
      mergeSheet(entities, tagSheet(sheet.entities, index));
      for (const [k, v] of Object.entries(sheet.timings)) timings[k] = (timings[k] ?? 0) + v;
      done++;
    } catch (err) {
      if (err instanceof AnalysisCancelled || opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      // One bad sheet must not cost the user the other nineteen.
      pages.push({ ...raw, index, stats: { ...emptyPageStats(), warnings: [describe(err)] } });
      docWarnings.push(`Sheet ${index + 1} could not be analysed: ${describe(err)}`);
    }
  }

  // The PDF handle and its worker are no longer needed; the viewport opens its
  // own from IndexedDB once the caller has stored these same files.
  detail.dispose();

  if (!pages.length) throw new AnalysisCancelled();
  if (cancelled) {
    docWarnings.push(
      `Analysis was stopped after ${done} of ${pagesIn.length} new sheet(s). The rest were left ` +
        'unanalysed -- add them later and they will be analysed and linked in.',
    );
  }

  // --- Cross-sheet linking -------------------------------------------------
  opts.onProgress?.({
    stage: 'Linking sheets',
    progress: 1 - LINK_SHARE / 2,
    sheetCount: pages.length,
    detail: `Matching net labels across ${pages.length} sheets`,
  });

  const mark = performance.now();
  const { links, warnings } = linkSheets(entities.nets, entities.components, pages.length);
  timings.link = (timings.link ?? 0) + (performance.now() - mark);
  docWarnings.push(...warnings);

  opts.onProgress?.({ stage: 'Done', progress: 1 });

  return {
    id: base?.id ?? docId ?? newId(),
    name: base ? restated(base.name, pages.length) : name,
    createdAt: base?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    pages,
    activePage: base ? base.activePage : 0,
    ...entities,
    sheetLinks: links,
    stats: poolStats(pages, links.length, timings, [...sheetWarnings(pages), ...docWarnings]),
  };
}

// ---------------------------------------------------------------------------
// One sheet
// ---------------------------------------------------------------------------

interface SheetResult {
  page: SourcePage;
  entities: SheetEntities;
  timings: Record<string, number>;
}

async function analyzeSheet(
  pageIn: SourcePage,
  opts: AnalyzeOptions,
  report: (stage: number, detail?: string) => void,
  detail: DetailSource,
): Promise<SheetResult> {
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  let page = pageIn;

  report(0);
  let mark = performance.now();
  let imageData = await pageToImageData(page);
  let bitmap = binarize(toGray(imageData), page.width, page.height);

  if (opts.deskew !== false) {
    const angle = estimateSkew(bitmap);
    if (Math.abs(angle) >= 0.15) {
      page = await deskewPage(page, angle);
      imageData = await pageToImageData(page);
      bitmap = binarize(toGray(imageData), page.width, page.height);
      report(0, `Corrected ${angle.toFixed(2)}° of skew`);
    }
  }
  timings.prepare = performance.now() - mark;

  const totalInk = inkCount(bitmap);
  if (totalInk < page.width * page.height * 0.002) {
    warnings.push('Very little ink detected -- the scan may be too faint or the threshold too aggressive.');
  }

  // --- OCR ---------------------------------------------------------------
  throwIfAborted(opts.signal);
  report(1);
  mark = performance.now();
  let texts: TextItem[] = [];
  if (!opts.skipOcr) {
    try {
      // Read from the sharpest rendering of this sheet that exists, not from
      // the analysis raster. On a PDF that means the vectors themselves, which
      // is the difference between a designator arriving as twelve pixels of
      // grey and arriving as text -- and it is why "55C" was invisible before.
      const crisp = await detail.ocrPage(page, OCR_LONG_EDGE, OCR_MAX_PIXELS).catch(() => null);
      if (crisp) {
        report(1, `Re-rendered at ${Math.round(crisp.canvas.width)}px wide for reading`);
      }
      const source = crisp
        ? { image: crisp.canvas, sourceScale: crisp.scale }
        : { image: page.dataUrl, sourceScale: 1 };
      const ocrWidth = crisp ? crisp.canvas.width : page.width;
      const ocrHeight = crisp ? crisp.canvas.height : page.height;

      const raw = await runOcr(source, {
        minConfidence: 30,
        scale: suggestOcrScale(ocrWidth, ocrHeight),
        onProgress: (msg, pct) => report(1, `${msg} ${Math.round(pct * 100)}%`),
      });
      texts = groupIntoPhrases(raw);
    } catch (err) {
      warnings.push(
        `OCR failed (${describe(err)}). Geometry was still analysed, but labels and Japanese ` +
          'annotations are unavailable on this sheet.',
      );
    }
  }
  timings.ocr = performance.now() - mark;

  // --- Trace -------------------------------------------------------------
  throwIfAborted(opts.signal);
  report(2);
  mark = performance.now();
  const traceOpts = defaultTraceOptions(bitmap);
  const traced = trace(cloneBitmap(bitmap), traceOpts);
  timings.trace = performance.now() - mark;

  if (traced.ambiguousCrossings.length) {
    warnings.push(
      `${traced.ambiguousCrossings.length} wire crossing(s) had no visible solder dot and were treated as ` +
        'hops (not connected). Review the flagged points if a net looks wrong.',
    );
  }

  // --- Symbols -----------------------------------------------------------
  throwIfAborted(opts.signal);
  report(3);
  mark = performance.now();
  const symOpts = defaultSymbolOptions(bitmap);
  const { components, pins } = detectSymbols(
    bitmap,
    traced.wireMask,
    traced.segments,
    texts,
    symOpts,
    traced.outlines,
  );
  timings.symbols = performance.now() - mark;

  // --- Interpret ---------------------------------------------------------
  report(4);
  mark = performance.now();
  const ctx: ClassifyContext = {
    nets: traced.nets,
    texts,
    components,
    pins,
    segments: traced.segments,
    pageScale: Math.hypot(page.width, page.height),
  };
  // Learned part kinds are applied before the nets are classified, not after:
  // net roles are read off the parts they touch, so a symbol the user has
  // taught us is a regulator defines the rail on its output pin. Learning the
  // part improves the wiring, not just the parts list.
  const learnedParts = opts.learned ? applyLearnedKinds(ctx, opts.learned) : emptyOutcome();

  classifyNets(ctx);

  // Rules first, then what the user's corrections have taught us. The order is
  // the point: learning revises the rules' conclusions and is answerable for
  // every change it makes, rather than competing with them.
  const learnedNets = opts.learned ? applyLearnedRoles(ctx, opts.learned) : emptyOutcome();

  const applied = describeLearning(learnedNets, learnedParts);
  if (applied) warnings.push(applied);

  const blocks = detectBlocks(ctx);
  const testPoints = detectTestPoints(ctx);
  timings.interpret = performance.now() - mark;

  // --- Annotations -------------------------------------------------------
  report(5);
  const annotations: Annotation[] = [];
  let ai = 0;
  const note = (a: Omit<Annotation, 'id' | 'page'>) =>
    annotations.push({ ...a, id: `a${ai++}`, page: page.index });

  for (const net of traced.nets) {
    if (net.role === 'unknown' || net.roleConfidence === 'low') continue;
    const consumers = pins
      .filter((p) => p.netId === net.id)
      .map((p) => components.find((c) => c.id === p.componentId))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const named = consumers.map((c) => c.refdes ?? c.value).filter(Boolean);
    const text =
      net.role === 'power' || net.role === 'ground'
        ? `${net.label ?? ROLE_LABELS[net.role]}${net.voltage !== undefined ? ` (${net.voltage > 0 ? '+' : ''}${net.voltage}V)` : ''}` +
          (named.length ? ` -- feeds ${named.slice(0, 4).join(', ')}${named.length > 4 ? `, +${named.length - 4} more` : ''}` : '')
        : `${net.label ?? ''} ${ROLE_LABELS[net.role]}`.trim();

    note({
      kind: 'note',
      at: { x: net.bbox.x + net.bbox.w / 2, y: net.bbox.y },
      text,
      source: net.roleSource,
    });
  }

  for (const tp of testPoints) {
    note({ kind: 'testpoint', at: tp.at, text: tp.text, source: 'heuristic' });
  }

  for (const p of traced.ambiguousCrossings) {
    note({
      kind: 'flag',
      at: p,
      text: 'Crossing with no solder dot -- assumed NOT connected. Confirm against the original.',
      source: 'heuristic',
    });
  }

  // Japanese captions are drawn by the translations layer, which owns their
  // deduplication and placement. Emitting notes for them here as well produced
  // two callouts per caption, one of them built from OCR fragments.

  const tracedInk = inkCount(traced.wireMask);
  const stats: PageStats = {
    traceCoverage: totalInk ? tracedInk / totalInk : 0,
    ocrItems: texts.length,
    ocrMeanConfidence: texts.length ? texts.reduce((s, t) => s + t.confidence, 0) / texts.length : 0,
    netCount: traced.nets.length,
    componentCount: components.length,
    ink: totalInk,
    warnings,
  };

  if (stats.traceCoverage < 0.15 && !warnings.length) {
    warnings.push(
      'Only a small fraction of the ink was traced as conductors. The scan may be low contrast, ' +
        'or the wires thinner than the detector expects.',
    );
  }

  return {
    page: { ...page, title: sheetTitle(texts, page), stats },
    entities: {
      segments: traced.segments,
      junctions: traced.junctions,
      nets: traced.nets,
      components,
      pins,
      texts,
      blocks,
      annotations,
    },
    timings,
  };
}

// ---------------------------------------------------------------------------
// Naming and statistics
// ---------------------------------------------------------------------------

/**
 * The sheet's own title, taken from the drawing.
 *
 * Service manuals put a title at the head of the sheet or in the title block,
 * set larger than everything else. Picking the tallest confidently-read string
 * from the top or bottom margin gets it often enough to be worth having, and
 * when it misses the user just sees "Sheet 3" as before.
 */
function sheetTitle(texts: TextItem[], page: SourcePage): string | undefined {
  const margin = page.height * 0.12;
  const eligible = (t: TextItem) =>
    t.confidence >= 55 && [...t.text].length >= 3 && t.text.length <= 40 && t.kind !== 'refdes' && t.kind !== 'value';

  // The head of the sheet is where the title lives. The foot is worth trying
  // as a fallback for a bottom-right title block, but never in preference --
  // that band is also where the safety notices are, and "注意: do not touch the
  // high voltage section" is not what this sheet is called.
  const top = texts.filter((t) => eligible(t) && t.bbox.y < margin);
  const bottom = texts.filter((t) => eligible(t) && t.bbox.y > page.height - margin);
  const band = top.length ? top : bottom;
  if (!band.length) return undefined;

  // A title has to stand out; the same height as body text means it is not one.
  const tallest = Math.max(...band.map((t) => t.bbox.h));
  const medianHeight = median(texts.map((t) => t.bbox.h));
  if (tallest < medianHeight * 1.35) return undefined;

  // Among the tall ones, the longest string wins: OCR often splits a heading,
  // and "電源回路図" is a better name for the sheet than the "回路図" inside it.
  const best = band
    .filter((t) => t.bbox.h >= tallest * 0.85)
    .reduce((a, b) => ([...b.text].length > [...a.text].length ? b : a));

  return best.translation && best.translation !== best.text
    ? `${best.text} — ${best.translation}`
    : best.text;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Name the document after its source: one file's name, or "N sheets". */
function documentName(files: File[], pageCount: number): string {
  if (files.length === 1) return files[0].name;
  const shared = commonPrefix(files.map((f) => f.name.replace(/\.[^.]+$/, ''))).replace(/[-_ ]+$/, '');
  return shared.length >= 3 ? `${shared} (${pageCount} sheets)` : `${files.length} files, ${pageCount} sheets`;
}

/**
 * Keep a sheet count in the document name honest after sheets are added.
 *
 * A document named from several files carries its size ("manual (4 sheets)").
 * Appending a fifth and leaving the name saying four is a small lie in the most
 * visible place on screen.
 */
function restated(name: string, pageCount: number): string {
  return name.replace(/\(\d+ sheets\)/, `(${pageCount} sheets)`);
}

function commonPrefix(xs: string[]): string {
  if (!xs.length) return '';
  let p = xs[0];
  for (const s of xs) {
    while (p && !s.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

/**
 * Pool the per-sheet figures into document-level ones.
 *
 * Trace coverage and OCR confidence are averaged weighted by how much there was
 * to get wrong -- ink for coverage, item count for OCR -- so a sparse sheet with
 * three text items cannot drag the headline number around.
 */
function poolStats(
  pages: SourcePage[],
  linkCount: number,
  timings: Record<string, number>,
  warnings: string[],
): AnalysisStats {
  const stats = pages.map((p) => p.stats).filter((s): s is PageStats => Boolean(s));
  const sum = (pick: (s: PageStats) => number) => stats.reduce((t, s) => t + pick(s), 0);

  const ink = sum((s) => s.ink);
  const ocrItems = sum((s) => s.ocrItems);

  return {
    ...emptyStats(),
    traceCoverage: ink ? sum((s) => s.traceCoverage * s.ink) / ink : 0,
    ocrItems,
    ocrMeanConfidence: ocrItems ? sum((s) => s.ocrMeanConfidence * s.ocrItems) / ocrItems : 0,
    netCount: sum((s) => s.netCount),
    componentCount: sum((s) => s.componentCount),
    ink,
    pageCount: pages.length,
    linkCount,
    warnings,
    timings,
  };
}

/** Each sheet's own warnings, tagged with the sheet they came from. */
function sheetWarnings(pages: SourcePage[]): string[] {
  return pages.flatMap((p) =>
    (p.stats?.warnings ?? []).map((w) => (pages.length > 1 ? `Sheet ${p.index + 1}: ${w}` : w)),
  );
}

// ---------------------------------------------------------------------------

function contextFor(doc: SchematicDoc, page: SourcePage): ClassifyContext {
  const on = <T extends { page: number }>(xs: T[]) => xs.filter((x) => x.page === page.index);
  return {
    nets: on(doc.nets),
    texts: on(doc.texts),
    components: on(doc.components),
    pins: on(doc.pins),
    segments: on(doc.segments),
    pageScale: Math.hypot(page.width, page.height),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisCancelled();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
