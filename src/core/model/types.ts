/**
 * Core document model.
 *
 * Everything the analyzer produces hangs off `SchematicDoc`. The guiding rule:
 * we never mutate or discard the source raster. Extraction results are a
 * separate, fully-editable layer drawn on top of it, so a bad trace is always
 * a cosmetic problem the user can fix -- never a corrupted schematic.
 *
 * A document is a *set of sheets*, because a real board's schematic almost
 * never fits on one page. Every extracted entity therefore carries the sheet
 * it lives on, and ids are namespaced per sheet (`s2/net14`) so the flat arrays
 * below can hold a whole manual without collisions. What ties the sheets into
 * one circuit lives in `sheetLinks`.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Confidence in an automatically-derived fact. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Where a fact came from. User edits always outrank machine guesses.
 *
 * `cross-sheet` means the fact was carried over from another sheet of the same
 * document -- weaker than reading it off this sheet, stronger than a guess.
 */
export type Provenance =
  | 'user'
  | 'ocr'
  | 'topology'
  | 'partdb'
  | 'heuristic'
  | 'cross-sheet'
  | 'learned'
  | 'ai';

/** Zero-based index of the sheet an entity was extracted from. */
export interface OnSheet {
  page: number;
}

// ---------------------------------------------------------------------------
// Geometry extracted from the raster
// ---------------------------------------------------------------------------

/** A straight conductor run. Schematics are overwhelmingly Manhattan. */
export interface WireSegment extends OnSheet {
  id: string;
  a: Point;
  b: Point;
  orientation: 'h' | 'v';
  /** Stroke thickness in px, used to spot heavy power traces. */
  weight: number;
  netId?: string;
}

/** A point where three or more conductors meet (usually drawn as a dot). */
export interface Junction extends OnSheet {
  id: string;
  at: Point;
  degree: number;
  /** True if a solder dot was actually detected, vs. inferred from a T shape. */
  dotted: boolean;
  netId?: string;
}

/**
 * An electrically continuous set of segments.
 *
 * `label` is whatever text we associated with it; `role` is what we think it
 * *is*. Those are deliberately separate -- a net labelled "B+" and a net we
 * inferred is a rail from topology alone should be distinguishable.
 */
export interface Net extends OnSheet {
  id: string;
  segmentIds: string[];
  junctionIds: string[];
  label?: string;
  labelSource?: Provenance;
  role: NetRole;
  roleConfidence: Confidence;
  roleSource: Provenance;
  /** Nominal voltage in volts if we could determine one. */
  voltage?: number;
  /** Human-facing explanation, shown in the inspector and used by Q&A. */
  rationale: string[];
  bbox: Rect;
  /** Total conductor length -- long nets are more likely to be rails/buses. */
  length: number;
  pinIds: string[];
}

export type NetRole =
  | 'power'
  | 'ground'
  | 'signal'
  | 'clock'
  | 'reset'
  | 'i2c'
  | 'spi'
  | 'uart'
  | 'analog'
  | 'reference'
  | 'protection'
  | 'unknown';

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface Component extends OnSheet {
  id: string;
  /** Reference designator, e.g. R12, IC3, VR1. */
  refdes?: string;
  refdesSource?: Provenance;
  /** Printed value or part number, e.g. "4.7k", "TA7358AP". */
  value?: string;
  kind: ComponentKind;
  kindConfidence: Confidence;
  /** Where the kind came from. `user` outranks everything and is never revised. */
  kindSource?: Provenance;
  bbox: Rect;
  pins: Pin[];
  /** Notes from the part database, e.g. "5V linear regulator". */
  description?: string;
  rationale: string[];
}

export type ComponentKind =
  | 'resistor'
  | 'capacitor'
  | 'variable-capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'zener'
  | 'transistor'
  | 'ic'
  | 'regulator'
  | 'crystal'
  | 'connector'
  | 'switch'
  | 'relay'
  | 'transformer'
  | 'fuse'
  | 'varistor'
  | 'potentiometer'
  | 'testpoint'
  /**
   * A ground symbol. Not a part you could buy, but it is drawn like one, it is
   * the single most common symbol on a schematic, and naming one is what tells
   * the app which net is the return -- so it is picked and corrected exactly
   * like any other symbol.
   */
  | 'ground'
  | 'unknown';

export interface Pin extends OnSheet {
  id: string;
  componentId: string;
  at: Point;
  number?: string;
  name?: string;
  netId?: string;
}

// ---------------------------------------------------------------------------
// Text / OCR
// ---------------------------------------------------------------------------

