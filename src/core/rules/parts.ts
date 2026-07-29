/**
 * Part-number recognition.
 *
 * Two layers: a pattern table that decodes the JIS-style families you see all
 * over Japanese service manuals (2SCxxxx, uPCxxxx, TAxxxx...), and a small
 * table of specific parts whose pinout or voltage we actually know.
 *
 * Deliberately conservative -- an unrecognised part stays 'unknown' rather
 * than being force-fitted into a category.
 */

import type { ComponentKind } from '../model/types';

export interface PartInfo {
  kind: ComponentKind;
  description: string;
  /** Regulated output voltage, for regulators. */
  outputVoltage?: number;
  /** Pin names by 1-based index, when the package is standard. */
  pinNames?: string[];
  /** Human-readable note about the family. */
  family?: string;
}

interface PatternRule {
  re: RegExp;
  info: (m: RegExpMatchArray) => PartInfo;
}

/**
 * JIS semiconductor numbering: 2S<letter><serial>.
 *   A = PNP high-freq, B = PNP low-freq, C = NPN high-freq, D = NPN low-freq
 *   J = P-ch FET,      K = N-ch FET
 * The leading "2S" is very often omitted on the drawing (just "C1815").
 */
const JIS_TRANSISTOR: Record<string, string> = {
  A: 'PNP transistor (high frequency)',
  B: 'PNP transistor (low frequency / audio)',
  C: 'NPN transistor (high frequency)',
  D: 'NPN transistor (low frequency / power)',
  J: 'P-channel FET / MOSFET',
  K: 'N-channel FET / MOSFET',
};

