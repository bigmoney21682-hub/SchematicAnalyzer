/**
 * The interpretation engine.
 *
 * Every conclusion here is produced by an explicit, inspectable rule and
 * carries its reasoning in `rationale`. That matters more than raw accuracy:
 * the user is going to confirm or correct these calls, and they can only do
 * that if they can see *why* the tool decided something.
 *
 * Evidence is ranked. An explicit net label beats a Japanese caption, which
 * beats a part-database inference, which beats pure topology.
 */

import type {
  Component,
  Confidence,
  FunctionalBlock,
  Net,
  Pin,
  Point,
  Rect,
  TextItem,
  NetRole,
  WireSegment,
} from '../model/types';
import { hintsFor } from '../jp/lexicon';
import { lookupPart } from './parts';

// ---------------------------------------------------------------------------
// Net labels -> roles
// ---------------------------------------------------------------------------

interface LabelRule {
  re: RegExp;
  role: NetRole;
  confidence: Confidence;
  voltage?: (m: RegExpMatchArray) => number | undefined;
  why: string;
}

const LABEL_RULES: LabelRule[] = [
  {
    re: /^(?:GND|AGND|DGND|PGND|SGND|VSS|EARTH|E|COM|0V)$/i,
    role: 'ground',
    confidence: 'high',
    why: 'Label is a standard ground identifier.',
  },
  {
    re: /^([+-]?)(\d{1,3}(?:[.,]\d)?)\s*V$/i,
    role: 'power',
    confidence: 'high',
    voltage: (m) => Number(`${m[1] === '-' ? '-' : ''}${m[2].replace(',', '.')}`),
    why: 'Label states an explicit supply voltage.',
  },
  {
    re: /^B\+$/i,
    role: 'power',
    confidence: 'high',
    why: 'B+ is the main HT/supply rail in Japanese audio and CRT service manuals.',
  },
  {
    re: /^(?:VCC|VDD|AVCC|AVDD|VBAT|VIN|VOUT|V\+|VS)$/i,
    role: 'power',
    confidence: 'high',
    why: 'Label is a standard positive supply identifier.',
  },
  {
    re: /^(?:VEE|V-)$/i,
    role: 'power',
    confidence: 'high',
    why: 'Label is a standard negative supply identifier.',
  },
  { re: /^(?:VREF|REF|AREF)$/i, role: 'reference', confidence: 'high', why: 'Label denotes a voltage reference.' },
  { re: /^(?:SDA|SCL)$/i, role: 'i2c', confidence: 'high', why: 'SDA/SCL are the I²C data and clock lines.' },
  {
    re: /^(?:MOSI|MISO|SCK|SCLK|SS|NSS|CS|CE)$/i,
    role: 'spi',
    confidence: 'high',
    why: 'Label is an SPI bus signal.',
  },
  {
    re: /^(?:TX|RX|TXD|RXD|CTS|RTS|DTR|DSR)$/i,
    role: 'uart',
    confidence: 'high',
    why: 'Label is a UART/serial line.',
  },
  {
    re: /^(?:RST|RESET|NRST|_RST|\/RST|MCLR|POR)$/i,
    role: 'reset',
    confidence: 'high',
    why: 'Label identifies a reset line.',
  },
  {
    re: /^(?:CLK|CLOCK|XTAL|XIN|XOUT|OSC|X1|X2)$/i,
    role: 'clock',
    confidence: 'high',
    why: 'Label identifies a clock or crystal node.',
  },
  { re: /^(?:D\+|D-|CANH|CANL)$/i, role: 'signal', confidence: 'high', why: 'Label is a differential bus pair.' },
];