export interface TextItem extends OnSheet {
  id: string;
  text: string;
  bbox: Rect;
  /** Tesseract's 0-100 confidence. */
  confidence: number;
  /** Detected script, which drives whether we attempt translation. */
  script: 'latin' | 'japanese' | 'mixed';
  /** English rendering for Japanese text, from the built-in lexicon. */
  translation?: string;
  /** Romaji reading of the Japanese, as a learning aid and a sanity check on OCR. */
  romaji?: string;
  /** Share of the Japanese characters the lexicon actually knew, 0..1. */
  translationCoverage?: number;
  /** How we classified this string. */
  kind: 'refdes' | 'value' | 'netlabel' | 'annotation' | 'title' | 'unknown';
}

// ---------------------------------------------------------------------------
// Functional blocks
// ---------------------------------------------------------------------------

/** A region of the schematic performing a recognisable job. */
export interface FunctionalBlock extends OnSheet {
  id: string;
  kind: BlockKind;
  title: string;
  bbox: Rect;
  componentIds: string[];
  netIds: string[];
  confidence: Confidence;
  /** Why we think this is what it is -- always shown to the user. */
  rationale: string[];
}

export type BlockKind =
  | 'power-supply'
  | 'regulation'
  | 'reset'
  | 'clock'
  | 'comms'
  | 'protection'
  | 'amplifier'
  | 'filter'
  | 'connector'
  | 'mcu'
  | 'unknown';

// ---------------------------------------------------------------------------
// Annotations (the overlay the user exports)
// ---------------------------------------------------------------------------

export interface Annotation extends OnSheet {
  id: string;
  kind: 'note' | 'flag' | 'testpoint' | 'measurement';
  at: Point;
  /** Optional leader-line target, so a note can point at a net or part. */
  target?: Point;
  text: string;
  color?: string;
  source: Provenance;
  /** User-hidden annotations stay in the doc but are not drawn or exported. */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Where a sheet's raster came from, so it can be redrawn at higher resolution.
 *
 * The raster in `dataUrl` is capped at a size the analysis pipeline can chew
 * through, which is well short of what a screen can show when you zoom in on a
 * part number. This is the trail back to the bytes the user actually gave us:
 * the full-resolution photo, or -- far better -- the PDF's own vectors, which
 * can be re-rendered as sharply as the display asks.
 */
export interface PageOrigin {
  /** Key into the sources store; several sheets of one PDF share it. */
  key: string;
  kind: 'image' | 'pdf';
  /** Page inside the PDF, 1-based. Absent for images. */
  pdfPage?: number;
  /** Size of the source in its own units -- pixels, or PDF points at scale 1. */
  naturalWidth: number;
  naturalHeight: number;
}

/** One sheet of the document: its raster, provenance and own quality figures. */
export interface SourcePage {
  /** Sheet number within the document, zero-based. */
  index: number;
  width: number;
  height: number;
  /** Rendered raster as a data URL, so the doc survives a reload. */
  dataUrl: string;
  /** Rotation applied by deskew, in degrees. */
  deskewAngle: number;
  /**
   * Quarter turns the user has applied since upload, clockwise, 0/90/180/270.
   * Already baked into `dataUrl` and into the geometry of everything on this
   * sheet -- recorded only so the UI can say how far the sheet has been turned.
   */
  rotation?: number;
  /** File this sheet came from -- several uploads can make one document. */
  sourceName?: string;
  /** Trail back to the original bytes, for sharp redraws when zoomed in. */
  origin?: PageOrigin;
  /** Page number inside that file, 1-based. Meaningful for multi-page PDFs. */
  sourcePage?: number;
  /** Sheet title read from the drawing, e.g. "電源回路図 — power supply". */
  title?: string;
  /** Per-sheet extraction quality. The doc-level figures are these, pooled. */
  stats?: PageStats;
}

/**
 * Something that ties two or more sheets into one circuit.
 *
 * Multi-sheet schematics are not independent drawings: a rail labelled +5V on
 * sheet 1 is the same copper as +5V on sheet 4, and a connector that appears
 * twice is the physical hand-off between sections. These links are what make
 * whole-document analysis mean anything, so they are first-class, carry their
 * reasoning, and drive role propagation between sheets.
 */
export interface SheetLink {
  id: string;
  kind: 'net-label' | 'supply' | 'ground' | 'connector';
  /** Display name, e.g. "+5V" or "CN3". */
  title: string;
  /** Sheets involved, zero-based, ascending. */
  pages: number[];
  netIds: string[];
  componentIds: string[];
  confidence: Confidence;
  rationale: string[];
}

export interface SchematicDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: SourcePage[];
  activePage: number;
  segments: WireSegment[];
  junctions: Junction[];
  nets: Net[];
  components: Component[];
  pins: Pin[];
  texts: TextItem[];
  blocks: FunctionalBlock[];
  annotations: Annotation[];
  /** Cross-sheet connections. Empty for a single-sheet document. */
  sheetLinks: SheetLink[];
  /** Pipeline diagnostics, surfaced in the UI so quality is never a mystery. */
  stats: AnalysisStats;
}

