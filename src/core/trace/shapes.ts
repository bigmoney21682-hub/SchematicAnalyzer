/**
 * Reading a symbol from its shape.
 *
 * Symbol detection used to decline this job outright, on the grounds that
 * telling a resistor zigzag from a capacitor on a compressed 1970s scan is
 * unreliable. That is true of the general problem and false of the specific
 * one: a handful of symbols are drawn from strokes so distinctive that simple
 * measurements settle them, and those few happen to be most of what is on a
 * sheet. A capacitor is two parallel bars facing each other across a gap. A
 * ground is two or three horizontal bars stacked and shrinking. Neither needs a
 * classifier, only a ruler.
 *
 * There is a second, less obvious reason to do this. Connected-component
 * labelling sees a capacitor as *two* blobs, because its plates do not touch --
 * so before this existed, every capacitor on the page was reported as two
 * unidentified fragments rather than one part. Pairing the strokes back up is
 * what turns them into a component at all; naming the result is almost a
 * side-effect.
 *
 * Everything here is deliberately conservative and everything says why. A shape
 * never overrides a reference designator or a part number -- it fills the gap
 * where there is neither, and corroborates where there is.
 */

import type { Bitmap } from '../image/raster';
import type { ComponentKind, Confidence, Rect, WireSegment } from '../model/types';

/** A blob as the labeller found it: where it is and how much ink is in it. */
export interface ShapeBlob {
  bbox: Rect;
  pixels: number;
}

export interface ShapeMatch {
  /** Blobs, by index, that this symbol is made of. */
  parts: number[];
  bbox: Rect;
  kind: ComponentKind;
  confidence: Confidence;
  /** Why, in the user's terms. Goes straight into the component's rationale. */
  why: string;
}

export interface ShapeOptions {
  /** Roughly the width of a drawn stroke, in pixels. Scales every tolerance. */
  stroke: number;
  /** How far a wire end may sit from a symbol and still count as its lead. */
  leadSnap: number;
  /**
   * Longest a stroke can be and still be part of a symbol rather than a wire.
   *
   * A capacitor plate is a few millimetres; a rail crosses the sheet. Sized off
   * the page so it means the same thing on a phone photo and a flatbed scan.
   */
  maxStrokeLength: number;
}

export function defaultShapeOptions(bm: Bitmap): ShapeOptions {
  const longest = Math.max(bm.width, bm.height);
  return {
    // A stroke on a 2600px sheet is 2-3px; on a phone photo of one, more.
    stroke: Math.max(2, Math.round(longest / 900)),
    leadSnap: Math.max(6, Math.round(longest / 200)),
    maxStrokeLength: Math.max(24, Math.round(longest / 22)),
  };
}

/**
 * Which sides of a symbol have a wire running into them.
 *
 * The single most useful fact about a two-terminal symbol, and the only thing
 * that reliably separates a ground from a capacitor: a capacitor is wired on
 * both faces, a ground on one. Everything else about the two -- parallel bars,
 * shared centre line, small gap -- can look identical once a scan has had its
 * way with the plate lengths.
 *
 * `axis` is the direction the leads travel: 'v' for a symbol fed from above and
 * below, 'h' for one fed from the sides.
 */
