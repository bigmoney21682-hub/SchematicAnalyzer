/**
 * Wire extraction and net tracing.
 *
 * Schematic conductors are near-perfectly Manhattan, which lets us skip Hough
 * transforms entirely: isolate long horizontal and vertical ink runs, merge
 * them across their stroke thickness into segments, then decide which segments
 * are electrically joined.
 *
 * The hard call is a crossing. Four wires meeting in an X is ambiguous: it is
 * a connection if the draughtsman put a solder dot there, and a hop otherwise.
 * Getting this wrong silently invents or destroys connectivity, so crossings
 * without clear dot evidence are recorded as unconnected AND flagged for the
 * user to review.
 */

import type { Bitmap } from '../image/raster';
import { keepLongRuns } from '../image/raster';
import type { Junction, Net, Point, Rect, WireSegment } from '../model/types';

export interface TraceOptions {
  /** Shortest run treated as a conductor, in px. */
  minRun: number;
  /** Endpoint snap distance, in px. */
  tolerance: number;
}

export interface TraceResult {
  segments: WireSegment[];
  junctions: Junction[];
  nets: Net[];
  /** Crossings we could not confidently classify. */
  ambiguousCrossings: Point[];
  /** Closed rectangles: component bodies and the sheet border, not conductors. */
  outlines: Rect[];
  wireMask: Bitmap;
}

export function defaultTraceOptions(bm: Bitmap): TraceOptions {
  const scale = Math.max(bm.width, bm.height);
  return {
    minRun: Math.max(12, Math.round(scale / 130)),
    tolerance: Math.max(3, Math.round(scale / 700)),
  };
}

// ---------------------------------------------------------------------------
// Segment extraction
// ---------------------------------------------------------------------------

interface Run {
  outer: number; // row for 'h', column for 'v'
  start: number;
  end: number; // exclusive
}

function collectRuns(bm: Bitmap, dir: 'h' | 'v', minRun: number): Run[] {
  const { width, height, data } = bm;
  const outerN = dir === 'h' ? height : width;
  const innerN = dir === 'h' ? width : height;
  const idx = (o: number, i: number) => (dir === 'h' ? o * width + i : i * width + o);

  const runs: Run[] = [];
  for (let o = 0; o < outerN; o++) {
    let start = -1;
    for (let i = 0; i <= innerN; i++) {
      const on = i < innerN && data[idx(o, i)] === 1;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        if (i - start >= minRun) runs.push({ outer: o, start, end: i });
        start = -1;
      }
    }
  }
  return runs;
}

/**
 * Merge runs from adjacent rows/columns that overlap along their length.
 *
 * A drawn wire is 2-5px thick, so it appears as several near-identical runs.
 * Collapsing them yields one segment with a meaningful stroke weight -- heavy
 * strokes are a useful hint for power rails.
 */
function mergeRuns(runs: Run[], dir: 'h' | 'v', tolerance: number): WireSegment[] {
  const byOuter = new Map<number, Run[]>();
  for (const r of runs) {
    const list = byOuter.get(r.outer);
    if (list) list.push(r);
    else byOuter.set(r.outer, [r]);
  }

  interface Group {
    runs: Run[];
    minOuter: number;
    maxOuter: number;
    start: number;
    end: number;
  }
  const groups: Group[] = [];
  let active: Group[] = [];

  const outers = [...byOuter.keys()].sort((a, b) => a - b);
  for (const o of outers) {
    const next: Group[] = [];
    for (const run of byOuter.get(o)!) {
      // Attach to an active group from the previous line if the spans overlap.
      const host = active.find(
        (g) =>
          g.maxOuter >= o - 1 - tolerance &&
          run.start < g.end + tolerance &&
          run.end > g.start - tolerance,
      );
      if (host) {
        host.runs.push(run);
        host.maxOuter = o;
        host.start = Math.min(host.start, run.start);
        host.end = Math.max(host.end, run.end);
        if (!next.includes(host)) next.push(host);
      } else {
        const g: Group = { runs: [run], minOuter: o, maxOuter: o, start: run.start, end: run.end };
        groups.push(g);
        next.push(g);
      }
    }
    // Groups not extended on this line stay eligible for one more line only.
    active = [...next, ...active.filter((g) => g.maxOuter >= o - 1 - tolerance && !next.includes(g))];
  }

  return groups.map((g, i) => {
    const centre = (g.minOuter + g.maxOuter) / 2;
    const weight = g.maxOuter - g.minOuter + 1;
    const a: Point = dir === 'h' ? { x: g.start, y: centre } : { x: centre, y: g.start };
    const b: Point = dir === 'h' ? { x: g.end, y: centre } : { x: centre, y: g.end };
    // `page` is stamped by tagSheet, once the sheet's place in the document
    // is known. The tracer works on one raster and has no idea which it is.
    return { id: `${dir}${i}`, a, b, orientation: dir, weight, page: 0 };
  });
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Is there a solder dot at (cx, cy)?
 *
 * A dot is drawn noticeably fatter than the wires meeting under it. We measure
 * the ink width on the diagonal, where neither an H nor a V wire contributes,
 * so anything we find there is either a dot or noise.
 */
function hasSolderDot(bm: Bitmap, cx: number, cy: number, wireWeight: number): boolean {
  const { width, height, data } = bm;
  const r = Math.max(3, Math.ceil(wireWeight * 1.6));
  let diagonalInk = 0;
  let diagonalTotal = 0;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      // Sample only off-axis pixels; on-axis is always covered by the wires.
      if (Math.abs(dx) <= wireWeight || Math.abs(dy) <= wireWeight) continue;
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      diagonalTotal++;
      diagonalInk += data[y * width + x];
    }
  }
  if (diagonalTotal < 4) return false;
  // A filled dot covers most of its disc; a bare crossing covers almost none.
  return diagonalInk / diagonalTotal > 0.45;
}