function roleFromLabel(label: string): { role: NetRole; confidence: Confidence; voltage?: number; why: string } | undefined {
  const clean = label.trim().replace(/\s+/g, '');
  for (const rule of LABEL_RULES) {
    const m = clean.match(rule.re);
    if (m) {
      return { role: rule.role, confidence: rule.confidence, voltage: rule.voltage?.(m), why: rule.why };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function rectCentre(r: Rect) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

function rectUnion(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Distance from a text box to the nearest actual conductor of a net.
 *
 * Using the net's bounding box instead is a trap: a rail that runs the width
 * of the sheet has a bbox containing nearly every label on the page, so it
 * hoovers up whichever one it is compared against first.
 */
export function textToNetDistance(box: Rect, segs: WireSegment[]): number {
  const corners: Point[] = [
    { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ];
  let best = Infinity;
  for (const s of segs) {
    for (const c of corners) {
      const d = pointToSegment(c, s.a, s.b);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Net classification
// ---------------------------------------------------------------------------

export interface ClassifyContext {
  nets: Net[];
  texts: TextItem[];
  components: Component[];
  pins: Pin[];
  segments: WireSegment[];
  /** Page diagonal, used to scale "nearby" distances. */
  pageScale: number;
}

export function classifyNets(ctx: ClassifyContext): void {
  const { nets, texts, components, pins, segments, pageScale } = ctx;
  const snap = pageScale * 0.02;

  const segsByNet = new Map<string, WireSegment[]>();
  for (const s of segments) {
    if (!s.netId) continue;
    const list = segsByNet.get(s.netId);
    if (list) list.push(s);
    else segsByNet.set(s.netId, [s]);
  }

  const byComponent = new Map(components.map((c) => [c.id, c]));
  const pinsByNet = new Map<string, Pin[]>();
  for (const p of pins) {
    if (!p.netId) continue;
    const list = pinsByNet.get(p.netId);
    if (list) list.push(p);
    else pinsByNet.set(p.netId, [p]);
  }

  for (const net of nets) {
    net.pinIds = (pinsByNet.get(net.id) ?? []).map((p) => p.id);
  }

  // --- 1. Bind each net label to exactly one net --------------------------
  // Driven from the labels, not the nets: a printed "GND" marks one specific
  // node. Letting every net independently claim its nearest label produced
  // half a dozen unrelated "GND" nets, most of them stubs.
  const labels = texts.filter((t) => t.kind === 'netlabel');
  const tieBand = snap * 0.5;
  for (const label of labels) {
    const candidates: Array<{ net: Net; d: number }> = [];
    for (const net of nets) {
      if (net.label) continue; // already claimed by an earlier label
      const d = textToNetDistance(label.bbox, segsByNet.get(net.id) ?? []);
      if (d <= snap) candidates.push({ net, d });
    }
    if (!candidates.length) continue;

    // Nearest wins, but ties go to the more substantial net. A "GND" caption
    // often sits a hair closer to some 20px stub than to the rail it actually
    // names, and picking the stub loses the label for the whole rail.
    const nearest = Math.min(...candidates.map((c) => c.d));
    const best = candidates
      .filter((c) => c.d <= nearest + tieBand)
      .sort((a, b) => b.net.length - a.net.length)[0].net;

    best.label = label.text.trim();
    best.labelSource = 'ocr';
    const hit = roleFromLabel(best.label);
    if (hit) {
      best.role = hit.role;
      best.roleConfidence = label.confidence > 70 ? hit.confidence : 'medium';
      best.roleSource = 'ocr';
      best.voltage = hit.voltage;
      best.rationale.push(`Labelled "${best.label}". ${hit.why}`);
      if (label.confidence <= 70) {
        best.rationale.push(`OCR confidence for this label was only ${Math.round(label.confidence)}%.`);
      }
    }
  }

  // --- 2. Japanese captions sitting on a net ------------------------------
  const captions = texts.filter((t) => t.kind === 'annotation' && t.script !== 'latin');
  const minCaptionNet = pageScale * 0.03;
  const maxCaptionNet = pageScale * 0.8;
  for (const net of nets) {
    if (net.roleSource === 'ocr' && net.role !== 'unknown') continue;
    // A caption describes a circuit area, not a 20px stub. Requiring some
    // extent stops title-block text from labelling every fragment near it.
    if (net.length < minCaptionNet) continue;
    // The opposite failure: a rail crossing the whole sheet passes under many
    // unrelated captions, and would take the role of whichever it met first.
    // Rails must be identified by their own label, not by passing scenery.
    if (net.length > maxCaptionNet) continue;
    for (const cap of captions) {
      if (textToNetDistance(cap.bbox, segsByNet.get(net.id) ?? []) > snap) continue;
      const hints = hintsFor(cap.text);
      if (!hints.netRoles.length) continue;
      net.role = hints.netRoles[0];
      net.roleConfidence = 'medium';
      net.roleSource = 'ocr';
      net.rationale.push(
        `Japanese annotation "${cap.text}" (${hints.entries.map((e) => e.romaji).join(', ')}) means "${
          cap.translation ?? hints.entries.map((e) => e.en).join(' ')
        }".`,
      );
      break;
    }
  }

  // --- 3. Ground symbols name their net outright ---------------------------
  // The strongest topological evidence on any sheet, and until ground symbols
  // were recognised at all the app had no access to it -- it fell through to
  // the "longest net is probably the return" guess in step 5, which is a coin
  // toss dressed up as an answer. A conductor that ends on an earth symbol is
  // ground, full stop, and it does not matter how short it is.
  const labelBeatsSymbol = new Set(['user', 'ocr']);
  // A symbol is several strokes and so lands several pins on the same node.
  // Without this the same sentence is added to a net's reasoning once per
  // stroke, and the inspector shows "Terminates on a ground symbol" four times.
  const groundedBy = new Set<string>();
  for (const comp of components) {
    if (comp.kind !== 'ground') continue;
    for (const pin of pins.filter((p) => p.componentId === comp.id)) {
      const net = pin.netId ? nets.find((n) => n.id === pin.netId) : undefined;
      if (!net) continue;
      const key = `${comp.id}/${net.id}`;
      if (groundedBy.has(key)) continue;
      groundedBy.add(key);
      // An explicit printed label still wins: a net marked "AGND" is better
      // described by its own name than by the symbol it happens to reach.
      if (net.roleSource && labelBeatsSymbol.has(net.roleSource) && net.role !== 'unknown') continue;
      net.role = 'ground';
      net.roleConfidence = comp.kindSource === 'user' ? 'high' : comp.kindConfidence;
      net.roleSource = comp.kindSource === 'user' ? 'user' : 'topology';
      net.rationale.push(
        `Terminates on a ground symbol${comp.refdes ? ` (${comp.refdes})` : ''}. ` +
          (comp.kindSource === 'user'
            ? 'You identified that symbol as a ground.'
            : 'The symbol was read from its shape.'),
      );
    }
  }

  // --- 4. Regulator outputs define rails ----------------------------------
  for (const comp of components) {
    if (comp.kind !== 'regulator' || !comp.value) continue;
    const info = lookupPart(comp.value);
    if (!info) continue;

    const compPins = pins.filter((p) => p.componentId === comp.id);
    for (const pin of compPins) {
      if (!pin.netId) continue;
      const net = nets.find((n) => n.id === pin.netId);
      if (!net || net.roleSource === 'ocr') continue;
      const isOut = pin.name === 'OUT';
      if (isOut || (!pin.name && compPins.length <= 3)) {
        net.role = 'power';
        net.roleConfidence = isOut ? 'high' : 'low';
        net.roleSource = 'partdb';
        if (info.outputVoltage !== undefined) net.voltage = info.outputVoltage;
        net.rationale.push(
          `Connected to ${comp.refdes ?? comp.value} (${info.description})${
            isOut ? ' on its output pin' : ''
          }.`,
        );
      }
    }
  }

  // --- 5. Crystals define clock nets --------------------------------------
  for (const comp of components) {
    if (comp.kind !== 'crystal') continue;
    for (const pin of pins.filter((p) => p.componentId === comp.id)) {
      const net = pin.netId ? nets.find((n) => n.id === pin.netId) : undefined;
      if (!net || net.roleSource === 'ocr') continue;
      net.role = 'clock';
      net.roleConfidence = 'medium';
      net.roleSource = 'partdb';
      net.rationale.push(`Terminates on crystal/resonator ${comp.refdes ?? comp.id}.`);
    }
  }

  // --- 6. Topology fallback for the big unlabelled rails -------------------
  // The two most-connected long nets in a schematic are almost always the
  // supply and the return. We say so, but at low confidence and clearly
  // marked as a guess, because "almost always" is not "always".
  const unknown = nets.filter((n) => n.role === 'unknown');
  const ranked = [...unknown].sort(
    (a, b) => b.length * (b.pinIds.length + 1) - a.length * (a.pinIds.length + 1),
  );
  const medianLength = median(nets.map((n) => n.length));

  for (const net of ranked.slice(0, 2)) {
    if (net.length < medianLength * 4) break;
    const alreadyGround = nets.some((n) => n.role === 'ground');
    net.role = alreadyGround ? 'power' : 'ground';
    net.roleConfidence = 'low';
    net.roleSource = 'heuristic';
    net.rationale.push(
      `Guessed from topology: this is one of the longest, most-connected nets on the page (${Math.round(
        net.length,
      )}px across ${net.pinIds.length} connections), which usually indicates a supply or return rail. Please confirm.`,
    );
  }

  // --- 7. Remaining nets touching a known IC are signals -------------------
  for (const net of nets) {
    if (net.role !== 'unknown') continue;
    const touchesIc = (pinsByNet.get(net.id) ?? []).some((p) => {
      const c = byComponent.get(p.componentId);
      return c?.kind === 'ic';
    });
    if (touchesIc) {
      net.role = 'signal';
      net.roleConfidence = 'low';
      net.roleSource = 'topology';
      net.rationale.push('Connects to an integrated circuit but carries no supply label.');
    }
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------
// Functional blocks
// ---------------------------------------------------------------------------

export function detectBlocks(ctx: ClassifyContext): FunctionalBlock[] {
  const { nets, components, pins, texts, pageScale } = ctx;
  const blocks: FunctionalBlock[] = [];
  const near = pageScale * 0.06;
  let n = 0;

  const netsFor = (comps: Component[]) => {
    const ids = new Set(comps.map((c) => c.id));
    return [...new Set(pins.filter((p) => ids.has(p.componentId) && p.netId).map((p) => p.netId!))];
  };

  const push = (
    kind: FunctionalBlock['kind'],
    title: string,
    comps: Component[],
    confidence: Confidence,
    rationale: string[],
  ) => {
    if (!comps.length) return;
    blocks.push({
      id: `blk${n++}`,
      page: comps[0].page,
      kind,
      title,
      bbox: pad(rectUnion(comps.map((c) => c.bbox)), pageScale * 0.012),
      componentIds: comps.map((c) => c.id),
      netIds: netsFor(comps),
      confidence,
      rationale,
    });
  };

  // --- Regulation: a regulator plus its immediate decoupling ---------------
  for (const reg of components.filter((c) => c.kind === 'regulator')) {
    const info = reg.value ? lookupPart(reg.value) : undefined;
    const cluster = [reg, ...components.filter((c) => c !== reg && c.kind === 'capacitor' && rectDistance(reg.bbox, c.bbox) < near)];
    push(
      'regulation',
      info?.outputVoltage !== undefined
        ? `${info.outputVoltage > 0 ? '+' : ''}${info.outputVoltage}V regulator`
        : 'Voltage regulation',
      cluster,
      'high',
      [
        `${reg.refdes ?? reg.value ?? 'Regulator'} identified as ${info?.description ?? 'a voltage regulator'}.`,
        cluster.length > 1
          ? `${cluster.length - 1} nearby capacitor(s) grouped as its input/output decoupling.`
          : 'No decoupling capacitors detected nearby -- check the trace.',
      ],
    );
  }

  // --- Power supply: rectifier diodes and reservoir caps -------------------
  const diodes = components.filter((c) => c.kind === 'diode');
  const transformers = components.filter((c) => c.kind === 'transformer');
  if (diodes.length >= 2 || transformers.length) {
    const seed = transformers[0]?.bbox ?? diodes[0].bbox;
    const cluster = [...transformers, ...diodes, ...components.filter((c) => c.kind === 'capacitor')].filter(
      (c) => rectDistance(seed, c.bbox) < near * 2,
    );
    if (cluster.length >= 2) {
      push('power-supply', 'Power input / rectification', cluster, diodes.length >= 4 ? 'high' : 'medium', [
        transformers.length ? `Transformer ${transformers[0].refdes ?? ''} present.` : 'No transformer detected.',
        `${cluster.filter((c) => c.kind === 'diode').length} diode(s) clustered together${
          diodes.length >= 4 ? ' -- consistent with a bridge rectifier' : ''
        }.`,
      ]);
    }
  }

  // --- Clock: crystal plus its load capacitors ----------------------------
  for (const xtal of components.filter((c) => c.kind === 'crystal')) {
    const loads = components.filter((c) => c.kind === 'capacitor' && rectDistance(xtal.bbox, c.bbox) < near);
    push('clock', 'Clock / oscillator', [xtal, ...loads], loads.length >= 2 ? 'high' : 'medium', [
      `${xtal.refdes ?? 'Crystal'} is a crystal or ceramic resonator.`,
      loads.length >= 2
        ? `Two load capacitors alongside it -- a classic Pierce oscillator arrangement.`
        : `${loads.length} nearby capacitor(s); a crystal usually has two load caps.`,
    ]);
  }

  // --- Reset: anything on a reset net --------------------------------------
  const resetNets = nets.filter((n2) => n2.role === 'reset');
  if (resetNets.length) {
    const ids = new Set(resetNets.map((r) => r.id));
    const comps = components.filter((c) =>
      pins.some((p) => p.componentId === c.id && p.netId && ids.has(p.netId)),
    );
    push('reset', 'Reset circuit', comps, 'medium', [
      `Built around ${resetNets.length} net(s) classified as reset.`,
      comps.some((c) => c.kind === 'capacitor') && comps.some((c) => c.kind === 'resistor')
        ? 'Contains an R and a C -- likely a power-on-reset time constant.'
        : 'No obvious RC time constant found on this net.',
    ]);
  }

  // --- Comms: any bus net and what it touches ------------------------------
  const busRoles: NetRole[] = ['i2c', 'spi', 'uart'];
  for (const role of busRoles) {
    const busNets = nets.filter((x) => x.role === role);
    if (!busNets.length) continue;
    const ids = new Set(busNets.map((b) => b.id));
    const comps = components.filter((c) =>
      pins.some((p) => p.componentId === c.id && p.netId && ids.has(p.netId)),
    );
    push('comms', `${role.toUpperCase()} bus`, comps, 'medium', [
      `${busNets.length} net(s) labelled as ${role.toUpperCase()}: ${busNets
        .map((b) => b.label)
        .filter(Boolean)
        .join(', ')}.`,
      role === 'i2c'
        ? 'Check for pull-up resistors to the positive rail -- I²C requires them.'
        : 'Signals grouped from their net labels.',
    ]);
  }

  // --- Protection: fuses, varistors, and zeners referenced to ground -------
  const protectors = components.filter(
    (c) => c.kind === 'fuse' || c.kind === 'varistor' || c.kind === 'zener',
  );
  if (protectors.length) {
    push('protection', 'Protection', protectors, 'medium', [
      protectors
        .map((p) => `${p.refdes ?? p.kind} (${p.kind})`)
        .join(', ') + ' act to clamp or interrupt fault conditions.',
    ]);
  }

  // --- MCU: the IC with the most pins --------------------------------------
  const ics = components.filter((c) => c.kind === 'ic');
  if (ics.length) {
    const biggest = ics.reduce((a, b) => (b.pins.length > a.pins.length ? b : a));
    if (biggest.pins.length >= 6) {
      push('mcu', `Processor / large IC (${biggest.refdes ?? biggest.value ?? '?'})`, [biggest], 'low', [
        `Has ${biggest.pins.length} detected connections, the most of any IC on the page.`,
        biggest.description ?? 'Part number not in the database -- kind inferred from pin count.',
      ]);
    }
  }

  // --- Blocks named outright by a Japanese caption -------------------------
  for (const t of texts) {
    if (t.script === 'latin') continue;
    const hints = hintsFor(t.text);
    if (!hints.blockKinds.length) continue;
    const zone = pad(t.bbox, pageScale * 0.05);
    const comps = components.filter((c) => rectDistance(zone, c.bbox) < 1);
    if (!comps.length) continue;
    push(
      hints.blockKinds[0],
      `${hints.entries[0].en} (${t.text})`,
      comps,
      'high',
      [
        `The drawing labels this area "${t.text}" (${hints.entries.map((e) => e.romaji).join(' ')}) -- "${
          t.translation ?? hints.entries.map((e) => e.en).join(' ')
        }".`,
        'Named directly by the schematic, so this is the draughtsman\'s own grouping.',
      ],
    );
  }

  return dedupeBlocks(blocks);
}

/**
 * Merge blocks of the same kind covering the same parts.
 *
 * Japanese captions stack synonyms around one circuit -- 水晶発振子, 水晶 and
 * 発振 may all sit beside a single crystal -- and each would otherwise raise
 * its own identical "clock" block. Keep the best-evidenced one and fold the
 * others' reasoning into it.
 */
function dedupeBlocks(blocks: FunctionalBlock[]): FunctionalBlock[] {
  const kept: FunctionalBlock[] = [];

  for (const b of blocks) {
    const twin = kept.find((k) => {
      if (k.kind !== b.kind) return false;
      const shared = b.componentIds.filter((id) => k.componentIds.includes(id)).length;
      const smaller = Math.min(b.componentIds.length, k.componentIds.length);
      return smaller > 0 && shared / smaller >= 0.6;
    });

    if (!twin) {
      kept.push({ ...b });
      continue;
    }

    // Prefer the title backed by the most specific caption (the longest one).
    if (b.title.length > twin.title.length) twin.title = b.title;
    twin.componentIds = [...new Set([...twin.componentIds, ...b.componentIds])];
    twin.netIds = [...new Set([...twin.netIds, ...b.netIds])];
    twin.bbox = rectUnion([twin.bbox, b.bbox]);
    for (const r of b.rationale) {
      if (!twin.rationale.includes(r)) twin.rationale.push(r);
    }
  }

  return kept;
}

function pad(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

// ---------------------------------------------------------------------------
// Test points
// ---------------------------------------------------------------------------

export function detectTestPoints(ctx: ClassifyContext): Array<{ at: { x: number; y: number }; text: string }> {
  const { components, texts, nets, pageScale } = ctx;
  const out: Array<{ at: { x: number; y: number }; text: string }> = [];

  for (const c of components) {
    if (c.kind === 'testpoint') {
      out.push({ at: rectCentre(c.bbox), text: `Test point ${c.refdes ?? ''}`.trim() });
    }
  }

  for (const t of texts) {
    const hints = hintsFor(t.text);
    if (hints.componentKinds.includes('testpoint')) {
      out.push({ at: rectCentre(t.bbox), text: `Test point: ${t.text} (${t.translation ?? 'test point'})` });
    }
  }

  // A rail with a known voltage is worth probing even if unmarked.
  for (const net of nets) {
    if (net.voltage === undefined) continue;
    if (rectCentre(net.bbox).x < 0) continue;
    out.push({
      at: { x: net.bbox.x + net.bbox.w / 2, y: net.bbox.y + Math.min(12, net.bbox.h / 2) },
      text: `Expect ${net.voltage > 0 ? '+' : ''}${net.voltage}V here${net.label ? ` (${net.label})` : ''}`,
    });
  }

  // De-duplicate points that land on top of each other.
  const seen: Array<{ x: number; y: number }> = [];
  return out.filter((p) => {
    if (seen.some((s) => Math.hypot(s.x - p.at.x, s.y - p.at.y) < pageScale * 0.02)) return false;
    seen.push(p.at);
    return true;
  });
}