/** Extraction quality for a single sheet. */
export interface PageStats {
  /** Fraction of ink assigned to a net. Low values mean a poor trace. */
  traceCoverage: number;
  ocrItems: number;
  ocrMeanConfidence: number;
  netCount: number;
  componentCount: number;
  /** Ink pixels on the sheet, used to weight the pooled figures. */
  ink: number;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
}

export interface AnalysisStats extends PageStats {
  /** Sheets analysed. */
  pageCount: number;
  /** Cross-sheet links found. */
  linkCount: number;
  timings: Record<string, number>;
}

export const emptyPageStats = (): PageStats => ({
  traceCoverage: 0,
  ocrItems: 0,
  ocrMeanConfidence: 0,
  netCount: 0,
  componentCount: 0,
  ink: 0,
  warnings: [],
});

export const emptyStats = (): AnalysisStats => ({
  ...emptyPageStats(),
  pageCount: 0,
  linkCount: 0,
  timings: {},
});

/** Palette shared by the renderer, legend and exporters. */
export const ROLE_COLORS: Record<NetRole, string> = {
  power: '#ff3b30',
  ground: '#1c1c1e',
  signal: '#0a84ff',
  clock: '#bf5af2',
  reset: '#ff9f0a',
  i2c: '#30d158',
  spi: '#64d2ff',
  uart: '#ffd60a',
  analog: '#ff375f',
  reference: '#5e5ce6',
  protection: '#ac8e68',
  unknown: '#8e8e93',
};

export const ROLE_LABELS: Record<NetRole, string> = {
  power: 'Power rail',
  ground: 'Ground / return',
  signal: 'Digital signal',
  clock: 'Clock',
  reset: 'Reset',
  i2c: 'I²C bus',
  spi: 'SPI bus',
  uart: 'UART',
  analog: 'Analog',
  reference: 'Voltage reference',
  protection: 'Protection',
  unknown: 'Unclassified',
};

/** How a sheet is named everywhere in the UI, exports and answers. */
export function sheetName(page: SourcePage | undefined, index?: number): string {
  const n = (page?.index ?? index ?? 0) + 1;
  return page?.title ? `Sheet ${n} — ${page.title}` : `Sheet ${n}`;
}

/** How each component kind is named in the UI. */
export const COMPONENT_LABELS: Record<ComponentKind, string> = {
  resistor: 'Resistor',
  capacitor: 'Capacitor',
  'variable-capacitor': 'Variable capacitor / trimmer',
  inductor: 'Inductor / coil',
  diode: 'Diode',
  led: 'LED',
  zener: 'Zener diode',
  transistor: 'Transistor',
  ic: 'IC',
  regulator: 'Voltage regulator',
  crystal: 'Crystal / resonator',
  connector: 'Connector',
  switch: 'Switch',
  relay: 'Relay',
  transformer: 'Transformer',
  fuse: 'Fuse',
  varistor: 'Varistor / MOV',
  potentiometer: 'Potentiometer / trimmer',
  testpoint: 'Test point',
  ground: 'Ground',
  unknown: 'Unidentified',
};

/**
 * Kinds offered first when naming an unidentified symbol.
 *
 * The passives and the three-terminal parts, because those are what a symbol
 * detector working from a scan actually fails on -- an IC is a labelled
 * rectangle and gets recognised; a two-lead blob in the middle of a dense sheet
 * does not. Ground is here for the same reason and then some: it is the most
 * common symbol on any sheet, it carries no designator to be read from, and
 * naming one settles the role of the net it sits on.
 */
export const COMMON_COMPONENT_KINDS: ComponentKind[] = [
  'resistor',
  'capacitor',
  'ground',
  'diode',
  'transistor',
  'inductor',
  'ic',
  'connector',
];

export const BLOCK_LABELS: Record<BlockKind, string> = {
  'power-supply': 'Power supply',
  regulation: 'Regulation',
  reset: 'Reset circuit',
  clock: 'Clock / oscillator',
  comms: 'Communications',
  protection: 'Protection',
  amplifier: 'Amplifier',
  filter: 'Filter',
  connector: 'Connector / I-O',
  mcu: 'MCU / processor',
  unknown: 'Unidentified block',
};
