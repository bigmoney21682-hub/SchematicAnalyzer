/**
 * Offline question answering.
 *
 * This is intent matching over the extracted model, not a language model. It
 * handles the questions people actually ask a schematic ("what does this rail
 * feed?", "what is Q3?", "where do I probe for 5V?") deterministically, with
 * citations back to the evidence.
 *
 * When it cannot answer, it says so plainly and -- if an AI provider is
 * configured -- offers to escalate. Never bluff.
 */

import type { Component, Net, SchematicDoc } from '../model/types';
import { ROLE_LABELS, sheetName } from '../model/types';
import { hasJapanese, translate } from '../jp/lexicon';
import { lookupPart, parseValue } from '../rules/parts';
import { canonicalLabel } from '../link/sheets';
import { localId } from '../model/sheet';

export interface Answer {
  text: string;
  /** Doc entities the answer refers to, so the UI can highlight them. */
  highlights: { nets: string[]; components: string[]; blocks: string[] };
  /** Evidence lines shown under the answer. */
  citations: string[];
  /** True when the rules engine could not answer at all. */
  unanswered: boolean;
}

const empty = (): Answer['highlights'] => ({ nets: [], components: [], blocks: [] });

type Handler = (q: string, doc: SchematicDoc) => Answer | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sheet suffix, e.g. " [sheet 3]".
 *
 * Silent on a single-sheet document, and unmissable on a multi-sheet one: an
 * answer that identifies a part without saying which of fifteen drawings to
 * open is barely an answer at all.
 */
function at(doc: SchematicDoc, page: number): string {
  return doc.pages.length > 1 ? ` [sheet ${page + 1}]` : '';
}

function netDisplay(n: Net, doc?: SchematicDoc): string {
  // Skip the voltage suffix when the label already states it ("+5V +5V").
  const stated = n.label ? /[+-]?\d/.test(n.label) : false;
  const v = n.voltage !== undefined && !stated ? ` ${n.voltage > 0 ? '+' : ''}${n.voltage}V` : '';
  return `${n.label ?? localId(n.id)}${v} (${ROLE_LABELS[n.role]})${doc ? at(doc, n.page) : ''}`;
}

/** Nets on other sheets that the links say are the same node as this one. */
function twinsOf(net: Net, doc: SchematicDoc): Net[] {
  const ids = new Set(doc.sheetLinks.filter((l) => l.netIds.includes(net.id)).flatMap((l) => l.netIds));
  return doc.nets.filter((n) => n.id !== net.id && ids.has(n.id));
}

/** One sentence naming the other sheets a net carries on to, if any. */
function continuesOn(net: Net, doc: SchematicDoc): string {
  const pages = [...new Set(twinsOf(net, doc).map((t) => t.page + 1))].sort((a, b) => a - b);
  if (!pages.length) return '';
  return ` The same node continues on sheet${pages.length > 1 ? 's' : ''} ${pages.join(', ')}.`;
}

function compDisplay(c: Component, doc?: SchematicDoc): string {
  const named = [c.refdes, c.value].filter(Boolean).join(' ');
  const base = named || (c.kind === 'unknown' ? 'unlabelled symbol' : `unlabelled ${c.kind}`);
  return doc ? `${base}${at(doc, c.page)}` : base;
}

/** Is this component identifiable to a human, or just a detected blob? */
function isNamed(c: Component): boolean {
  return Boolean(c.refdes || c.value);
}

/**
 * Render a component list for a human.
 *
 * Internal ids are meaningless to the reader, and a schematic always yields
 * more anonymous blobs than named parts. Name what we can, count the rest.
 */
function describeComponents(comps: Component[], doc?: SchematicDoc): string {
  const named = comps.filter(isNamed);
  const anonymous = comps.length - named.length;
  const parts: string[] = [];
  if (named.length) parts.push(named.map((c) => compDisplay(c, doc)).join(', '));
  if (anonymous) {
    parts.push(`${anonymous} further symbol${anonymous === 1 ? '' : 's'} whose label was not read`);
  }
  return parts.join(', plus ');
}

