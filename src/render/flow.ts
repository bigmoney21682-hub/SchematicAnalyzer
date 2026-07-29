/**
 * Which way current and signal actually go.
 *
 * A traced net is an undirected set of segments -- the extractor knows the
 * copper, not which end drives it. But a person reading a schematic wants the
 * one thing the drawing does not print: where the 12V rail comes in and which
 * way it spreads, where a signal is sourced and where it lands. So this infers a
 * direction and the renderers draw arrowheads along the run.
 *
 * It is inference, not measurement, and the UI says so. The rule is one anchor
 * per net plus a distance ordering, which is deliberately simple:
 *
 *   ground   arrows point *toward* the ground symbol -- return current
 *   power    arrows point *away* from the source: a regulator or connector pin
 *            if one sits on the net, otherwise the top of the net, because
 *            supplies are drawn entering from above by near-universal convention
 *   signal   arrows point *away* from the driver: an IC or transistor pin if one
 *            is on the net, otherwise the left end, the same convention applied
 *            to signal flow
 *
 * Segments are then oriented by which endpoint is nearer the anchor. On the
 * Manhattan trees schematics are actually made of this agrees with a proper
 * graph traversal nearly everywhere, at a fraction of the cost -- and it degrades
 * into a locally-wrong arrow rather than a wrong net.
 */

import type { Component, ComponentKind, Net, Pin, Point, WireSegment } from '../core/model/types';

export interface FlowArrow {
  /** Where the arrowhead sits, in page coordinates. */
  at: Point;
  /** Direction it points, radians, screen convention (y down). */
  angle: number;
}

export interface FlowOptions {
  /** Segments shorter than this get no arrow -- they are stubs and joints. */
  minLength: number;
  /** Roughly one arrowhead per this much conductor. */
  spacing: number;
  /** Never put more than this many on one segment. */
  maxPerSegment?: number;
}

/** Parts that source a rail, in the order we would rather believe them. */
const SUPPLY_KINDS: ComponentKind[] = ['regulator', 'transformer', 'connector', 'fuse'];

/** Parts that drive a signal. An IC output beats a transistor collector. */
const DRIVER_KINDS: ComponentKind[] = ['ic', 'regulator', 'transistor', 'crystal', 'connector'];

/** Where a net's flow starts (or, for a return, where it ends). */
interface Anchor {
  at: Point;
  /** `toward` reverses every arrow: ground collects rather than distributes. */
  mode: 'away' | 'toward';
}

/**
 * The anchor for one net.
 *
 * Returns undefined when the net has no geometry to reason about at all, which
 * is the one case worth drawing nothing for.
 */
function anchorFor(
  net: Net,
  segs: WireSegment[],
  pinsOnNet: Pin[],
  kindOf: (componentId: string) => ComponentKind | undefined,
): Anchor | undefined {
  if (!segs.length) return undefined;

  const pinAt = (kinds: ComponentKind[]): Point | undefined => {
    for (const kind of kinds) {
      const pin = pinsOnNet.find((p) => kindOf(p.componentId) === kind);
      if (pin) return pin.at;
    }
    return undefined;
  };

  const ends = segs.flatMap((s) => [s.a, s.b]);
  const extreme = (pick: (a: Point, b: Point) => Point) => ends.reduce(pick);

  if (net.role === 'ground') {
    const sink =
      pinAt(['ground']) ??
      // Failing a named ground symbol, the bottom of the net: returns are drawn
      // downwards as consistently as supplies are drawn from the top.
      extreme((a, b) => (b.y > a.y ? b : a));
    return { at: sink, mode: 'toward' };
  }

  if (net.role === 'power' || net.role === 'reference') {
    const source = pinAt(SUPPLY_KINDS) ?? extreme((a, b) => (b.y < a.y ? b : a));
    return { at: source, mode: 'away' };
  }

  const driver = pinAt(DRIVER_KINDS) ?? extreme((a, b) => (b.x < a.x ? b : a));
  return { at: driver, mode: 'away' };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Arrowheads for one net, in page coordinates.
 *
 * `pinsOnNet` and `kindOf` are passed in rather than looked up here so a caller
 * drawing a whole sheet builds the indexes once instead of per net.
 */
export function netFlowArrows(
  net: Net,
  segs: WireSegment[],
  pinsOnNet: Pin[],
  kindOf: (componentId: string) => ComponentKind | undefined,
  opts: FlowOptions,
): FlowArrow[] {
  const anchor = anchorFor(net, segs, pinsOnNet, kindOf);
  if (!anchor) return [];

  const out: FlowArrow[] = [];
  const maxPer = opts.maxPerSegment ?? 3;

  for (const s of segs) {
    const length = dist(s.a, s.b);
    if (length < opts.minLength) continue;

    // Point away from the anchor, or back at it for a return path.
    const outward = dist(s.a, anchor.at) <= dist(s.b, anchor.at);
    const forward = anchor.mode === 'away' ? outward : !outward;
    const from = forward ? s.a : s.b;
    const to = forward ? s.b : s.a;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    // Spread the heads along the run: one in the middle of a short segment,
    // evenly spaced on a long one, so a rail crossing the sheet reads as a
    // direction rather than as a single ambiguous mark.
    const count = Math.max(1, Math.min(maxPer, Math.round(length / opts.spacing)));
    for (let i = 0; i < count; i++) {
      const t = (i + 1) / (count + 1);
      out.push({ at: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, angle });
    }
  }

  return out;
}

/** Component kind lookup for one sheet, built once per draw. */
export function kindLookup(components: Component[]): (componentId: string) => ComponentKind | undefined {
  const byId = new Map(components.map((c) => [c.id, c.kind]));
  return (id) => byId.get(id);
}

/** Pins grouped by the net they land on, built once per draw. */
export function pinsByNet(pins: Pin[]): Map<string, Pin[]> {
  const map = new Map<string, Pin[]>();
  for (const p of pins) {
    if (!p.netId) continue;
    const list = map.get(p.netId);
    if (list) list.push(p);
    else map.set(p.netId, [p]);
  }
  return map;
}

/**
 * Which of the two net layers a role belongs to.
 *
 * Power and ground travel together on the layer switch: they are the pair you
 * want alone on screen when you are chasing a supply problem, and a reference is
 * a rail as far as reading the drawing goes. Everything else -- including the
 * unclassified nets -- is signal.
 */
export const isPowerRole = (role: Net['role']): boolean =>
  role === 'power' || role === 'ground' || role === 'reference';
