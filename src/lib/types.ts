/**
 * How we came to believe a claim. Drives the badge shown next to it.
 *
 * The split that matters on a schematic is "printed on the sheet" versus
 * "worked out from the topology". A net label reading +5V is the first; knowing
 * that the winding feeding it is the secondary side is the second.
 */
export type Evidence = 'labelled' | 'symbol' | 'inferred' | 'guess'
export type Confidence = 'high' | 'medium' | 'low'

/** Where a rail comes from. Drives the ordering of the power section. */
export type RailKind = 'input' | 'derived' | 'reference' | 'standby' | 'bias'

/** Grounds are not all one net, and treating them as one is how boards get
 *  destroyed — an isolated primary-side return is not chassis. */
export type GroundKind =
  | 'signal'
  | 'power'
  | 'chassis'
  | 'earth'
  | 'isolated'
  | 'floating'
  | 'analog'

export type SignalKind =
  | 'digital'
  | 'analog'
  | 'clock'
  | 'bus'
  | 'feedback'
  | 'control'
  | 'sense'
  | 'rf'
  | 'audio'
  | 'power'

/** Functional category of a block. Sets its colour and its column in the diagram. */
export type BlockKind =
  | 'power-in'
  | 'power-conv'
  | 'protection'
  | 'control'
  | 'analog'
  | 'digital'
  | 'interface'
  | 'sensor'
  | 'drive'
  | 'output'
  | 'indicator'
  | 'other'

/** What the sheet itself says it is — read off the title block where there is one. */
export interface Sheet {
  /** From the title block, e.g. "Power supply / main PWB". */
  title: string
  /** The equipment this board lives in, if the sheet names it. */
  equipment?: string
  /** Short category, e.g. "Offline SMPS with microcontroller supervision". */
  circuitType: string
  /** e.g. "Sheet 3 of 7", "Rev C", a drawing number. */
  sheetRef?: string
  /** Script/language of the annotations, e.g. "Japanese". This app was born on
   *  Japanese service manuals, and callouts often stay untranslated. */
  language?: string
}

/**
 * One supply rail. The user's first question about any board is "what voltages
 * are on this thing and where do they come from", so this is the section that
 * gets rendered first.
 */
export interface PowerRail {
  /** Net name as drawn, e.g. "+B", "VCC", "+3V3". */
  name: string
  /** Nominal voltage with polarity, e.g. "+3.3 V DC". Omitted when unlabelled. */
  voltage?: string
  kind: RailKind
  /** The part that produces it, e.g. "U4 (AMS1117-3.3)" or "J1 pin 2". */
  source?: string
  /** Name of the rail it is regulated down from, for chaining the power tree. */
  derivedFrom?: string
  /** What runs on it — block ids or plain descriptions. */
  feeds: string[]
  /** Designator of a test point or pad where this rail can be measured. */
  testPoint?: string
  /** Ripple limits, sequencing, enable pins, current capability — whatever the
   *  sheet actually says. */
  notes?: string
  evidence: Evidence
  confidence: Confidence
}

/** A distinct return path. Which of these are actually joined, and where, is
 *  the detail that separates a working repair from a blown probe. */
export interface Ground {
  /** e.g. "GND", "AGND", "PGND", "primary RTN". */
  name: string
  kind: GroundKind
  detail: string
  /** Where it meets the other returns, e.g. "star-tied to PGND at C21". Left
   *  empty when the sheet shows it genuinely isolated. */
  tiedTo?: string
  confidence: Confidence
}

/** One state an indicator can be in, and what it tells you. */
export interface IndicatorState {
  /** e.g. "solid on", "off", "blinking 2 Hz", "brief flash at power-up". */
  state: string
  means: string
}

/**
 * An LED or lamp. Explicitly its own section rather than a component row,
 * because on a service call the LEDs are the only diagnostic output a board
 * gives you before you reach for a meter.
 */
export interface Indicator {
  ref?: string
  /** Legend printed next to it, e.g. "POWER", "ERR", "電源". */
  label?: string
  color?: string
  /** What turns it on, e.g. "U1 pin 12 through Q3, active low". */
  drivenBy?: string
  /** The rail it hangs off, so a dead LED can be traced to a dead rail. */
  rail?: string
  states: IndicatorState[]
  evidence: Evidence
  confidence: Confidence
}

/** A place to put a probe, and what the reading should be. */
export interface TestPoint {
  ref?: string
  label?: string
  /** Physical or topological location, e.g. "junction of R14 and Q2 collector". */
  where: string
  /** What to measure and against what, e.g. "DC volts referenced to AGND". */
  measure: string
  /** Nominal reading with tolerance where the sheet gives one. */
  expected?: string
  /** What an out-of-spec reading points at. The diagnostic payload. */
  meaning: string
  confidence: Confidence
}

/** A named net worth following — not every wire, just the ones that carry
 *  meaning between blocks. */