function findComponents(q: string, doc: SchematicDoc): Component[] {
  const m = q.toUpperCase().match(/\b((?:R|C|CE|L|D|ZD|Q|TR|IC|U|VR|X|Y|J|CN|SW|S|RY|T|F|TP|LED)\d{1,4})\b/);
  if (!m) return [];
  return doc.components.filter((c) => c.refdes?.toUpperCase() === m[1]);
}

/**
 * The net a question is about.
 *
 * On a multi-sheet document the answer is a *group*: "+5V" names one node that
 * was traced separately on each sheet it appears on, and answering from only
 * the first copy found would list a third of what the rail actually feeds. The
 * best-evidenced copy leads, and its cross-sheet twins come with it.
 */
function findNets(q: string, doc: SchematicDoc): Net[] {
  const upper = q.toUpperCase();
  const withTwins = (n: Net) => [n, ...twinsOf(n, doc)];

  // Prefer the longest label match so "+12V" beats "V".
  const labelled = doc.nets
    .filter((n) => n.label && upper.includes(n.label.toUpperCase()))
    .sort((a, b) => b.label!.length - a.label!.length || b.length - a.length);
  if (labelled.length) {
    const key = canonicalLabel(labelled[0].label);
    // Same label on other sheets counts even when no link was recorded.
    const sameLabel = key ? doc.nets.filter((n) => canonicalLabel(n.label) === key) : [labelled[0]];
    return unique([...sameLabel, ...withTwins(labelled[0])]);
  }

  const v = upper.match(/([+-]?\d{1,3}(?:\.\d)?)\s*V\b/);
  if (v) {
    const want = Number(v[1]);
    const hits = doc.nets.filter((n) => n.voltage === want);
    if (hits.length) return unique(hits.flatMap(withTwins));
  }
  if (/\bGROUND\b|\bGND\b|\bEARTH\b/.test(upper)) {
    const grounds = doc.nets.filter((n) => n.role === 'ground');
    if (grounds.length) return grounds;
  }
  return [];
}

function unique<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function consumersOf(nets: Net[], doc: SchematicDoc): Component[] {
  const netIds = new Set(nets.map((n) => n.id));
  const ids = new Set(doc.pins.filter((p) => p.netId && netIds.has(p.netId)).map((p) => p.componentId));
  return doc.components.filter((c) => ids.has(c.id));
}

