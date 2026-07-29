/**
 * Tying the sheets of one document together.
 *
 * A multi-sheet schematic is one circuit drawn in instalments. The draughtsman
 * relies on three conventions to carry connectivity across the page break:
 *
 *   1. A net label repeated on another sheet is the same net. This is the
 *      strongest and by far the most common signal.
 *   2. Ground (and, less reliably, a named supply) is global to the whole
 *      drawing whether or not it is labelled on every sheet.
 *   3. The same connector designator on two sheets is the physical hand-off
 *      between the two sections.
 *
 * None of that is visible to a per-sheet analysis, which is why a page-at-a-
 * time tool can tell you what is on sheet 3 but not what sheet 3 *does*. This
 * module reconstructs those links, and -- the part that actually improves the
 * analysis -- uses them to carry a confident finding on one sheet over to the
 * sheets where the same net was read poorly or not at all.
 *
 * Everything here is conservative: links are only claimed on explicit evidence,
 * carry their reasoning, and a propagated conclusion is always marked
 * `cross-sheet` so the user can see it was inherited rather than read.
 */

import type { Component, Confidence, Net, NetRole, SheetLink } from '../model/types';
import { ROLE_LABELS } from '../model/types';

export interface LinkResult {
  links: SheetLink[];
  /** Problems worth surfacing, e.g. the same refdes on two sheets. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Label canonicalisation
// ---------------------------------------------------------------------------

/**
 * Fold the spellings of one net label onto a single key.
 *
 * "5V", "+5 V" and "+5.0V" are the same rail written three ways, and OCR will
 * happily give you all three across a manual. Voltages are normalised
 * numerically; everything else must match exactly, because AGND and DGND being
 * separate nets is precisely the kind of distinction it would be dangerous to
 * flatten.
 */
export function canonicalLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s.length > 12) return undefined;
  // A bare number or a single character is OCR noise, not a net name.
  if (!/[A-Z+]/.test(s) || s.length < 2) return undefined;

  const v = s.match(/^([+-]?)(\d{1,3})(?:[.,](\d))?V$/);
  if (v) {
    const n = Number(`${v[1] === '-' ? '-' : ''}${v[2]}${v[3] ? `.${v[3]}` : ''}`);
    if (!Number.isFinite(n)) return undefined;
    return `${n > 0 ? '+' : ''}${n}V`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Evidence ranking
// ---------------------------------------------------------------------------

const SOURCE_RANK: Record<string, number> = {
  user: 5,
  ocr: 4,
  partdb: 3,
  topology: 2,
  'cross-sheet': 1,
  heuristic: 1,
  ai: 1,
};

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** How much a net's role call is worth as evidence for the whole group. */
function evidence(n: Net): number {
  if (n.role === 'unknown') return 0;
  return (SOURCE_RANK[n.roleSource] ?? 0) * 10 + CONF_RANK[n.roleConfidence];
}

const weaken = (c: Confidence): Confidence => (c === 'high' ? 'medium' : 'low');

const sheets = (pages: number[]) => [...new Set(pages)].sort((a, b) => a - b);

const sheetList = (pages: number[]) =>
  pages.map((p) => p + 1).join(pages.length > 2 ? ', ' : ' and ');

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/**
 * Find every cross-sheet link, and propagate the best evidence along them.
 *
 * `nets` is mutated: a net whose role was inherited from a better-evidenced
 * twin on another sheet gets the new role, a `cross-sheet` provenance and a
 * rationale line naming the sheet it came from. Call this whenever the nets
 * change -- it is idempotent, and re-running after a user correction is how
 * their edit reaches the other sheets.
 */
export function linkSheets(nets: Net[], components: Component[], pageCount: number): LinkResult {
  const links: SheetLink[] = [];
  const warnings: string[] = [];
  if (pageCount < 2) return { links, warnings };

  let n = 0;
  const grouped = new Set<string>();

  // --- 1. Repeated net labels ---------------------------------------------
  const byLabel = new Map<string, Net[]>();
  for (const net of nets) {
    const key = canonicalLabel(net.label);
    if (!key) continue;
    const list = byLabel.get(key);
    if (list) list.push(net);
    else byLabel.set(key, [net]);
  }

  for (const [label, members] of [...byLabel].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pages = sheets(members.map((m) => m.page));
    if (pages.length < 2) continue;

    const best = members.reduce((a, b) => (evidence(b) > evidence(a) ? b : a));
    const readOnEverySheet = pages.length === members.length;
    const confidence: Confidence =
      best.role !== 'unknown' && best.roleConfidence === 'high' && readOnEverySheet
        ? 'high'
        : 'medium';

    const rationale = [
      `"${label}" was read on ${pages.length} sheets (${sheetList(pages)}). A net label repeated ` +
        'across sheets is the draughtsman saying it is the same node.',
    ];
    if (!readOnEverySheet) {
      rationale.push(
        `${members.length} nets carry the label across those sheets, so at least one sheet has it ` +
          'on more than one traced net -- the trace may have split a run there.',
      );
    }

    propagate(best, members, label, rationale);

    for (const m of members) grouped.add(m.id);
    links.push({
      id: `lnk${n++}`,
      kind: best.role === 'ground' ? 'ground' : best.role === 'power' ? 'supply' : 'net-label',
      title: label,
      pages,
      netIds: members.map((m) => m.id),
      componentIds: [],
      confidence,
      rationale,
    });
  }

  // --- 2. Ground is global whether or not it is labelled -------------------
  const grounds = nets.filter((x) => x.role === 'ground' && !grouped.has(x.id));
  const groundPages = sheets(grounds.map((g) => g.page));
  if (groundPages.length >= 2) {
    for (const g of grounds) grouped.add(g.id);
    links.push({
      id: `lnk${n++}`,
      kind: 'ground',
      title: 'Ground (unlabelled returns)',
      pages: groundPages,
      netIds: grounds.map((g) => g.id),
      componentIds: [],
      confidence: 'medium',
      rationale: [
        `${grounds.length} nets on sheets ${sheetList(groundPages)} were classified as ground ` +
          'without a shared label.',
        'Ground is common to every sheet of a schematic by convention, so these are almost ' +
          'certainly the same return -- but nothing on the drawing says so outright, hence medium.',
      ],
    });
  }

  // --- 3. Same voltage, no shared label ------------------------------------
  const byVoltage = new Map<number, Net[]>();
  for (const net of nets) {
    if (net.role !== 'power' || net.voltage === undefined || grouped.has(net.id)) continue;
    const list = byVoltage.get(net.voltage);
    if (list) list.push(net);
    else byVoltage.set(net.voltage, [net]);
  }
  for (const [voltage, members] of byVoltage) {
    const pages = sheets(members.map((m) => m.page));
    if (pages.length < 2) continue;
    for (const m of members) grouped.add(m.id);
    const v = `${voltage > 0 ? '+' : ''}${voltage}V`;
    links.push({
      id: `lnk${n++}`,
      kind: 'supply',
      title: v,
      pages,
      netIds: members.map((m) => m.id),
      componentIds: [],
      confidence: 'low',
      rationale: [
        `Supplies of ${v} were identified independently on sheets ${sheetList(pages)}, with no ` +
          'label common to them.',
        'Boards often do run one rail everywhere, but they also run two rails at the same voltage ' +
          '(a switched and an always-on 12V, say). Confirm before treating these as one node.',
      ],
    });
  }

  // --- 4. Connectors appearing on more than one sheet ----------------------
  // Both conventions: CN1 and the Japanese 1CN name the same kind of thing.
  const CONNECTOR_RE = /^(?:(?:CN|CON|J|P|SK|PL|TB)\d{1,3}|\d{1,3}(?:CN|CON|SK|PL|TB))$/i;
  const byRefdes = new Map<string, Component[]>();
  for (const c of components) {
    if (!c.refdes) continue;
    const key = c.refdes.trim().toUpperCase();
    const list = byRefdes.get(key);
    if (list) list.push(c);
    else byRefdes.set(key, [c]);
  }

  for (const [refdes, members] of byRefdes) {
    const pages = sheets(members.map((m) => m.page));
    if (pages.length < 2) continue;

    if (CONNECTOR_RE.test(refdes) || members.some((m) => m.kind === 'connector')) {
      links.push({
        id: `lnk${n++}`,
        kind: 'connector',
        title: refdes,
        pages,
        netIds: [],
        componentIds: members.map((m) => m.id),
        confidence: 'medium',
        rationale: [
          `${refdes} is drawn on sheets ${sheetList(pages)}.`,
          'The same connector on two sheets is where one section hands off to the other: the nets ' +
            'on its pins continue on the far sheet, pin for pin.',
        ],
      });
    } else {
      warnings.push(
        `${refdes} appears on sheets ${sheetList(pages)}. Reference designators are normally unique ` +
          'across a schematic, so this is either an OCR misread or the same part drawn twice.',
      );
    }
  }

  return { links, warnings };
}

/**
 * Carry the group's best-evidenced role onto its weaker members.
 *
 * The point of reading every sheet together: +5V might be crisply printed on
 * the power supply sheet and a smudge on the logic sheet. Once we know they are
 * the same net, the smudge inherits the good reading instead of staying
 * "unclassified" -- but one step down in confidence, and clearly labelled as
 * inherited rather than read.
 */
function propagate(best: Net, members: Net[], label: string, rationale: string[]): void {
  if (best.role === 'unknown') return;

  let changed = 0;
  for (const m of members) {
    if (m === best) continue;
    const sameRole = m.role === best.role;
    if (sameRole && (m.voltage !== undefined || best.voltage === undefined)) continue;
    if (evidence(m) >= evidence(best)) continue;

    if (!sameRole) {
      m.role = best.role;
      m.roleConfidence = weaken(best.roleConfidence);
      m.roleSource = 'cross-sheet';
      changed++;
    }
    if (m.voltage === undefined && best.voltage !== undefined) m.voltage = best.voltage;

    const line =
      `Same label "${label}" as a net on sheet ${best.page + 1}, classified there as ` +
      `${ROLE_LABELS[best.role].toLowerCase()} (${best.roleConfidence} confidence, ` +
      `from ${best.roleSource}). Carried over to this sheet.`;
    if (!m.rationale.includes(line)) m.rationale.push(line);
  }

  if (changed) {
    rationale.push(
      `${changed} net(s) on other sheets took their ${roleWord(best.role)} classification from ` +
        `sheet ${best.page + 1}, where the label was read most confidently.`,
    );
  }
}

function roleWord(role: NetRole): string {
  return ROLE_LABELS[role].toLowerCase();
}