function leadsAcross(
  bbox: Rect,
  segments: WireSegment[],
  axis: 'h' | 'v',
  snap: number,
): { before: number; after: number } {
  const vertical = axis === 'v';
  // The faces the leads arrive at, along the direction of travel.
  const lo = vertical ? bbox.y : bbox.x;
  const hi = vertical ? bbox.y + bbox.h : bbox.x + bbox.w;
  // Wires must arrive within the symbol's own width, or a conductor merely
  // passing nearby gets counted as a lead.
  const spanLo = (vertical ? bbox.x : bbox.y) - snap;
  const spanHi = (vertical ? bbox.x + bbox.w : bbox.y + bbox.h) + snap;

  let before = 0;
  let after = 0;
  for (const s of segments) {
    for (const end of [s.a, s.b]) {
      const along = vertical ? end.y : end.x;
      const across = vertical ? end.x : end.y;
      if (across < spanLo || across > spanHi) continue;
      if (along >= lo - snap && along < lo) before++;
      else if (along > hi && along <= hi + snap) after++;
    }
  }
  return { before, after };
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

interface Metrics {
  bbox: Rect;
  /** Long axis of the bounding box. */
  major: 'h' | 'v';
  /** Long side divided by short side, never below 1. */
  elongation: number;
  /** Ink pixels as a share of the bounding box. A solid bar is near 1. */
  fill: number;
  /** Ink counted along x (one entry per column) and along y (per row). */
  cols: Uint16Array;
  rows: Uint16Array;
  /**
   * Where the ink sits, across the short axis, at each step along the long one.
   *
   * The profiles above count ink and cannot see a wiggle at all: a coil drawn
   * as a stroke of constant thickness has the same number of pixels in every
   * column whether it is a straight line or a spring. What moves is the ink's
   * position, so that is what this records -- and it is the only measurement
   * that separates a zigzag from a rule. NaN where a step has no ink.
   */
  spine: Float64Array;
}

function measure(bm: Bitmap, bbox: Rect): Metrics {
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(bm.width - 1, Math.ceil(bbox.x + bbox.w) - 1);
  const y1 = Math.min(bm.height - 1, Math.ceil(bbox.y + bbox.h) - 1);
  const w = Math.max(1, x1 - x0 + 1);
  const h = Math.max(1, y1 - y0 + 1);

  const cols = new Uint16Array(w);
  const rows = new Uint16Array(h);
  // Running sums of the cross-axis coordinate, to average into the spine.
  const colSum = new Float64Array(w);
  const rowSum = new Float64Array(h);
  let ink = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!bm.data[y * bm.width + x]) continue;
      ink++;
      cols[x - x0]++;
      rows[y - y0]++;
      colSum[x - x0] += y - y0;
      rowSum[y - y0] += x - x0;
    }
  }

  const major: 'h' | 'v' = w >= h ? 'h' : 'v';
  const steps = major === 'h' ? w : h;
  const counts = major === 'h' ? cols : rows;
  const sums = major === 'h' ? colSum : rowSum;
  const spine = new Float64Array(steps);
  for (let i = 0; i < steps; i++) spine[i] = counts[i] ? sums[i] / counts[i] : NaN;

  const long = Math.max(w, h);
  const short = Math.max(1, Math.min(w, h));
  return {
    bbox: { x: x0, y: y0, w, h },
    major,
    elongation: long / short,
    fill: ink / (w * h),
    cols,
    rows,
    spine,
  };
}

/** True if the blob is a single straight stroke: long, thin and solid. */
function isBar(m: Metrics, opts: ShapeOptions): boolean {
  const thickness = Math.min(m.bbox.w, m.bbox.h);
  return (
    m.elongation >= 2.5 &&
    thickness <= opts.stroke * 3.5 &&
    // A solid stroke fills most of its own box. A curve or a zigzag does not,
    // which is exactly what keeps an inductor's arc from reading as a plate.
    m.fill >= 0.55
  );
}

/** What the ink's path along a symbol looks like. */
interface Wiggle {
  /** Times the path crossed its own centre line, decisively. */
  crossings: number;
  /** How far it strays from that centre line, in pixels. */
  amplitude: number;
  /**
   * Share of the path spent out at the extremes rather than in the middle.
   *
   * This is what tells a coil from a zigzag, and it is the only thing that
   * does. Both wander up and down the same number of times over the same
   * length; the difference is the shape of the travel. A zigzag moves at a
   * constant rate and so spends its time evenly spread across the range, giving
   * about 0.5. A run of round humps lingers at the top and bottom of each arc
   * and hurries through the middle, giving about 0.67. Everything between is
   * genuinely ambiguous on a scan and is left unnamed.
   */
  atExtremes: number;
}

/**
 * Measure how a symbol's ink path oscillates.
 *
 * Small excursions are ignored so JPEG noise on a scan cannot manufacture a
 * wiggle that is not there.
 */