export interface Signal {
  /** Net name as drawn, e.g. "SDA", "FB", "PWM_A". */
  name: string
  kind: SignalKind
  /** Source end, e.g. "U1 pin 22". */
  from: string
  /** Destination end. */
  to: string
  /** Voltage swing, frequency, protocol, polarity. */
  levels?: string
  detail: string
  evidence: Evidence
  confidence: Confidence
}

export interface ConnectorPin {
  /** Pin number or name as drawn. */
  pin: string
  /** What is on it, e.g. "+12V", "RX", "NC". */
  name: string
  detail?: string
}

export interface Connector {
  ref?: string
  label?: string
  /** Housing and pin count where identifiable, e.g. "6-pin JST-XH". */
  kind?: string
  pins: ConnectorPin[]
  /** What plugs in here, if the sheet says. */
  mates?: string
  confidence: Confidence
}

/** A part worth calling out. Not an exhaustive BOM — the ones that shape how
 *  the circuit behaves. */
export interface Component {
  ref?: string
  /** Manufacturer part number where legible. */
  part?: string
  /** Printed value, e.g. "10 kΩ", "470 µF 35 V". */
  value?: string
  /** What it does here. */
  role: string
  /** id of the block it belongs to. */
  block?: string
  evidence: Evidence
  confidence: Confidence
}

/** A functional grouping. These are the boxes in the block diagram. */
export interface Block {
  /** Short slug, referenced by connections and components. */
  id: string
  label: string
  kind: BlockKind
  /** Designators inside this block. */
  parts: string[]
  detail: string
  /** Names of the rails that power it. */
  rails?: string[]
}

/** An edge in the block diagram. */
export interface Connection {
  /** Block id. */
  from: string
  /** Block id. */
  to: string
  /** What flows, e.g. "+12V", "I²C", "gate drive". */
  label: string
  kind: SignalKind
  evidence: Evidence
  confidence: Confidence
}

export interface Analysis {
  /** Plain-English answer to "what is this circuit and what does it do". */
  summary: string
  /** False when the upload isn't a schematic at all; everything else is then
   *  near-empty and the UI says so rather than inventing a circuit. */
  isSchematic: boolean
  sheet: Sheet
  confidence: Confidence
  blocks: Block[]
  connections: Connection[]
  powerRails: PowerRail[]
  grounds: Ground[]
  indicators: Indicator[]
  testPoints: TestPoint[]
  signals: Signal[]
  connectors: Connector[]
  components: Component[]
  /** Ordered walkthrough of how the circuit works, one step per entry. */
  theoryOfOperation: string[]
  /** Mains potential, stored energy, isolation barriers. Rendered loud. */
  safetyNotes: string[]
  /** What the scan was too poor to read — the honest gaps. */
  unreadable: string[]
  /** Caveats, ambiguities, things worth double-checking. */
  notes: string[]
}

export interface AnalyzeInput {
  /** Base64 image data, no data: prefix. */
  imageBase64: string
  mimeType: string
  /** Optional context, e.g. "Sony STR-DH190, no power, standby LED blinks 3×". */
  hint?: string
}

export interface AnalyzeOptions {
  apiKey?: string
  /** Overrides the adapter's default. Model IDs get retired, so this is chosen
   *  from what the key can actually reach rather than hardcoded. */
  model?: string
  signal?: AbortSignal
  /** Fires with the model that actually answered. Usually the one asked for,
   *  but the fallback chain moves on when a model is retired or rate-limited,
   *  and a report has to be attributed to whichever model wrote it. */
  onModel?: (model: string) => void
  /** Fires with the credential that actually worked — the viewer's own key,
   *  their proxy, or the shared pool. Lets the UI say whose quota was spent. */
  onCredential?: (cred: { kind: string; label: string }) => void
  /** Fires with the vendor actually being used, so a report can say it came
   *  from Groq when every Gemini key was spent. */
  onProvider?: (providerId: string) => void
}

export interface ChatMessage {
  role: 'user' | 'model'
  text: string
}

export interface ChatInput {
  imageBase64: string
  mimeType: string
  /** The report under discussion, so follow-ups stay anchored to it. */
  analysis: Analysis
  hint?: string
  /** Full transcript, ending with the question just asked. */
  messages: ChatMessage[]
}

export interface Provider {
  id: string
  label: string
  /** Whether this provider needs a key before it can run. */
  needsKey: boolean
  /** Fallback when the user hasn't picked one. May be retired at any time. */
  defaultModel: string
  analyze(input: AnalyzeInput, opts: AnalyzeOptions): Promise<Analysis>
  /**
   * Answers a follow-up about a schematic already analyzed. Streams: onDelta
   * fires with each fragment, and the resolved value is the complete answer.
   */
  chat(input: ChatInput, opts: AnalyzeOptions, onDelta?: (text: string) => void): Promise<string>
}