function onSegment(seg: WireSegment, p: Point, tol: number): boolean {
  if (seg.orientation === 'h') {
    return (
      Math.abs(p.y - seg.a.y) <= tol + seg.weight / 2 &&
      p.x >= seg.a.x - tol &&
      p.x <= seg.b.x + tol
    );
  }
  return (
    Math.abs(p.x - seg.a.x) <= tol + seg.weight / 2 &&
    p.y >= seg.a.y - tol &&
    p.y <= seg.b.y + tol
  );
}

function nearEndpoint(seg: WireSegment, p: Point, tol: number): boolean {
  const d = (q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  return d(seg.a) <= tol * 2.5 || d(seg.b) <= tol * 2.5;
}

/**
 * Find closed rectangles among the segments.
 *
 * This matters far more than it sounds. IC bodies, connector shells and the
 * sheet border are all drawn as rectangles of four long straight strokes --
 * indistinguishable from wire to the run detector. Left in the conductor
 * graph, a single IC outline shorts its VCC pin to its GND pin and cascades
 * into one enormous bogus net that swallows the whole page.
 *
 * A box is identified by all four corners closing within tolerance AND no
 * segment overhanging a corner. Real wires that happen to form a loop almost
 * always overhang, so the overhang test is what keeps this conservative.
 */
function findRectangles(
  hSegs: WireSegment[],
  vSegs: WireSegment[],
  tol: number,
): Array<{ rect: Rect; members: Set<string> }> {
  const out: Array<{ rect: Rect; members: Set<string> }> = [];
  const used = new Set<string>();
  const near = (a: number, b: number) => Math.abs(a - b) <= tol * 2;

  for (let i = 0; i < hSegs.length; i++) {
    for (let j = i + 1; j < hSegs.length; j++) {
      const top = hSegs[i].a.y < hSegs[j].a.y ? hSegs[i] : hSegs[j];
      const bot = hSegs[i].a.y < hSegs[j].a.y ? hSegs[j] : hSegs[i];
      if (used.has(top.id) || used.has(bot.id)) continue;
      // The horizontal pair must span the same x range.
      if (!near(top.a.x, bot.a.x) || !near(top.b.x, bot.b.x)) continue;

      const height = bot.a.y - top.a.y;
      if (height < tol * 3) continue;

      // A side must cover the full height, but need not stop exactly at the
      // corners: when two parts sit in the same column their touching edges
      // merge into one longer run. Overhang is allowed up to a fraction of the
      // box height, which keeps genuine long wires from qualifying as sides.
      const slack = Math.max(tol * 2, height * 0.4);
      const isSide = (v: WireSegment, x: number) =>
        !used.has(v.id) &&
        near(v.a.x, x) &&
        v.a.y <= top.a.y + tol * 2 &&
        v.b.y >= bot.a.y - tol * 2 &&
        top.a.y - v.a.y <= slack &&
        v.b.y - bot.a.y <= slack;

      const left = vSegs.find((v) => isSide(v, top.a.x));
      const right = vSegs.find((v) => v !== left && isSide(v, top.b.x));
      if (!left || !right) continue;

      out.push({
        rect: { x: top.a.x, y: top.a.y, w: top.b.x - top.a.x, h: height },
        members: new Set([top.id, bot.id, left.id, right.id]),
      });
      // Only the horizontals are consumed unconditionally. A side shared with
      // a neighbouring box must stay available to match that box too.
      [top, bot].forEach((s) => used.add(s.id));
    }
  }
  return out;
}

export function trace(bm: Bitmap, opts: TraceOptions): TraceResult {
  const hMask = keepLongRuns(bm, 'h', opts.minRun);
  const vMask = keepLongRuns(bm, 'v', opts.minRun);

  const hSegsAll = mergeRuns(collectRuns(hMask, 'h', opts.minRun), 'h', opts.tolerance);
  const vSegsAll = mergeRuns(collectRuns(vMask, 'v', opts.minRun), 'v', opts.tolerance);

  // Pull box outlines out of the conductor graph before doing any connectivity.
  const pageArea = bm.width * bm.height;
  const boxes = findRectangles(hSegsAll, vSegsAll, opts.tolerance);
  const outlineMembers = new Set<string>();
  const outlines: Rect[] = [];

  for (const box of boxes) {
    const area = box.rect.w * box.rect.h;
    // Anything covering most of the sheet is the border or title frame: drop
    // it entirely rather than offering it up as a giant "component".
    const isFrame = area > pageArea * 0.5;
    box.members.forEach((id) => outlineMembers.add(id));
    if (!isFrame) outlines.push(box.rect);
  }

  const hSegs = hSegsAll.filter((s) => !outlineMembers.has(s.id));
  const vSegs = vSegsAll.filter((s) => !outlineMembers.has(s.id));
  const segments = [...hSegs, ...vSegs];

  const index = new Map(segments.map((s, i) => [s.id, i]));
  const uf = new UnionFind(segments.length);
  const junctions: Junction[] = [];
  const ambiguousCrossings: Point[] = [];

  // --- H/V intersections -------------------------------------------------
  for (const h of hSegs) {
    for (const v of vSegs) {
      const px = v.a.x;
      const py = h.a.y;
      if (!onSegment(h, { x: px, y: py }, opts.tolerance)) continue;
      if (!onSegment(v, { x: px, y: py }, opts.tolerance)) continue;

      const hEnds = nearEndpoint(h, { x: px, y: py }, opts.tolerance);
      const vEnds = nearEndpoint(v, { x: px, y: py }, opts.tolerance);
      const weight = Math.max(h.weight, v.weight);

      // An L or T means at least one wire terminates here: unambiguously joined.
      const terminates = hEnds || vEnds;
      const dotted = hasSolderDot(bm, px, py, weight);

      if (terminates || dotted) {
        uf.union(index.get(h.id)!, index.get(v.id)!);
        junctions.push({
          id: `j${junctions.length}`,
          page: 0,
          at: { x: px, y: py },
          degree: terminates && !dotted ? 3 : 4,
          dotted,
        });
      } else {
        // A clean X with no dot: treat as a hop, but surface it for review.
        ambiguousCrossings.push({ x: px, y: py });
      }
    }
  }

  // --- Collinear continuation (a wire broken by a symbol or dashed style) --
  const joinCollinear = (list: WireSegment[], dir: 'h' | 'v') => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const axis = dir === 'h' ? Math.abs(a.a.y - b.a.y) : Math.abs(a.a.x - b.a.x);
        if (axis > opts.tolerance) continue;
        const gap =
          dir === 'h'
            ? Math.max(a.a.x, b.a.x) - Math.min(a.b.x, b.b.x)
            : Math.max(a.a.y, b.a.y) - Math.min(a.b.y, b.b.y);
        // Only bridge very small gaps; a large one usually means a real part.
        if (gap >= 0 && gap <= opts.tolerance * 2) {
          uf.union(index.get(a.id)!, index.get(b.id)!);
        }
      }
    }
  };
  joinCollinear(hSegs, 'h');
  joinCollinear(vSegs, 'v');

  // --- Build nets ---------------------------------------------------------
  const buckets = new Map<number, WireSegment[]>();
  segments.forEach((s, i) => {
    const root = uf.find(i);
    const list = buckets.get(root);
    if (list) list.push(s);
    else buckets.set(root, [s]);
  });

  const nets: Net[] = [];
  let n = 0;
  for (const group of buckets.values()) {
    const id = `net${n++}`;
    let length = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const s of group) {
      s.netId = id;
      length += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      minX = Math.min(minX, s.a.x, s.b.x);
      maxX = Math.max(maxX, s.a.x, s.b.x);
      minY = Math.min(minY, s.a.y, s.b.y);
      maxY = Math.max(maxY, s.a.y, s.b.y);
    }

    const bbox: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    const segIds = new Set(group.map((s) => s.id));
    const ownJunctions = junctions.filter((j) =>
      group.some((s) => onSegment(s, j.at, opts.tolerance)),
    );
    ownJunctions.forEach((j) => (j.netId = id));

    nets.push({
      id,
      page: 0,
      segmentIds: [...segIds],
      junctionIds: ownJunctions.map((j) => j.id),
      role: 'unknown',
      roleConfidence: 'low',
      roleSource: 'topology',
      rationale: [],
      bbox,
      length,
      pinIds: [],
    });
  }

  return {
    segments,
    junctions,
    nets,
    ambiguousCrossings,
    outlines,
    wireMask: { width: bm.width, height: bm.height, data: new Uint8Array(hMask.data.map((v, i) => v | vMask.data[i])) },
  };
}