function wiggleOf(spine: Float64Array): Wiggle {
  const values: number[] = [];
  for (const v of spine) if (Number.isFinite(v)) values.push(v);
  if (values.length < 8) return { crossings: 0, amplitude: 0, atExtremes: 0 };

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const deviations = values.map((v) => v - mean);
  const amplitude = Math.max(...deviations.map(Math.abs));
  if (amplitude < 1.5) return { crossings: 0, amplitude, atExtremes: 0 };

  // Hysteresis: a crossing counts only once the path has committed to the far
  // side, so a stroke jittering along the centre line does not read as a coil.
  const band = amplitude * 0.35;
  let crossings = 0;
  let state = 0;
  for (const d of deviations) {
    const next = d > band ? 1 : d < -band ? -1 : state;
    if (state && next && next !== state) crossings++;
    state = next;
  }

  const outer = deviations.filter((d) => Math.abs(d) > amplitude * 0.5).length;
  return { crossings, amplitude, atExtremes: outer / deviations.length };
}

/**
 * How steadily the profile shrinks from one end to the other, 0..1.
 *
 * A ground symbol's stack of bars narrows downwards; a diode's triangle
 * narrows to its point. Both are the same measurement in different axes.
 */
function taper(profile: Uint16Array): number {
  const n = profile.length;
  if (n < 3) return 0;
  const head = average(profile, 0, Math.floor(n / 3));
  const tail = average(profile, n - Math.floor(n / 3), n);
  if (head <= 0) return 0;
  return Math.max(0, Math.min(1, (head - tail) / head));
}

function average(xs: Uint16Array, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(xs.length, to); i++) {
    sum += xs[i];
    n++;
  }
  return n ? sum / n : 0;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function centre(r: Rect) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Name what shapes can be named, and say which blobs each one used up.
 *
 * Matches are returned in the order they were found, and no blob appears in
 * more than one -- the caller can therefore fold every match into a single
 * component and drop the fragments it was built from.
 */
export function detectShapes(
  residue: Bitmap,
  blobs: ShapeBlob[],
  opts: ShapeOptions,
  segments: WireSegment[] = [],
): ShapeMatch[] {
  const metrics = blobs.map((b) => measure(residue, b.bbox));
  const used = new Set<number>();
  const matches: ShapeMatch[] = [];

  const take = (m: ShapeMatch) => {
    if (m.parts.some((i) => used.has(i))) return;
    for (const i of m.parts) used.add(i);
    matches.push(m);
  };

  // Ground first. Its bars are also a valid capacitor pair if you only look at
  // two of them, so the more specific stacked reading has to get first refusal.
  for (const m of groundStacks(metrics, opts, segments)) take(m);
  for (const m of capacitorPairs(metrics, opts)) take(m);
  for (const m of diodePairs(metrics, opts)) take(m);
  for (const m of singleBlobShapes(metrics, opts, used)) take(m);

  // Then the same two symbols again, read from the tracer's own strokes rather
  // than from leftover ink -- see `strokeShapes` for why that is necessary.
  // Anything already found above wins, since it was found from real ink.
  const claimedArea = matches.map((m) => m.bbox);
  for (const m of strokeShapes(segments, opts)) {
    if (claimedArea.some((r) => overlapFraction(r, m.bbox) > 0.3)) continue;
    matches.push(m);
  }

  return matches;
}

/** Intersection as a share of the smaller rectangle. */
function overlapFraction(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? (ox * oy) / smaller : 0;
}

// ---------------------------------------------------------------------------
// Symbols read from the tracer's strokes
// ---------------------------------------------------------------------------

/**
 * Find capacitors and grounds among the conductors.
 *
 * This exists because of an awkward truth about the pipeline: the two symbols
 * the user most wants named are made of short straight lines, and short
 * straight lines are exactly what the wire tracer collects. A capacitor plate
 * is four or five millimetres of horizontal rule -- perhaps thirty pixels on a
 * full sheet -- and the tracer claims any run longer than about twenty. So by
 * the time symbol detection looks at the leftover ink, every capacitor plate
 * and every bar of every ground symbol has already been filed as wire and is
 * simply not there to be recognised.
 *
 * Reading them back out of the traced strokes is both the fix and, as it turns
 * out, the better measurement: these are already clean vectors with endpoints
 * and orientation, so the geometry is exact instead of inferred from pixels.
 *
 * The strokes are left in the conductor graph rather than removed from it. A
 * ground's bars really are electrically the node they sit on, so leaving them
 * costs nothing there; a capacitor's plates are not connected to each other,
 * but they are separate strokes and the tracer never joined them, so the
 * netlist is unaffected either way.
 */