const PATTERNS: PatternRule[] = [
  // --- Linear regulators, positive: 78xx / 78Lxx / 78Mxx -----------------
  {
    re: /^(?:[A-Z]{1,4})?78([LMSTC]?)(\d{2})[A-Z]*$/i,
    info: (m) => ({
      kind: 'regulator',
      outputVoltage: Number(m[2]),
      description: `+${Number(m[2])}V positive linear regulator${currentNote(m[1])}`,
      pinNames: ['IN', 'GND', 'OUT'],
      family: '78xx series',
    }),
  },
  // --- Linear regulators, negative: 79xx --------------------------------
  {
    re: /^(?:[A-Z]{1,4})?79([LM]?)(\d{2})[A-Z]*$/i,
    info: (m) => ({
      kind: 'regulator',
      outputVoltage: -Number(m[2]),
      description: `-${Number(m[2])}V negative linear regulator${currentNote(m[1])}`,
      pinNames: ['GND', 'IN', 'OUT'],
      family: '79xx series',
    }),
  },
  // --- Adjustable regulators --------------------------------------------
  {
    re: /^(?:[A-Z]{1,3})?317[A-Z]*$/i,
    info: () => ({
      kind: 'regulator',
      description: 'Adjustable positive linear regulator (1.25V reference)',
      pinNames: ['ADJ', 'OUT', 'IN'],
      family: 'LM317',
    }),
  },
  {
    re: /^(?:[A-Z]{1,3})?337[A-Z]*$/i,
    info: () => ({
      kind: 'regulator',
      description: 'Adjustable negative linear regulator',
      family: 'LM337',
    }),
  },
  {
    re: /^AMS1117(?:-?([\d.]+))?$/i,
    info: (m) => ({
      kind: 'regulator',
      outputVoltage: m[1] ? Number(m[1]) : undefined,
      description: m[1] ? `${m[1]}V low-dropout regulator` : 'Low-dropout regulator',
      pinNames: ['GND/ADJ', 'OUT', 'IN'],
      family: 'AMS1117',
    }),
  },
  // --- JIS transistors, with or without the 2S prefix -------------------
  {
    re: /^2S([ABCDJK])(\d{3,4})[A-Z]*$/i,
    info: (m) => ({
      kind: /[JK]/i.test(m[1]) ? 'transistor' : 'transistor',
      description: JIS_TRANSISTOR[m[1].toUpperCase()],
      pinNames: /[JK]/i.test(m[1]) ? ['G', 'D', 'S'] : ['E', 'C', 'B'],
      family: `2S${m[1].toUpperCase()} (JIS)`,
    }),
  },
  {
    re: /^([ABCDJK])(\d{3,4})[A-Z]*$/,
    info: (m) => ({
      kind: 'transistor',
      description: `${JIS_TRANSISTOR[m[1].toUpperCase()]} (2S prefix omitted)`,
      pinNames: /[JK]/.test(m[1]) ? ['G', 'D', 'S'] : ['E', 'C', 'B'],
      family: `2S${m[1].toUpperCase()} (JIS)`,
    }),
  },
  // --- Japanese linear/analog IC families -------------------------------
  {
    re: /^(?:U)?PC(\d{3,4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'NEC linear IC', family: 'μPC series (NEC)' }),
  },
  {
    re: /^(?:U)?PD(\d{3,5})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'NEC digital IC / microcontroller', family: 'μPD series (NEC)' }),
  },
  {
    re: /^TA(\d{4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Toshiba linear IC (audio/RF)', family: 'TA series (Toshiba)' }),
  },
  {
    re: /^TC(\d{3,5})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Toshiba CMOS logic / IC', family: 'TC series (Toshiba)' }),
  },
  {
    re: /^AN(\d{3,4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Panasonic/Matsushita linear IC', family: 'AN series (Panasonic)' }),
  },
  {
    re: /^BA(\d{3,4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'ROHM linear IC', family: 'BA series (ROHM)' }),
  },
  {
    re: /^H[AD](\d{4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Hitachi linear IC', family: 'HA/HD series (Hitachi)' }),
  },
  {
    re: /^M5[LM]?(\d{3,4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Mitsubishi IC', family: 'M5 series (Mitsubishi)' }),
  },
  {
    re: /^LA(\d{4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Sanyo linear IC', family: 'LA series (Sanyo)' }),
  },
  {
    re: /^S(\d{4})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Sharp IC', family: 'S series (Sharp)' }),
  },
  // --- Common western logic / opamps ------------------------------------
  {
    re: /^(?:SN|DM|MC|HD|TC)?74(?:HC|HCT|LS|ALS|AC|ACT|F|S)?(\d{2,3})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: '7400-series logic gate/function', family: '74xx logic' }),
  },
  {
    re: /^(?:CD|MC|TC)?40(\d{2})[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: '4000-series CMOS logic', family: '4000 CMOS' }),
  },
  {
    re: /^(?:LM|NE|UA|MC)?55[53][A-Z]*$/i,
    info: () => ({
      kind: 'ic',
      description: '555 timer -- often a reset or clock generator',
      pinNames: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
      family: '555 timer',
    }),
  },
  {
    re: /^(?:LM|TL|NE|UA)0?(?:74|72|71|82|84)[A-Z]*$/i,
    info: () => ({ kind: 'ic', description: 'Operational amplifier', family: 'op-amp' }),
  },
  // --- Diodes ------------------------------------------------------------
  {
    re: /^1N(4\d{3}|5\d{3})[A-Z]*$/i,
    info: (m) => {
      const n = Number(m[1]);
      if (n >= 4001 && n <= 4007) {
        return { kind: 'diode', description: 'General-purpose rectifier diode (1A)', family: '1N400x' };
      }
      if (n >= 4728 && n <= 4764) {
        return { kind: 'zener', description: 'Zener diode (1W)', family: '1N47xx' };
      }
      return { kind: 'diode', description: 'Silicon diode', family: '1N series' };
    },
  },
  {
    re: /^1S(\d{3,4})[A-Z]*$/i,
    info: () => ({ kind: 'diode', description: 'JIS small-signal diode', family: '1S series (JIS)' }),
  },
  {
    re: /^RD(\d+(?:\.\d+)?)[A-Z]*$/i,
    info: (m) => ({
      kind: 'zener',
      description: `${m[1]}V zener diode`,
      outputVoltage: Number(m[1]),
      family: 'RD series zener (JIS)',
    }),
  },
  // --- Crystals ----------------------------------------------------------
  {
    re: /^(?:X|XT|Y)\d*$/i,
    info: () => ({ kind: 'crystal', description: 'Crystal / resonator', family: 'crystal' }),
  },
];

function currentNote(letter: string): string {
  const l = letter.toUpperCase();
  if (l === 'L') return ' (100mA)';
  if (l === 'M') return ' (500mA)';
  if (l === 'S') return ' (2A)';
  return ' (1A typical)';
}

/** Refdes prefix -> component kind. The cheapest, most reliable signal we have. */
const REFDES_KINDS: Array<[RegExp, ComponentKind]> = [
  [/^R\d/i, 'resistor'],
  [/^(?:VR|RV|POT|TM)\d/i, 'potentiometer'],
  [/^(?:VC|CV|TC)\d/i, 'variable-capacitor'],
  [/^(?:C|CE)\d/i, 'capacitor'],
  [/^(?:L|FB)\d/i, 'inductor'],
  [/^(?:D|LED)\d/i, 'diode'],
  [/^(?:ZD|DZ)\d/i, 'zener'],
  [/^(?:Q|TR)\d/i, 'transistor'],
  [/^(?:IC|U)\d/i, 'ic'],
  [/^(?:REG|VREG)\d/i, 'regulator'],
  [/^(?:X|XT|Y)\d/i, 'crystal'],
  [/^(?:J|CN|P|CON)\d/i, 'connector'],
  [/^(?:SW|S)\d/i, 'switch'],
  [/^(?:RY|K|RL)\d/i, 'relay'],
  [/^T\d/i, 'transformer'],
  [/^(?:F|FU)\d/i, 'fuse'],
  [/^(?:TP|CP)\d/i, 'testpoint'],
];

/**
 * Refdes suffix -> component kind, for the Japanese number-first convention.
 *
 * "55C" is capacitor 55, "12L" inductor 12, "7CN" connector 7. Kept as its own
 * table rather than folded into the one above because the letter sets differ:
 * a two-letter code has to be tried before its one-letter prefix, or 7CN reads
 * as capacitor 7 with a stray N, and VC (variable capacitor) has no equivalent
 * on the western side at all.
 */
const REFDES_SUFFIX_KINDS: Array<[RegExp, ComponentKind]> = [
  [/^\d+(?:VC|CV)$/i, 'variable-capacitor'],
  [/^\d+(?:VR|RV)$/i, 'potentiometer'],
  [/^\d+CE$/i, 'capacitor'],
  [/^\d+CN$/i, 'connector'],
  [/^\d+ZD$/i, 'zener'],
  [/^\d+SW$/i, 'switch'],
  [/^\d+FB$/i, 'inductor'],
  [/^\d+TP$/i, 'testpoint'],
  [/^\d+RY$/i, 'relay'],
  [/^\d+LED$/i, 'led'],
  [/^\d+IC$/i, 'ic'],
  [/^\d+TR$/i, 'transistor'],
  [/^\d+C$/i, 'capacitor'],
  [/^\d+L$/i, 'inductor'],
  [/^\d+R$/i, 'resistor'],
  [/^\d+D$/i, 'diode'],
  [/^\d+Q$/i, 'transistor'],
  [/^\d+X$/i, 'crystal'],
  [/^\d+T$/i, 'transformer'],
];

export function kindFromRefdes(refdes: string): ComponentKind | undefined {
  const clean = refdes.trim().toUpperCase();
  for (const [re, kind] of REFDES_KINDS) {
    if (re.test(clean)) return kind;
  }
  for (const [re, kind] of REFDES_SUFFIX_KINDS) {
    if (re.test(clean)) return kind;
  }
  return undefined;
}

/**
 * Split a designator into its letters and its number, either way round.
 *
 * Cross-sheet linking and the parts list both want to know that 55C and C55
 * name the same sort of thing, and that 55C and 56C are neighbours.
 */
export function parseRefdes(refdes: string): { prefix: string; number: number } | undefined {
  const clean = refdes.trim().toUpperCase().replace(/\s+/g, '');
  const lead = clean.match(/^([A-Z]{1,3})(\d{1,4})[A-Z]?$/);
  if (lead) return { prefix: lead[1], number: Number(lead[2]) };
  const trail = clean.match(/^(\d{1,4})([A-Z]{1,3})$/);
  if (trail) return { prefix: trail[2], number: Number(trail[1]) };
  return undefined;
}

export function lookupPart(raw: string): PartInfo | undefined {
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (clean.length < 2) return undefined;
  for (const rule of PATTERNS) {
    const m = clean.match(rule.re);
    if (m) return rule.info(m);
  }
  return undefined;
}

/** Parse a printed passive value: "4.7k", "100n", "10uF", "1M", "22p". */
export function parseValue(raw: string): { value: number; unit: string; display: string } | undefined {
  const m = raw
    .trim()
    .replace(/Ω|OHM|ohm/g, '')
    .match(/^(\d+(?:[.,]\d+)?)\s*([pnuμµmkKMGR]?)\s*(F|H|f|h)?$/);
  if (!m) return undefined;

  const mult: Record<string, number> = {
    p: 1e-12, n: 1e-9, u: 1e-6, μ: 1e-6, µ: 1e-6,
    m: 1e-3, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, '': 1,
  };
  const base = Number(m[1].replace(',', '.'));
  const scale = mult[m[2]] ?? 1;
  const unit = m[3] ? m[3].toUpperCase() : 'Ω';
  return { value: base * scale, unit, display: `${m[1]}${m[2]}${m[3] ?? ''}` };
}
