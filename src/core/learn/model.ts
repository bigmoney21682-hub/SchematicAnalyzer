/**
 * Learning from the user's corrections.
 *
 * The rules in `rules/classify` and `rules/parts` are fixed knowledge: what GND
 * means, what a three-terminal regulator's output pin is, that a refdes
 * beginning "R" is a resistor. This is the other half -- the things that are
 * true of *your* schematics and could not have been shipped in the box. A 1970s
 * Japanese service manual writes its supply rail "B+"; one manufacturer's
 * drawings mark protection nets with a caption no lexicon has; a symbol this
 * detector has never managed to name is, on these drawings, always a
 * feedthrough capacitor. Correct the same thing twice and the tool should stop
 * asking.
 *
 * Two decisions are learned, and they are the same problem twice over: what a
 * **net** is, and what a **component** is. Both are "given this evidence, which
 * of a fixed set of labels", so both run through one scorer -- only the feature
 * extraction differs.
 *
 * Three commitments shape the design, all of them following from the fact that
 * a person is going to have to trust the output:
 *
 *   Rules first, always. Nothing here runs until the rule engine has had its
 *   say, and it only revises conclusions the rules were not sure of -- unless
 *   the same correction has been made repeatedly on an identical net label or
 *   part number, which is the user telling us plainly that the rule is wrong
 *   for their drawings.
 *
 *   Never overrule the user. A role or kind the user set is final, on that
 *   entity.
 *
 *   Explain, in the same breath. Everything this assigns writes a rationale
 *   naming what it learned from and how often, so an inherited mistake is
 *   visible and can be forgotten from the Learned tab.
 *
 * The model itself is deliberately small: counts of features against classes,
 * scored as naive Bayes over the features it has actually seen before. That is
 * unfashionable and exactly right here -- it learns from a single example, it
 * costs nothing on a phone, it can say why, and one wrong entry can be deleted
 * without retraining anything.
 */

import type {
  Component,
  ComponentKind,
  Confidence,
  Net,
  NetRole,
  Pin,
  TextItem,
  WireSegment,
} from '../model/types';
import { COMPONENT_LABELS, ROLE_LABELS } from '../model/types';
import type { ClassifyContext } from '../rules/classify';
import { textToNetDistance } from '../rules/classify';
import { parseValue } from '../rules/parts';
import { hintsFor } from '../jp/lexicon';
import { clearLearning, loadLearning, saveLearning } from '../../storage/db';

const STORE_ID = 'nets';
const VERSION = 3;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What the user has settled about one exact net label or part number. */
export interface KeyMemory<C extends string> {
  /** Class -> how many times the user assigned it to an entity with this key. */
  classes: Partial<Record<C, number>>;
  /** A number they attached alongside. Nets only; the nominal voltage. */
  voltage?: number;
  updatedAt: number;
}

/** A correction, kept so the Learned tab can show its working. */
export interface CorrectionRecord<C extends string> {
  at: number;
  docName: string;
  key?: string;
  from: C;
  to: C;
}

/** Everything learned about one kind of decision. */
export interface ClassModel<C extends string> {
  /** Feature counts per class. */
  counts: Partial<Record<C, Record<string, number>>>;
  /** Total feature weight per class, for the prior. */
  totals: Partial<Record<C, number>>;
  /** Exact-key memory: net label, or part number. */
  keys: Record<string, KeyMemory<C>>;
  /** Most recent corrections, newest first. */
  history: Array<CorrectionRecord<C>>;
  corrections: number;
}

export interface LearnedModel {
  version: number;
  nets: ClassModel<NetRole>;
  components: ClassModel<ComponentKind>;
  updatedAt: number;
}

const emptyClassModel = <C extends string>(): ClassModel<C> => ({
  counts: {},
  totals: {},
  keys: {},
  history: [],
  corrections: 0,
});