function strokeShapes(segments: WireSegment[], opts: ShapeOptions): ShapeMatch[] {
  const short = segments
    .map((s, i) => ({
      i,
      s,
      length: Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y),
      mid: { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 },
    }))
    .filter((e) => e.length >= opts.stroke * 3 && e.length <= opts.maxStrokeLength);

  const out: ShapeMatch[] = [];
  const claimed = new Set<number>();

  // --- Ground: horizontal strokes stacked on a centre line, each shorter -----
  const bars = short.filter((e) => e.s.orientation === 'h').sort((a, b) => a.mid.y - b.mid.y);
  for (const seed of bars) {
    if (claimed.has(seed.i)) continue;
    const stack = [seed];
    let last = seed;
    for (;;) {
      const next = bars.find((c) => {
        if (claimed.has(c.i) || stack.some((s) => s.i === c.i)) return false;
        const drop = c.mid.y - last.mid.y;
        if (drop <= 0 || drop > last.length * 0.9 + opts.stroke * 3) return false;
        if (c.length >= last.length * 0.92 || c.length < last.length * 0.3) return false;
        return Math.abs(c.mid.x - last.mid.x) <= last.length * 0.3;
      });
      if (!next) break;
      stack.push(next);
      last = next;
    }
    // Two bars is too weak here: unlike the ink version there is no fill or
    // thickness to corroborate with, and a rail above a shorter rail is common.
    if (stack.length < 3) continue;

    const bbox = boundsOf(stack.map((e) => e.s));
    if (bbox.h > bbox.w * 1.1) continue;
    for (const e of stack) claimed.add(e.i);
    out.push({
      parts: [],
      bbox,
      kind: 'ground',
      confidence: 'high',
      why:
        `${stack.length} horizontal strokes stacked on a common centre line, each shorter than the ` +
        'one above -- the standard earth/ground symbol.',
    });
  }

  // --- Capacitor: two facing strokes of near-equal length --------------------
  for (let a = 0; a < short.length; a++) {
    const p = short[a];
    if (claimed.has(p.i)) continue;
    for (let b = a + 1; b < short.length; b++) {
      const q = short[b];
      if (claimed.has(q.i) || claimed.has(p.i)) continue;
      if (p.s.orientation !== q.s.orientation) continue;

      const plate = Math.min(p.length, q.length);
      if (Math.max(p.length, q.length) > plate * 1.35) continue;

      const horizontal = p.s.orientation === 'h';
      const across = horizontal ? Math.abs(p.mid.y - q.mid.y) : Math.abs(p.mid.x - q.mid.x);
      const slide = horizontal ? Math.abs(p.mid.x - q.mid.x) : Math.abs(p.mid.y - q.mid.y);
      if (across < opts.stroke || across > plate * 0.9) continue;
      if (slide > plate * 0.25) continue;

      // Both plates must be wired from the outside -- that is what separates a
      // capacitor from any other pair of parallel rules on a busy sheet.
      //
      // Only strokes running across the plates are counted. A lead ends exactly
      // on the plate it feeds, so a test by position alone cannot tell the lead
      // from the plate; a lead is always perpendicular to what it feeds, and
      // that distinction is free here because the tracer records orientation.
      const bbox = boundsOf([p.s, q.s]);
      const leads = perpendicularLeads(bbox, segments, horizontal, opts.leadSnap);
      if (!leads.before || !leads.after) continue;

      claimed.add(p.i);
      claimed.add(q.i);
      out.push({
        parts: [],
        bbox,
        kind: 'capacitor',
        confidence: 'medium',
        why:
          'Two parallel plates of near-equal length facing each other across a gap, wired from both ' +
          'sides -- a capacitor symbol.',
      });
      break;
    }
  }

  return out;
}