/** "sheets 1, 3 and 4" for a set of entities. */
function spread(items: Array<{ page: number }>): number[] {
  return [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Handlers, tried in order
// ---------------------------------------------------------------------------

const handlers: Handler[] = [
  // --- "what does the 5V rail power?" ------------------------------------
  (q, doc) => {
    if (!/\b(power|feed|supply|supplies|drive|drives|goes to|connect)/i.test(q)) return;
    const nets = findNets(q, doc);
    if (!nets.length) return;

    const lead = nets[0];
    const pages = spread(nets);
    const comps = consumersOf(nets, doc);
    // Answering across the whole node is the point of reading the sheets
    // together; say so explicitly, or the count looks inflated.
    const scope =
      pages.length > 1
        ? ` Traced across sheets ${pages.map((p) => p + 1).join(', ')} as one node.`
        : at(doc, lead.page) && ` On sheet ${lead.page + 1}.`;

    if (!comps.length) {
      return {
        text:
          `${netDisplay(lead)} has no components attached in the extracted model. That usually means ` +
          'the trace missed its connections rather than that the rail is unused -- check the coverage ' +
          `warning in the Quality panel.${scope}`,
        highlights: { ...empty(), nets: nets.map((n) => n.id) },
        citations: lead.rationale,
        unanswered: false,
      };
    }

    const byPage = pages
      .map((p) => `sheet ${p + 1}: ${describeComponents(comps.filter((c) => c.page === p))}`)
      .join('\n• ');

    return {
      text:
        `${netDisplay(lead)} connects to ${comps.length} component(s).${scope}\n` +
        (pages.length > 1 ? `• ${byPage}` : describeComponents(comps) + '.') +
        (lead.voltage !== undefined
          ? `\nAnything on this net should measure about ${lead.voltage > 0 ? '+' : ''}${lead.voltage}V with respect to ground.`
          : ''),
      highlights: { nets: nets.map((n) => n.id), components: comps.map((c) => c.id), blocks: [] },
      citations: [...new Set(nets.flatMap((n) => n.rationale))],
      unanswered: false,
    };
  },

  // --- "what is R12?" -----------------------------------------------------
  (q, doc) => {
    const matches = findComponents(q, doc);
    if (!matches.length) return;
    const comp = matches[0];
    const part = comp.value ? lookupPart(comp.value) : undefined;
    const val = comp.value ? parseValue(comp.value) : undefined;
    const nets = doc.pins
      .filter((p) => p.componentId === comp.id && p.netId)
      .map((p) => doc.nets.find((n) => n.id === p.netId))
      .filter((n): n is Net => Boolean(n));

    const bits = [`${compDisplay(comp, doc)} is a ${comp.kind}`];
    if (part?.description) bits.push(part.description);
    if (val) bits.push(`value ${val.display}${val.unit === 'Ω' ? 'Ω' : val.unit}`);
    if (part?.pinNames) bits.push(`standard pinout ${part.pinNames.join('/')}`);

    let text = bits.join('. ') + '.';
    if (nets.length) {
      text += ` It sits on ${nets.length} net(s): ${nets.map((n) => netDisplay(n, doc)).join('; ')}.`;
      const carried = nets.map((n) => continuesOn(n, doc)).filter(Boolean);
      if (carried.length) text += carried[0];
    }
    if (matches.length > 1) {
      text +=
        ` This designator was also read on sheet(s) ${spread(matches.slice(1))
          .map((p) => p + 1)
          .join(', ')} -- either the same part shown again, or an OCR misread.`;
    }
    if (comp.kindConfidence === 'low') {
      text += ' Note: this identification is low confidence -- the refdes or value may have been misread.';
    }

    return {
      text,
      highlights: { nets: nets.map((n) => n.id), components: matches.map((c) => c.id), blocks: [] },
      citations: comp.rationale,
      unanswered: false,
    };
  },

  // --- "how do the sheets connect?" ---------------------------------------
  (q, doc) => {
    if (!/\b(sheet|page|pages|between|across|link|connect.*(sheet|page))/i.test(q)) return;
    if (doc.pages.length < 2) return;

    // "what is on sheet 3" -- a specific sheet, rather than the links.
    const which = q.match(/\b(?:sheet|page)\s*(\d{1,2})\b/i);
    if (which) {
      const page = Number(which[1]) - 1;
      const sheet = doc.pages[page];
      if (!sheet) {
        return {
          text: `This document has ${doc.pages.length} sheets, so there is no sheet ${which[1]}.`,
          highlights: empty(),
          citations: [],
          unanswered: false,
        };
      }
      const blocks = doc.blocks.filter((b) => b.page === page);
      const rails = doc.nets.filter((n) => n.page === page && (n.role === 'power' || n.role === 'ground'));
      const links = doc.sheetLinks.filter((l) => l.pages.includes(page));
      return {
        text: [
          `${sheetName(sheet)}: ${sheet.stats?.netCount ?? 0} nets, ${sheet.stats?.componentCount ?? 0} components.`,
          blocks.length ? `Blocks: ${blocks.map((b) => b.title).join(', ')}.` : 'No functional blocks identified here.',
          rails.length ? `Supply/return: ${rails.map((n) => netDisplay(n)).join('; ')}.` : '',
          links.length
            ? `Shares ${links.map((l) => l.title).join(', ')} with other sheets.`
            : 'Nothing on this sheet was linked to another sheet -- it may be self-contained, or its labels may not have been read.',
        ]
          .filter(Boolean)
          .join('\n'),
        highlights: { nets: rails.map((n) => n.id), components: [], blocks: blocks.map((b) => b.id) },
        citations: sheet.stats?.warnings ?? [],
        unanswered: false,
      };
    }

    if (!doc.sheetLinks.length) {
      return {
        text:
          `No cross-sheet links were found across the ${doc.pages.length} sheets. That means no net label ` +
          'was read on two sheets and no connector designator repeated -- usually an OCR problem rather ' +
          'than genuinely independent drawings. Check the labels in the Nets tab.',
        highlights: empty(),
        citations: [],
        unanswered: false,
      };
    }

    return {
      text:
        `${doc.sheetLinks.length} link(s) tie the ${doc.pages.length} sheets together:\n` +
        doc.sheetLinks
          .map(
            (l) =>
              `• ${l.title} — ${l.kind.replace('-', ' ')}, sheets ${l.pages
                .map((p) => p + 1)
                .join(', ')} (${l.confidence} confidence)`,
          )
          .join('\n'),
      highlights: { ...empty(), nets: doc.sheetLinks.flatMap((l) => l.netIds) },
      citations: doc.sheetLinks.flatMap((l) => l.rationale).slice(0, 8),
      unanswered: false,
    };
  },

  // --- "is this I2C / SPI / UART?" ----------------------------------------
  (q, doc) => {
    const m = q.toUpperCase().match(/\b(I2C|I²C|SPI|UART|SERIAL|CLOCK|RESET|GROUND|POWER)\b/);
    if (!m) return;
    const roleMap: Record<string, Net['role']> = {
      I2C: 'i2c', 'I²C': 'i2c', SPI: 'spi', UART: 'uart', SERIAL: 'uart',
      CLOCK: 'clock', RESET: 'reset', GROUND: 'ground', POWER: 'power',
    };
    const role = roleMap[m[1]];
    const nets = doc.nets.filter((n) => n.role === role);
    if (!nets.length) {
      return {
        text:
          `No nets were classified as ${ROLE_LABELS[role]} anywhere in this document ` +
          `(${doc.pages.length} sheet${doc.pages.length === 1 ? '' : 's'} analysed). Either the labels ` +
          'were not read by OCR, or this function is on a sheet you have not added yet.',
        highlights: empty(),
        citations: [],
        unanswered: false,
      };
    }
    return {
      text:
        `${nets.length} net(s) classified as ${ROLE_LABELS[role]}` +
        (doc.pages.length > 1 ? `, on sheet(s) ${spread(nets).map((x) => x + 1).join(', ')}` : '') +
        `: ${nets.map((n) => netDisplay(n, doc)).join('; ')}.`,
      highlights: { ...empty(), nets: nets.map((n) => n.id) },
      citations: nets.flatMap((n) => n.rationale).slice(0, 6),
      unanswered: false,
    };
  },

  // --- "where do I probe / test points" -----------------------------------
  (q, doc) => {
    if (!/\b(test point|testpoint|probe|measure|check voltage|where.*measure)/i.test(q)) return;
    const tps = doc.annotations.filter((a) => a.kind === 'testpoint' && !a.hidden);
    if (!tps.length) {
      return {
        text: 'No test points were identified. Nothing was marked TP-something, and no net had a confidently determined voltage to suggest a probe point.',
        highlights: empty(),
        citations: [],
        unanswered: false,
      };
    }
    return {
      text:
        `${tps.length} suggested probe point(s):\n` +
        tps.map((t) => `• ${t.text}${at(doc, t.page)}`).join('\n'),
      highlights: empty(),
      citations: ['Derived from TP designators, Japanese 測定点 captions, and nets with known voltages.'],
      unanswered: false,
    };
  },

  // --- "list the rails / what voltages" -----------------------------------
  (q, doc) => {
    if (!/\b(rails?|voltages?|supplies|list.*net)/i.test(q)) return;
    const rails = doc.nets.filter((n) => n.role === 'power' || n.role === 'ground');
    if (!rails.length) return;

    // On a multi-sheet document the same rail is traced once per sheet, so list
    // the shared nodes first and only then the copies, or the answer reads as
    // though the board has nine separate 5V supplies.
    const shared = doc.sheetLinks.filter((l) => l.kind === 'supply' || l.kind === 'ground');
    const header = shared.length
      ? `${shared.length} rail(s) run across sheets: ` +
        shared.map((l) => `${l.title} (sheets ${l.pages.map((p) => p + 1).join(', ')})`).join(', ') +
        '.\n\n'
      : '';

    return {
      text:
        header +
        `${rails.length} supply/return net(s):\n` +
        rails
          .map((n) => `• ${netDisplay(n, doc)} — ${n.roleConfidence} confidence, from ${n.roleSource}`)
          .join('\n'),
      highlights: { ...empty(), nets: rails.map((n) => n.id) },
      citations: rails.flatMap((n) => n.rationale).slice(0, 8),
      unanswered: false,
    };
  },

  // --- "what blocks are there" --------------------------------------------
  (q, doc) => {
    if (!/\b(blocks?|sections?|what.*circuit|overview|summar)/i.test(q)) return;
    if (!doc.blocks.length) return;
    return {
      text:
        `${doc.blocks.length} functional block(s) identified:\n` +
        doc.blocks
          .map(
            (b) =>
              `• ${b.title}${at(doc, b.page)} (${b.confidence} confidence, ${b.componentIds.length} parts)`,
          )
          .join('\n'),
      highlights: { ...empty(), blocks: doc.blocks.map((b) => b.id) },
      citations: doc.blocks.flatMap((b) => b.rationale).slice(0, 8),
      unanswered: false,
    };
  },

  // --- "what does <japanese> mean?" ---------------------------------------
  (q, doc) => {
    if (!hasJapanese(q)) return;
    const { text, matches } = translate(q);
    if (!matches.length) return;
    const onPage = doc.texts.filter((t) => matches.some((m) => t.text.includes(m.jp)));
    return {
      text:
        `"${matches.map((m) => m.jp).join('')}" means "${text}".\n` +
        matches.map((m) => `• ${m.jp} (${m.romaji}) — ${m.en}`).join('\n') +
        (onPage.length
          ? `\n\nThis appears ${onPage.length} time(s)` +
            (doc.pages.length > 1 ? ` on sheet(s) ${spread(onPage).map((x) => x + 1).join(', ')}.` : ' on the drawing.')
          : ''),
      highlights: empty(),
      citations: ['Translated from the built-in Japanese schematic lexicon.'],
      unanswered: false,
    };
  },

  // --- "how many X" --------------------------------------------------------
  (q, doc) => {
    const m = q.toLowerCase().match(/how many (\w+)/);
    if (!m) return;
    const want = m[1].replace(/s$/, '');
    const kinds = doc.components.filter((c) => c.kind.startsWith(want) || want.startsWith(c.kind));
    if (kinds.length) {
      return {
        text:
          `${kinds.length} ${want}(s) detected` +
          (doc.pages.length > 1 ? ` across sheet(s) ${spread(kinds).map((x) => x + 1).join(', ')}` : '') +
          `: ${describeComponents(kinds.slice(0, 20), doc)}${
            kinds.length > 20 ? ` and ${kinds.length - 20} more` : ''
          }.`,
        highlights: { ...empty(), components: kinds.map((c) => c.id) },
        citations: [`Counted from symbols whose reference designator or part number indicated a ${want}.`],
        unanswered: false,
      };
    }
    if (/net|node/.test(want)) {
      return {
        text:
          `${doc.nets.length} nets were traced` +
          (doc.pages.length > 1 ? ` over ${doc.pages.length} sheets.` : '.'),
        highlights: empty(),
        citations: [],
        unanswered: false,
      };
    }
    return;
  },

  // --- "how good is this analysis" -----------------------------------------
  (q, doc) => {
    if (!/\b(confiden|accurate|quality|trust|reliab|how good)/i.test(q)) return;
    const s = doc.stats;
    const lines = [
      `${doc.pages.length} sheet(s) analysed.`,
      `Conductor trace covered ${(s.traceCoverage * 100).toFixed(0)}% of the ink.`,
      `OCR returned ${s.ocrItems} text items at ${s.ocrMeanConfidence.toFixed(0)}% mean confidence.`,
      `${s.netCount} nets and ${s.componentCount} components extracted.`,
      `${doc.nets.filter((n) => n.roleConfidence === 'high').length} net roles are high confidence, ` +
        `${doc.nets.filter((n) => n.roleConfidence === 'low').length} are low.`,
    ];
    if (doc.pages.length > 1) {
      lines.push(
        `${doc.sheetLinks.length} cross-sheet link(s). Weak linking is the thing to watch on a ` +
          'multi-sheet analysis: without it each sheet is read in isolation, and a rail that ' +
          'continues onto another sheet looks like it feeds nothing.',
      );
      const worst = [...doc.pages]
        .filter((p) => p.stats)
        .sort((a, b) => (a.stats!.traceCoverage ?? 0) - (b.stats!.traceCoverage ?? 0))[0];
      if (worst && worst.stats!.traceCoverage < 0.2) {
        lines.push(
          `Sheet ${worst.index + 1} traced worst, at ${(worst.stats!.traceCoverage * 100).toFixed(0)}% ` +
            'coverage -- rescan that one first if its connectivity matters.',
        );
      }
    }
    if (s.warnings.length) lines.push('', 'Warnings:', ...s.warnings.map((w) => `• ${w}`));
    return { text: lines.join('\n'), highlights: empty(), citations: [], unanswered: false };
  },
];

export function ask(question: string, doc: SchematicDoc): Answer {
  const q = question.trim();
  if (!q) {
    return { text: 'Ask me about a net, a component, the rails, the blocks, or a Japanese label.', highlights: empty(), citations: [], unanswered: false };
  }

  for (const h of handlers) {
    const a = h(q, doc);
    if (a) return a;
  }

  return {
    text:
      "I can't answer that from the extracted model alone. I handle questions about specific components (\"what is Q3?\"), " +
      'nets and rails ("what does +5V feed?"), buses, test points, functional blocks, Japanese labels, and analysis quality.',
    highlights: empty(),
    citations: [],
    unanswered: true,
  };
}

/**
 * Compact textual summary of the document.
 *
 * Used as context when escalating a question to an AI provider -- small enough
 * to be cheap, complete enough to reason over.
 */
export function summarizeForAi(doc: SchematicDoc, maxChars = 8000): string {
  const lines: string[] = [];
  const multi = doc.pages.length > 1;
  const sheet = (page: number) => (multi ? ` @sheet${page + 1}` : '');

  lines.push(`Schematic: ${doc.name}`);
  lines.push(
    `Extraction quality: ${(doc.stats.traceCoverage * 100).toFixed(0)}% trace coverage, ` +
      `${doc.stats.netCount} nets, ${doc.stats.componentCount} components, across ${doc.pages.length} sheet(s).`,
  );
  if (doc.stats.warnings.length) lines.push(`Caveats: ${doc.stats.warnings.join(' ')}`);

  if (multi) {
    lines.push('', 'SHEETS:');
    for (const p of doc.pages) {
      lines.push(
        `- sheet${p.index + 1}: ${p.title ?? 'untitled'} — ${p.stats?.netCount ?? 0} nets, ` +
          `${p.stats?.componentCount ?? 0} parts, ${((p.stats?.traceCoverage ?? 0) * 100).toFixed(0)}% traced`,
      );
    }

    lines.push('', 'CROSS-SHEET LINKS (what makes these one circuit):');
    if (doc.sheetLinks.length) {
      for (const l of doc.sheetLinks) {
        lines.push(
          `- ${l.title} [${l.kind}, ${l.confidence}] spans sheets ${l.pages.map((p) => p + 1).join(', ')}`,
        );
      }
    } else {
      lines.push('- none found; treat each sheet as independently extracted.');
    }
  }

  lines.push('', 'NETS:');
  for (const n of doc.nets.filter((x) => x.role !== 'unknown').slice(0, 80)) {
    const parts = consumersOf([n], doc).filter(isNamed).map((c) => compDisplay(c)).slice(0, 8).join(', ');
    lines.push(
      `- ${netDisplay(n)}${sheet(n.page)} [${n.roleConfidence}/${n.roleSource}]${parts ? ` -> ${parts}` : ''}`,
    );
  }

  lines.push('', 'COMPONENTS:');
  for (const c of doc.components.filter(isNamed).slice(0, 100)) {
    lines.push(`- ${compDisplay(c)}${sheet(c.page)}: ${c.kind}${c.description ? ` (${c.description})` : ''}`);
  }

  lines.push('', 'BLOCKS:');
  for (const b of doc.blocks) {
    lines.push(`- ${b.title}${sheet(b.page)} [${b.confidence}]: ${b.rationale.join(' ')}`);
  }

  const jp = doc.texts.filter((t) => t.translation).slice(0, 40);
  if (jp.length) {
    lines.push('', 'JAPANESE TEXT ON DRAWING:');
    for (const t of jp) lines.push(`- ${t.text}${sheet(t.page)} = ${t.translation}`);
  }

  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n...(truncated)' : out;
}