export function emptyModel(): LearnedModel {
  return {
    version: VERSION,
    nets: emptyClassModel<NetRole>(),
    components: emptyClassModel<ComponentKind>(),
    updatedAt: 0,
  };
}

/** Corrections across both halves -- what the Learned tab counts. */
export const totalCorrections = (m: LearnedModel | null | undefined): number =>
  m ? m.nets.corrections + m.components.corrections : 0;

export const isEmpty = (m: LearnedModel | null | undefined): boolean => totalCorrections(m) === 0;

/** How many corrections are kept for display. The counts themselves are forever. */
const HISTORY_LIMIT = 60;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The pre-3 layout, when only nets were learned and their fields were flat. */
interface LegacyModel {
  version: number;
  counts?: ClassModel<NetRole>['counts'];
  totals?: ClassModel<NetRole>['totals'];
  labels?: Record<string, { roles: Partial<Record<NetRole, number>>; voltage?: number; updatedAt: number }>;
  history?: Array<{ at: number; docName: string; label?: string; from: NetRole; to: NetRole }>;
  corrections?: number;
}

export async function loadModel(): Promise<LearnedModel> {
  try {
    const stored = await loadLearning<LearnedModel | LegacyModel>(STORE_ID);
    if (!stored) return emptyModel();
    if (stored.version === VERSION) return { ...emptyModel(), ...(stored as LearnedModel) };
    // Corrections are expensive to make and cheap to carry forward; a schema
    // change is no reason to make someone teach the tool the same things twice.
    if (stored.version === 2) return migrateFromV2(stored as LegacyModel);
    return emptyModel();
  } catch {
    return emptyModel();
  }
}

function migrateFromV2(old: LegacyModel): LearnedModel {
  const model = emptyModel();
  model.nets = {
    counts: old.counts ?? {},
    totals: old.totals ?? {},
    keys: Object.fromEntries(
      Object.entries(old.labels ?? {}).map(([k, v]) => [
        k,
        { classes: v.roles, voltage: v.voltage, updatedAt: v.updatedAt },
      ]),
    ),
    history: (old.history ?? []).map((h) => ({
      at: h.at,
      docName: h.docName,
      key: h.label,
      from: h.from,
      to: h.to,
    })),
    corrections: old.corrections ?? 0,
  };
  model.updatedAt = Date.now();
  return model;
}

export const persistModel = (model: LearnedModel) => saveLearning(STORE_ID, model);
export const resetModel = () => clearLearning(STORE_ID);

// ---------------------------------------------------------------------------
// Keys and buckets
// ---------------------------------------------------------------------------

/**
 * Normalise a net label or part number to what counts as "the same".
 *
 * OCR of a 40-year-old scan is not consistent about spacing or case, and the
 * point of the exact-key memory is that "B+ " read off sheet 2 and "b+" read
 * off sheet 9 are one thing the user has already ruled on.
 */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    // Full-width forms are common in Japanese drawings and mean the same thing.
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** The shape of a string with its digits collapsed, e.g. "+12V" -> "+NV". */
function shapeOf(text: string): string {
  return text.replace(/\d+/g, 'N').replace(/[.,]/g, '');
}