/**
 * Leads arriving at the two faces of a symbol built from strokes.
 *
 * `platesAreHorizontal` says which way the symbol's own strokes run; the leads
 * are the ones running the other way. Counted on each side separately, because
 * "wired from both faces" is the whole question being asked.
 */
function perpendicularLeads(
  bbox: Rect,
  segments: WireSegment[],
  platesAreHorizontal: boolean,
  snap: number,
): { before: number; after: number } {
  const lo = platesAreHorizontal ? bbox.y : bbox.x;
  const hi = platesAreHorizontal ? bbox.y + bbox.h : bbox.x + bbox.w;
  const spanLo = (platesAreHorizontal ? bbox.x : bbox.y) - snap;
  const spanHi = (platesAreHorizontal ? bbox.x + bbox.w : bbox.y + bbox.h) + snap;
  const wanted = platesAreHorizontal ? 'v' : 'h';

  let before = 0;
  let after = 0;
  for (const s of segments) {
    if (s.orientation !== wanted) continue;
    for (const end of [s.a, s.b]) {
      const along = platesAreHorizontal ? end.y : end.x;
      const across = platesAreHorizontal ? end.x : end.y;
      if (across < spanLo || across > spanHi) continue;
      if (along <= lo && along >= lo - snap) before++;
      else if (along >= hi && along <= hi + snap) after++;
    }
  }
  return { before, after };
}

function boundsOf(segs: WireSegment[]): Rect {
  const xs = segs.flatMap((s) => [s.a.x, s.b.x]);
  const ys = segs.flatMap((s) => [s.a.y, s.b.y]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * The earth symbol: horizontal bars stacked on a shared centre line, each one
 * shorter than the one above it.
 *
 * Two bars is the minimum -- the signal-ground symbol drawn as a bar and a
 * shorter bar -- but three is the common form and is scored higher, because two
 * unrelated horizontal strokes that happen to line up are a thing that occurs
 * on a dense sheet and three are not.
 *
 * The two-bar case is also, geometrically, a capacitor: a scan that shortened
 * one plate by a tenth produces the same measurements. What settles it is the
 * wiring, not the shape -- a ground is fed from one side and a capacitor from
 * both -- so a candidate wired on both faces is handed back for the capacitor
 * rule to claim. Where the tracer found no leads at all there is nothing to go
 * on, and the shrink has to be pronounced before the call is made.
 */
function groundStacks(metrics: Metrics[], opts: ShapeOptions, segments: WireSegment[]): ShapeMatch[] {
  const out: ShapeMatch[] = [];
  const bars = metrics
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.major === 'h' && isBar(m, opts));

  const claimed = new Set<number>();

  for (const seed of bars) {
    if (claimed.has(seed.i)) continue;

    // Walk downwards from the widest bar, taking each next bar that is centred
    // under the last, narrower than it, and close enough to belong to it.
    const stack = [seed];
    let last = seed;
    for (;;) {
      const next = bars
        .filter(({ i, m }) => {
          if (claimed.has(i) || stack.some((s) => s.i === i)) return false;
          const gap = m.bbox.y - (last.m.bbox.y + last.m.bbox.h);
          if (gap < 0 || gap > last.m.bbox.h + opts.stroke * 4) return false;
          if (m.bbox.w >= last.m.bbox.w * 0.95) return false;
          if (m.bbox.w < last.m.bbox.w * 0.25) return false;
          return Math.abs(centre(m.bbox).x - centre(last.m.bbox).x) <= last.m.bbox.w * 0.25;
        })
        .sort((a, b) => a.m.bbox.y - b.m.bbox.y)[0];
      if (!next) break;
      stack.push(next);
      last = next;
    }

    if (stack.length < 2) continue;

    // The whole symbol is wider than it is tall. A tall thin stack of shrinking
    // bars is not an earth, it is a coincidence.
    const bbox = stack.map((s) => s.m.bbox).reduce(union);
    if (bbox.h > bbox.w * 1.2) continue;

    // Wired on both faces? Then it is a two-terminal part, whatever its bars
    // measure -- leave it for the capacitor rule.
    const leads = leadsAcross(bbox, segments, 'v', opts.leadSnap);
    const wiredBothWays = leads.before > 0 && leads.after > 0;
    if (wiredBothWays) continue;

    const shrink = stack[1].m.bbox.w / stack[0].m.bbox.w;
    const oneLead = leads.before > 0 || leads.after > 0;
    if (stack.length === 2 && !oneLead && shrink > 0.72) continue;

    for (const s of stack) claimed.add(s.i);
    out.push({
      parts: stack.map((s) => s.i),
      bbox,
      kind: 'ground',
      confidence: stack.length >= 3 ? 'high' : oneLead ? 'medium' : 'low',
      why:
        `${stack.length} horizontal bars stacked on a common centre line, each shorter than the one ` +
        `above -- the standard earth/ground symbol` +
        (oneLead ? ', wired from one side only.' : '.'),
    });
  }

  return out;
}

/**
 * A capacitor: two bars of similar length, parallel, facing each other across a
 * gap, with nothing between them.
 *
 * The gap is the whole test. Two parallel strokes a long way apart are two
 * separate parts; a plate separation is a fraction of the plate's own length,
 * because that is how the symbol is drawn at every scale.
 */
function capacitorPairs(metrics: Metrics[], opts: ShapeOptions): ShapeMatch[] {
  const out: ShapeMatch[] = [];
  const plates = metrics
    .map((m, i) => ({ m, i }))
    // A polarised capacitor's second plate is a shallow arc, not a bar, so the
    // fill test is relaxed here and the pair is judged on geometry instead.
    .filter(({ m }) => m.elongation >= 2 && m.fill >= 0.3 && Math.min(m.bbox.w, m.bbox.h) <= opts.stroke * 5);

  const claimed = new Set<number>();

  for (let a = 0; a < plates.length; a++) {
    if (claimed.has(plates[a].i)) continue;
    for (let b = a + 1; b < plates.length; b++) {
      if (claimed.has(plates[b].i) || claimed.has(plates[a].i)) continue;
      const p = plates[a].m;
      const q = plates[b].m;
      if (p.major !== q.major) continue;

      const along = p.major === 'h' ? 'w' : 'h'; // the plates' own length
      const plateLen = Math.min(p.bbox[along], q.bbox[along]);
      const longer = Math.max(p.bbox[along], q.bbox[along]);
      // Plates are drawn the same length. Allowing a little slack covers a
      // polarised cap, whose curved plate measures slightly wider.
      if (longer > plateLen * 1.7) continue;

      // Separation is measured across the plates, alignment along them.
      const pc = centre(p.bbox);
      const qc = centre(q.bbox);
      const across = p.major === 'h' ? Math.abs(pc.y - qc.y) : Math.abs(pc.x - qc.x);
      const slide = p.major === 'h' ? Math.abs(pc.x - qc.x) : Math.abs(pc.y - qc.y);

      if (across < opts.stroke * 1.5 || across > plateLen * 1.1) continue;
      if (slide > plateLen * 0.3) continue;

      const curved = Math.min(p.fill, q.fill) < 0.55;
      claimed.add(plates[a].i);
      claimed.add(plates[b].i);
      out.push({
        parts: [plates[a].i, plates[b].i],
        bbox: union(p.bbox, q.bbox),
        kind: 'capacitor',
        confidence: 'medium',
        why: curved
          ? 'Two facing plates of similar length, one of them curved -- a polarised (electrolytic) ' +
            'capacitor symbol. The curved plate is the negative side.'
          : 'Two parallel plates of similar length facing each other across a gap -- a capacitor symbol.',
      });
      break;
    }
  }

  return out;
}

/**
 * A diode: a triangle with a bar across its point.
 *
 * The triangle is found by its taper -- ink that thins steadily to nothing
 * along one axis -- and the bar by sitting at the narrow end, crosswise.
 */
function diodePairs(metrics: Metrics[], opts: ShapeOptions): ShapeMatch[] {
  const out: ShapeMatch[] = [];
  const claimed = new Set<number>();

  metrics.forEach((tri, i) => {
    if (claimed.has(i)) return;
    if (tri.fill < 0.3 || tri.elongation > 2.2) return;

    // Which way does it point? Taper is checked in both directions on both
    // axes, because a diode may be drawn pointing any of four ways.
    const axes: Array<{ axis: 'h' | 'v'; profile: Uint16Array; reversed: boolean }> = [
      { axis: 'h', profile: tri.cols, reversed: false },
      { axis: 'h', profile: reverse(tri.cols), reversed: true },
      { axis: 'v', profile: tri.rows, reversed: false },
      { axis: 'v', profile: reverse(tri.rows), reversed: true },
    ];
    const best = axes
      .map((a) => ({ ...a, score: taper(a.profile) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best.score < 0.55) return;

    // The bar sits beyond the point, perpendicular to the direction of travel.
    const point = pointEnd(tri.bbox, best.axis, best.reversed);
    const barIndex = metrics.findIndex((bar, j) => {
      if (j === i || claimed.has(j)) return false;
      if (!isBar(bar, opts)) return false;
      if (bar.major === best.axis) return false; // must lie across the point
      const c = centre(bar.bbox);
      const near = best.axis === 'h' ? Math.abs(c.x - point.x) : Math.abs(c.y - point.y);
      const side = best.axis === 'h' ? Math.abs(c.y - point.y) : Math.abs(c.x - point.x);
      const span = best.axis === 'h' ? tri.bbox.h : tri.bbox.w;
      return near <= opts.stroke * 4 && side <= span * 0.6;
    });
    if (barIndex < 0) return;

    claimed.add(i);
    claimed.add(barIndex);
    out.push({
      parts: [i, barIndex],
      bbox: union(tri.bbox, metrics[barIndex].bbox),
      kind: 'diode',
      confidence: 'medium',
      why:
        'A triangle tapering to a point with a bar across it -- a diode symbol. The bar is the ' +
        'cathode, so conventional current flows towards it.',
    });
  });

  return out;
}

function reverse(xs: Uint16Array): Uint16Array {
  const out = new Uint16Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[xs.length - 1 - i];
  return out;
}

/** The narrow end of a tapering blob, in page coordinates. */
function pointEnd(r: Rect, axis: 'h' | 'v', reversed: boolean) {
  if (axis === 'h') return { x: reversed ? r.x : r.x + r.w, y: r.y + r.h / 2 };
  return { x: r.x + r.w / 2, y: reversed ? r.y : r.y + r.h };
}

/**
 * Symbols drawn as one continuous wandering stroke: coils and zigzags.
 *
 * Both are long, thin and wiggly, and separating them is the hardest call in
 * this file -- they differ only in whether the travel is round or angular,
 * which is exactly the distinction a compressed scan destroys first. So the
 * verdict is only offered when the measurement is decisive, and at low
 * confidence even then. An ambiguous stroke is left unnamed rather than guessed
 * at: a wrong part in a parts list is worse than a missing one, because the
 * user has no reason to go looking for it.
 */
function singleBlobShapes(metrics: Metrics[], opts: ShapeOptions, used: Set<number>): ShapeMatch[] {
  const out: ShapeMatch[] = [];

  metrics.forEach((m, i) => {
    if (used.has(i)) return;
    if (m.elongation < 2.5) return;
    // A solid body has no path to trace; a stroke this thin is a rule.
    if (m.fill > 0.6) return;
    if (Math.min(m.bbox.w, m.bbox.h) < opts.stroke * 2) return;

    const { crossings, amplitude, atExtremes } = wiggleOf(m.spine);
    // Three crossings is one and a half full excursions -- the least that could
    // be called periodic. Anything less is a bent lead.
    if (crossings < 3) return;
    if (amplitude < opts.stroke * 1.5) return;

    if (atExtremes >= 0.6) {
      out.push({
        parts: [i],
        bbox: m.bbox,
        kind: 'inductor',
        confidence: 'low',
        why: `A single stroke tracing about ${Math.max(1, Math.round(crossings / 2))} rounded humps -- an inductor or coil.`,
      });
    } else if (atExtremes <= 0.52) {
      out.push({
        parts: [i],
        bbox: m.bbox,
        kind: 'resistor',
        confidence: 'low',
        why: `A single stroke zigzagging ${crossings} times with straight sides -- a resistor symbol.`,
      });
    }
  });

  return out;
}