function bucket(value: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * The evidence available about one net, as a bag of strings.
 *
 * Everything the rules looked at plus the rules' own verdict, so the model can
 * learn corrections of the *form* "when the rules call a short net off a
 * regulator a power rail, on my drawings it is actually the reference".
 */
export function netFeatures(net: Net, ctx: ClassifyContext): string[] {
  const out: string[] = [];
  const { texts, components, pins, segments, pageScale } = ctx;

  out.push(`rule:${net.roleSource}:${net.role}`);
  out.push(`ruleconf:${net.roleConfidence}`);

  if (net.label) {
    const key = normalizeKey(net.label);
    out.push(`lbl:${key}`);
    out.push(`shape:${shapeOf(key)}`);
    if (key.length) out.push(`head:${key.slice(0, 2)}`);
    if (key.length > 2) out.push(`tail:${key.slice(-2)}`);
    if (/\d/.test(key)) out.push('lbl:hasdigit');
    if (/^[+-]/.test(key)) out.push(`lbl:signed:${key[0]}`);
  } else {
    out.push('lbl:none');
  }

  // Topology, coarsely bucketed -- the exact pixel length of a net is noise,
  // "one of the long ones" is signal.
  const relative = pageScale ? net.length / pageScale : 0;
  out.push(`len:${bucket(relative, [0.02, 0.06, 0.15, 0.35, 0.8])}`);
  out.push(`pins:${bucket(net.pinIds.length, [1, 2, 3, 5, 9])}`);

  const segs = segments.filter((s) => s.netId === net.id);
  if (segs.length) {
    const weight = segs.reduce((t, s) => t + s.weight, 0) / segs.length;
    out.push(`weight:${bucket(weight, [1.5, 2.5, 4, 6])}`);
    const vertical = segs.filter((s) => s.orientation === 'v').length / segs.length;
    out.push(`vert:${bucket(vertical, [0.25, 0.75])}`);
  }

  // What it touches.
  const byId = new Map(components.map((c) => [c.id, c]));
  const kinds = new Set<string>();
  for (const p of pins.filter((pp) => pp.netId === net.id)) {
    const comp = byId.get(p.componentId);
    if (comp) kinds.add(comp.kind);
    if (p.name) out.push(`pinname:${p.name.toUpperCase()}`);
  }
  for (const k of kinds) out.push(`nbr:${k}`);

  out.push(...captionFeatures(texts, segs, pageScale));
  return [...new Set(out)];
}

/**
 * The evidence available about one component.
 *
 * The unlabelled ones are the whole point of this: a symbol with no readable
 * refdes and no part number is exactly what the detector gives up on, and all
 * that is left is its shape, its size, how many conductors land on it and what
 * they are. Those are weak signals individually and perfectly serviceable once
 * the user has confirmed a handful of the same thing.
 */
export function componentFeatures(comp: Component, ctx: ClassifyContext): string[] {
  const out: string[] = [];
  const { texts, nets, pins, segments, pageScale } = ctx;

  out.push(`rule:${comp.kindSource ?? 'detector'}:${comp.kind}`);
  out.push(`ruleconf:${comp.kindConfidence}`);

  // The refdes prefix is the strongest cheap signal there is, and the letters
  // used vary by manufacturer and era -- exactly the sort of thing worth
  // learning rather than shipping a fixed table of.
  if (comp.refdes) {
    const key = normalizeKey(comp.refdes);
    const prefix = key.match(/^[A-Z]+/)?.[0];
    if (prefix) out.push(`refdes:${prefix}`);
    out.push(`refshape:${shapeOf(key)}`);
  } else {
    out.push('refdes:none');
  }

  if (comp.value) {
    const key = normalizeKey(comp.value);
    out.push(`val:${key}`);
    out.push(`valshape:${shapeOf(key)}`);
    if (key.length >= 2) out.push(`valhead:${key.slice(0, 2)}`);
    const parsed = parseValue(comp.value);
    // A printed "4.7k" is a resistance and "100u" a capacitance; the unit the
    // value parses as says more about the part than the number does.
    if (parsed) out.push(`unit:${parsed.unit}`);
  } else {
    out.push('val:none');
  }

  // Shape and size. Symbols are drawn to a house style, so the proportions of
  // an unnamed blob are more informative than they have any right to be.
  const { w, h } = comp.bbox;
  const longSide = Math.max(w, h);
  const shortSide = Math.max(1, Math.min(w, h));
  out.push(`aspect:${bucket(longSide / shortSide, [1.3, 2, 3.5, 6])}`);
  out.push(`size:${bucket(pageScale ? longSide / pageScale : 0, [0.01, 0.025, 0.05, 0.1])}`);
  out.push(`orient:${w >= h ? 'wide' : 'tall'}`);
  out.push(`pins:${bucket(comp.pins.length, [1, 2, 3, 5, 9])}`);

  // What it sits on: a two-pin part between a rail and ground is a different
  // proposition from one in the middle of a signal path.
  const byNet = new Map(nets.map((n) => [n.id, n]));
  const roles = new Set<string>();
  for (const p of pins.filter((pp) => pp.componentId === comp.id)) {
    const net = p.netId ? byNet.get(p.netId) : undefined;
    if (net && net.role !== 'unknown') roles.add(net.role);
  }
  for (const r of roles) out.push(`onnet:${r}`);
  if (roles.has('power') && roles.has('ground')) out.push('across:rail');

  const near = segments.filter((s) => {
    const d = textToNetDistance(comp.bbox, [s]);
    return d <= pageScale * 0.02;
  });
  out.push(...captionFeatures(texts, near, pageScale));
  return [...new Set(out)];
}

/**
 * Japanese captions sitting on the thing, by their lexicon reading.
 *
 * Reading rather than raw OCR, so the same phrase misread two ways still
 * matches the third time it appears.
 */
function captionFeatures(texts: TextItem[], segs: WireSegment[], pageScale: number): string[] {
  if (!segs.length) return [];
  const out: string[] = [];
  const snap = pageScale * 0.02;
  for (const t of texts) {
    if (t.script === 'latin') continue;
    if (textToNetDistance(t.bbox, segs) > snap) continue;
    for (const entry of hintsFor(t.text).entries) out.push(`jp:${entry.romaji}`);
  }
  return out;
}

/** A sheet-local context for one entity, for a correction made in the UI. */
export function contextForPage(
  page: number,
  doc: {
    nets: Net[];
    texts: TextItem[];
    components: Component[];
    pins: Pin[];
    segments: WireSegment[];
    pages: Array<{ index: number; width: number; height: number }>;
  },
): ClassifyContext {
  const sheet = doc.pages.find((p) => p.index === page) ?? doc.pages[0];
  const on = <T extends { page: number }>(xs: T[]) => xs.filter((x) => x.page === page);
  return {
    nets: on(doc.nets),
    texts: on(doc.texts),
    components: on(doc.components),
    pins: on(doc.pins),
    segments: on(doc.segments),
    pageScale: sheet ? Math.hypot(sheet.width, sheet.height) : 1,
  };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/** Weight added to the class the user chose. */
const REWARD = 1;
/** Weight taken back from the class they rejected -- what makes this discriminate. */
const PENALTY = 0.6;

/**
 * Fold one correction into a class model.
 *
 * Both halves matter. Rewarding the chosen class teaches what the evidence
 * means; penalising the rejected one teaches that the rule which produced it
 * was wrong *on this kind of thing*, which is what is worth carrying to the
 * next schematic. Counts never go negative -- a single mistaken correction
 * should not be able to drive a class below the floor and become unreachable.
 */
function record<C extends string>(
  model: ClassModel<C>,
  args: { key?: string; from: C; to: C; unknown: C; features: string[]; docName: string; voltage?: number },
): ClassModel<C> {
  const { key, from, to, unknown, features, docName, voltage } = args;

  const counts: ClassModel<C>['counts'] = { ...model.counts };
  const totals: ClassModel<C>['totals'] = { ...model.totals };

  const forClass = (c: C) => {
    counts[c] = { ...(counts[c] ?? {}) };
    return counts[c]!;
  };
  const good = forClass(to);
  const bad = from === unknown ? null : forClass(from);

  for (const f of features) {
    good[f] = (good[f] ?? 0) + REWARD;
    totals[to] = (totals[to] ?? 0) + REWARD;
    if (bad) {
      const next = Math.max(0, (bad[f] ?? 0) - PENALTY);
      totals[from] = Math.max(0, (totals[from] ?? 0) - ((bad[f] ?? 0) - next));
      bad[f] = next;
    }
  }

  const keys = { ...model.keys };
  const normalized = key ? normalizeKey(key) : '';
  if (normalized) {
    const prior = keys[normalized] ?? { classes: {}, updatedAt: 0 };
    const classes = { ...prior.classes };
    classes[to] = (classes[to] ?? 0) + 1;
    if (from !== unknown && classes[from]) classes[from] = Math.max(0, (classes[from] ?? 0) - 1);
    keys[normalized] = { classes, voltage: voltage ?? prior.voltage, updatedAt: Date.now() };
  }

  return {
    counts,
    totals,
    keys,
    history: [{ at: Date.now(), docName, key: key || undefined, from, to }, ...model.history].slice(
      0,
      HISTORY_LIMIT,
    ),
    corrections: model.corrections + 1,
  };
}

export function recordNetCorrection(
  model: LearnedModel,
  args: { net: Net; from: NetRole; to: NetRole; features: string[]; docName: string; voltage?: number },
): LearnedModel {
  if (args.from === args.to) return model;
  return {
    ...model,
    nets: record(model.nets, {
      key: args.net.label,
      from: args.from,
      to: args.to,
      unknown: 'unknown',
      features: args.features,
      docName: args.docName,
      voltage: args.voltage,
    }),
    updatedAt: Date.now(),
  };
}

export function recordComponentCorrection(
  model: LearnedModel,
  args: {
    component: Component;
    from: ComponentKind;
    to: ComponentKind;
    features: string[];
    docName: string;
  },
): LearnedModel {
  if (args.from === args.to) return model;
  return {
    ...model,
    components: record(model.components, {
      // The part number is the thing worth remembering by name. A refdes is
      // per-drawing -- "R7" on someone else's schematic means nothing.
      key: args.component.value,
      from: args.from,
      to: args.to,
      unknown: 'unknown',
      features: args.features,
      docName: args.docName,
    }),
    updatedAt: Date.now(),
  };
}

/** Forget one remembered net label, leaving everything else intact. */
export function forgetNetLabel(model: LearnedModel, label: string): LearnedModel {
  return { ...model, nets: forgetKey(model.nets, label), updatedAt: Date.now() };
}

/** Forget one remembered part number. */
export function forgetPart(model: LearnedModel, value: string): LearnedModel {
  return { ...model, components: forgetKey(model.components, value), updatedAt: Date.now() };
}

function forgetKey<C extends string>(model: ClassModel<C>, raw: string): ClassModel<C> {
  const key = normalizeKey(raw);
  if (!(key in model.keys)) return model;
  const keys = { ...model.keys };
  delete keys[key];
  return { ...model, keys };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export interface Prediction<C extends string> {
  cls: C;
  /** Log-odds over the runner-up. Bigger is more certain. */
  margin: number;
  /** Features that actually carried evidence, the substantive ones first. */
  evidence: Array<{ feature: string; weight: number }>;
  /** Weight behind the strongest *substantive* feature -- see `isContext`. */
  support: number;
  /**
   * Whether the model knows of more than one class here.
   *
   * Until it does, it has nothing to choose *between*: the margin over the
   * runner-up is infinite because there is no runner-up, which says nothing
   * about how sure anyone should be. Early on, everything it offers is a low
   * confidence suggestion, and it says so.
   */
  discriminating: boolean;
}

const ALPHA = 0.4; // Laplace smoothing

/**
 * Features that describe the situation rather than the thing.
 *
 * "The rules gave up on this", "it has no reference designator", "the match was
 * low confidence" are all true of *every* symbol this model is ever allowed to
 * revise, so they are perfectly correlated with being asked the question and
 * tell us nothing about the answer. Left in the support count they would let
 * two corrections justify relabelling every unidentified blob on the sheet, and
 * the explanation would read "parts like this one — first read as unknown —
 * you have classified as Capacitor", which is no explanation at all.
 *
 * They still contribute to the score, where the arithmetic cancels them out
 * across classes. They just cannot be the reason for acting.
 */
function isContext(feature: string): boolean {
  return (
    feature.startsWith('rule:') ||
    feature.startsWith('ruleconf:') ||
    feature === 'lbl:none' ||
    feature === 'val:none' ||
    feature === 'refdes:none'
  );
}

/**
 * Score the classes this evidence has been associated with.
 *
 * Only features the model has seen before contribute. Scoring the unseen ones
 * too is textbook naive Bayes and wrong here: every entity carries a dozen
 * features, most of them novel, and their smoothing terms would swamp the two
 * or three features that actually mean something.
 */
export function predict<C extends string>(
  model: ClassModel<C>,
  features: string[],
): Prediction<C> | null {
  const classes = Object.keys(model.counts) as C[];
  if (!classes.length) return null;

  const known = features.filter((f) => classes.some((c) => (model.counts[c]?.[f] ?? 0) > 0));
  if (!known.length) return null;

  const grandTotal = classes.reduce((t, c) => t + (model.totals[c] ?? 0), 0) || 1;
  const scored = classes.map((cls) => {
    const counts = model.counts[cls] ?? {};
    const total = model.totals[cls] ?? 0;
    let score = Math.log((total + ALPHA) / grandTotal);
    for (const f of known) {
      score += Math.log(((counts[f] ?? 0) + ALPHA) / (total + ALPHA * known.length));
    }
    return { cls, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];

  const counts = model.counts[best.cls] ?? {};
  const evidence = known
    .map((feature) => ({ feature, weight: counts[feature] ?? 0 }))
    .filter((e) => e.weight > 0)
    // Substantive features first, so the rationale leads with something the
    // user can check against the drawing.
    .sort((a, b) => Number(isContext(a.feature)) - Number(isContext(b.feature)) || b.weight - a.weight);
  if (!evidence.length) return null;

  const substantive = evidence.filter((e) => !isContext(e.feature));

  return {
    cls: best.cls,
    margin: runnerUp ? best.score - runnerUp.score : Infinity,
    evidence,
    support: substantive.length ? Math.max(...substantive.map((e) => e.weight)) : 0,
    discriminating: classes.length > 1,
  };
}

/** What the exact-key memory says about a label or part number, if it is sure. */
export function recall<C extends string>(
  model: ClassModel<C>,
  raw: string | undefined,
): { cls: C; count: number; voltage?: number } | null {
  if (!raw) return null;
  const memory = model.keys[normalizeKey(raw)];
  if (!memory) return null;

  const ranked = (Object.entries(memory.classes) as Array<[C, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;

  const [cls, count] = ranked[0];
  // A key the user has called two different things is not a fact about the
  // key; leave it to the rules rather than guess which time they meant it.
  if (ranked.length > 1 && ranked[1][1] >= count) return null;
  return { cls, count, voltage: memory.voltage };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/** Evidence needed before the model may revise a rule's conclusion. */
const MIN_SUPPORT = 2;
/** Log-odds the winner must beat the runner-up by. */
const MIN_MARGIN = 0.8;
/** Repeats of an identical key before it may overrule even a confident rule. */
const KEY_OVERRIDE = 2;

export interface LearningOutcome {
  /** Entities whose class this changed. */
  changed: number;
  /** Entities it named that the rules had left unknown. */
  filled: number;
}

export const emptyOutcome = (): LearningOutcome => ({ changed: 0, filled: 0 });

/**
 * Revise the rules' net roles with what has been learned.
 *
 * Called after `classifyNets`, never instead of it. The gates below are the
 * whole safety story, so they are stated plainly rather than tuned:
 *
 *   - a role the user set on this net is never touched;
 *   - an exact label the user has ruled on twice may overrule anything else,
 *     because that is a standing correction, not a guess;
 *   - otherwise the model may only revise what the rules were unsure of, and
 *     only when its own margin and support clear the thresholds.
 */
export function applyLearnedRoles(ctx: ClassifyContext, model: LearnedModel): LearningOutcome {
  const outcome = emptyOutcome();
  if (!model.nets.corrections) return outcome;

  for (const net of ctx.nets) {
    if (net.roleSource === 'user') continue;

    const wasUnknown = net.role === 'unknown';
    const soft = wasUnknown || net.roleConfidence !== 'high';

    const recalled = recall(model.nets, net.label);
    if (recalled && recalled.cls !== net.role && (soft || recalled.count >= KEY_OVERRIDE)) {
      net.rationale.push(
        learnedFromKey(`a net labelled "${net.label}"`, ROLE_LABELS[recalled.cls], recalled.count, soft),
      );
      net.role = recalled.cls;
      net.roleConfidence = recalled.count >= KEY_OVERRIDE ? 'high' : 'medium';
      net.roleSource = 'learned';
      if (recalled.voltage !== undefined && net.voltage === undefined) net.voltage = recalled.voltage;
      tally(outcome, wasUnknown);
      continue;
    }

    if (!soft) continue;
    const prediction = predict(model.nets, netFeatures(net, ctx));
    if (!prediction || prediction.cls === net.role) continue;
    if (prediction.support < MIN_SUPPORT || prediction.margin < MIN_MARGIN) continue;

    net.rationale.push(
      learnedFromPattern(
        'nets',
        prediction,
        ROLE_LABELS[prediction.cls],
        wasUnknown ? undefined : ROLE_LABELS[net.role],
      ),
    );
    net.role = prediction.cls;
    net.roleConfidence = confidenceOf(prediction);
    net.roleSource = 'learned';
    tally(outcome, wasUnknown);
  }

  return outcome;
}

/**
 * Revise the detector's component kinds with what has been learned.
 *
 * Runs *before* `classifyNets`, unlike its net counterpart, because net
 * classification reads component kinds: a symbol the user has taught us is a
 * regulator defines the rail on its output pin, and a crystal defines a clock.
 * Learning the part therefore improves the wiring, not just the parts list.
 */
export function applyLearnedKinds(ctx: ClassifyContext, model: LearnedModel): LearningOutcome {
  const outcome = emptyOutcome();
  if (!model.components.corrections) return outcome;

  for (const comp of ctx.components) {
    if (comp.kindSource === 'user') continue;

    const wasUnknown = comp.kind === 'unknown';
    const soft = wasUnknown || comp.kindConfidence !== 'high';

    const recalled = recall(model.components, comp.value);
    if (recalled && recalled.cls !== comp.kind && (soft || recalled.count >= KEY_OVERRIDE)) {
      comp.rationale.push(
        learnedFromKey(`part "${comp.value}"`, COMPONENT_LABELS[recalled.cls], recalled.count, soft),
      );
      comp.kind = recalled.cls;
      comp.kindConfidence = recalled.count >= KEY_OVERRIDE ? 'high' : 'medium';
      comp.kindSource = 'learned';
      tally(outcome, wasUnknown);
      continue;
    }

    if (!soft) continue;
    const prediction = predict(model.components, componentFeatures(comp, ctx));
    if (!prediction || prediction.cls === comp.kind) continue;
    if (prediction.support < MIN_SUPPORT || prediction.margin < MIN_MARGIN) continue;

    comp.rationale.push(
      learnedFromPattern(
        'parts',
        prediction,
        COMPONENT_LABELS[prediction.cls],
        wasUnknown ? undefined : COMPONENT_LABELS[comp.kind],
      ),
    );
    comp.kind = prediction.cls;
    comp.kindConfidence = confidenceOf(prediction);
    comp.kindSource = 'learned';
    tally(outcome, wasUnknown);
  }

  return outcome;
}

/** Never better than a suggestion, and only that once it has a choice to make. */
function confidenceOf<C extends string>(prediction: Prediction<C>): Confidence {
  return prediction.discriminating && prediction.margin > MIN_MARGIN * 2 ? 'medium' : 'low';
}

function tally(outcome: LearningOutcome, wasUnknown: boolean): void {
  if (wasUnknown) outcome.filled++;
  else outcome.changed++;
}

function learnedFromKey(subject: string, className: string, count: number, soft: boolean): string {
  const times = count === 1 ? 'once' : `${count} times`;
  return (
    `Learned from your corrections: you have classified ${subject} as ${className} ${times}` +
    (soft ? '.' : ', so that stands over the rule that would otherwise apply here.')
  );
}

function learnedFromPattern<C extends string>(
  noun: string,
  prediction: Prediction<C>,
  className: string,
  ruleSaid: string | undefined,
): string {
  // Only the substantive features are quoted. The rest are true but vacuous,
  // and a reason the user cannot check against the drawing is not a reason.
  const cited = prediction.evidence.filter((e) => !isContext(e.feature)).slice(0, 3);
  return (
    `Learned from your corrections: ${noun} like this one — ${cited
      .map((e) => describeFeature(e.feature))
      .join(', ')} — you have classified as ${className}.` +
    (ruleSaid ? ` The rules had guessed ${ruleSaid}.` : '')
  );
}

/** Turn an internal feature key into something worth showing a person. */
export function describeFeature(feature: string): string {
  const [kind, ...rest] = feature.split(':');
  const value = rest.join(':');
  const pick = (options: string[], fallback: string) => options[Number(value)] ?? fallback;

  switch (kind) {
    case 'lbl':
      return value === 'none'
        ? 'unlabelled'
        : value === 'hasdigit'
          ? 'a label containing digits'
          : `labelled "${value}"`;
    case 'shape':
      return `a label shaped like "${value}"`;
    case 'head':
      return `a label starting "${value}"`;
    case 'tail':
      return `a label ending "${value}"`;
    case 'refdes':
      return value === 'none' ? 'no reference designator' : `a "${value}" reference designator`;
    case 'refshape':
      return `a designator shaped like "${value}"`;
    case 'val':
      return value === 'none' ? 'no printed value' : `marked "${value}"`;
    case 'valshape':
      return `a value shaped like "${value}"`;
    case 'valhead':
      return `a value starting "${value}"`;
    case 'unit':
      return `a value in ${value}`;
    case 'aspect':
      return pick(
        ['a square outline', 'a slightly oblong outline', 'an oblong outline', 'a long thin outline', 'a very long thin outline'],
        'an outline',
      );
    case 'size':
      return pick(['a tiny symbol', 'a small symbol', 'a medium symbol', 'a large symbol', 'a very large symbol'], 'a symbol');
    case 'orient':
      return `drawn ${value === 'wide' ? 'wider than tall' : 'taller than wide'}`;
    case 'onnet':
      return `sitting on a ${value} net`;
    case 'across':
      return 'bridging a supply and ground';
    case 'nbr':
      return `connected to a ${value}`;
    case 'pinname':
      return `on a pin named ${value}`;
    case 'jp':
      return `annotated "${value}"`;
    case 'rule':
      return `first read as ${value.split(':')[1] ?? value}`;
    case 'ruleconf':
      return `${value}-confidence rule match`;
    case 'len':
      return pick(
        ['a very short run', 'a short run', 'a medium run', 'a long run', 'a very long run', 'a sheet-wide run'],
        'a run of some length',
      );
    case 'pins':
      return `${pick(['no', 'one', 'two', 'a few', 'several', 'many', 'many'], 'some')} connections`;
    case 'weight':
      return pick(
        ['a hairline trace', 'a thin trace', 'a medium trace', 'a heavy trace', 'a very heavy trace'],
        'a trace',
      );
    case 'vert':
      return pick(['mostly horizontal', 'mixed orientation', 'mostly vertical'], 'some orientation');
    default:
      return feature;
  }
}
