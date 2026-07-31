import type { Analysis, ChatInput, Provider } from '../types'

/**
 * Demo mode. Runs with no key and no network so the app can be shown, styled
 * and tested end to end.
 *
 * It is deliberately a plausible offline SMPS + supervisor board rather than
 * toy data: it exercises every section, every evidence level, a feedback edge
 * through the isolation barrier, a genuinely illegible designator, and a mains
 * safety warning — the cases the layout and the copy have to get right.
 */
const DEMO: Analysis = {
  summary:
    'An offline switch-mode power supply with a small microcontroller supervising it — the kind of board that sits behind the mains inlet of a domestic appliance. Mains comes in at CN1 through a fuse and an X/Y filter, is rectified to about 320 V DC, and is chopped by Q1 into the primary of T1. The secondary gives an isolated +12 V, which feeds a relay and is regulated down to +5 V for the MCU. Output voltage is sensed by IC2 and fed back across the isolation barrier through the optocoupler PC1. Three LEDs on the secondary side report power, run state and fault.',
  isSchematic: true,
  sheet: {
    title: 'POWER SUPPLY / CONTROL PWB',
    equipment: 'Demo appliance controller',
    circuitType: 'Offline flyback SMPS with microcontroller supervision',
    sheetRef: 'Sheet 2 of 5, Rev C',
    language: 'English',
  },
  confidence: 'medium',
  blocks: [
    {
      id: 'mains-in',
      label: 'Mains inlet & filter',
      kind: 'power-in',
      parts: ['CN1', 'F1', 'RV1', 'CX1', 'CY1', 'L1'],
      detail:
        'IEC inlet, 3.15 A slow-blow fuse, a metal-oxide varistor across live and neutral for surge clamping, and a common-mode choke with X and Y capacitors for conducted emissions.',
    },
    {
      id: 'rectifier',
      label: 'Rectifier & bulk store',
      kind: 'power-conv',
      parts: ['BR1', 'C3'],
      detail:
        'Full-wave bridge into a 100 µF 400 V electrolytic. This node sits near 320 V DC and holds charge after the plug is pulled.',
      rails: ['HV DC'],
    },
    {
      id: 'flyback',
      label: 'Flyback switch',
      kind: 'power-conv',
      parts: ['Q1', 'T1', 'IC1', 'R7', 'D2'],
      detail:
        'A MOSFET chops the bulk rail into the primary of T1 under control of the PWM controller IC1. R7 is the current-sense shunt; D2 with R6 forms the snubber across the primary.',
      rails: ['HV DC'],
    },
    {
      id: 'secondary',
      label: 'Secondary rectification',
      kind: 'power-conv',
      parts: ['D5', 'C8', 'L2'],
      detail:
        'Schottky rectifier and a 1000 µF output capacitor produce the isolated +12 V rail, with a small output choke for ripple.',
      rails: ['+12V'],
    },
    {
      id: 'feedback',
      label: 'Regulation feedback',
      kind: 'analog',
      parts: ['IC2', 'PC1', 'R14', 'R15'],
      detail:
        'A TL431 shunt reference watches the +12 V rail through a divider and drives the optocoupler, closing the loop back to IC1 without breaking isolation.',
      rails: ['+12V'],
    },
    {
      id: 'reg-5v',
      label: '+5 V regulator',
      kind: 'power-conv',
      parts: ['IC3', 'C11', 'C12'],
      detail: 'Linear regulator dropping +12 V to +5 V for the logic. TO-220 with a small heatsink.',
      rails: ['+12V', '+5V'],
    },
    {
      id: 'mcu',
      label: 'Supervisor MCU',
      kind: 'control',
      parts: ['IC4', 'X1', 'R20'],
      detail:
        'An 8-bit microcontroller on +5 V with an 8 MHz crystal. Watches the rails, drives the relay and the indicators, and holds the fault latch.',
      rails: ['+5V'],
    },
    {
      id: 'relay',
      label: 'Relay drive',
      kind: 'drive',
      parts: ['Q3', 'K1', 'D8'],
      detail:
        'A small-signal transistor driving the coil of K1 from the +12 V rail, with a flyback diode across the coil.',
      rails: ['+12V'],
    },
    {
      id: 'leds',
      label: 'Indicators',
      kind: 'indicator',
      parts: ['D10', 'D11', 'D12', 'R24', 'R25', 'R26'],
      detail: 'Three LEDs with series resistors, driven directly from MCU port pins.',
      rails: ['+5V'],
    },
  ],
  connections: [
    { from: 'mains-in', to: 'rectifier', label: 'filtered mains', kind: 'power', evidence: 'labelled', confidence: 'high' },
    { from: 'rectifier', to: 'flyback', label: '320 V DC', kind: 'power', evidence: 'symbol', confidence: 'high' },
    { from: 'flyback', to: 'secondary', label: 'T1 secondary', kind: 'power', evidence: 'symbol', confidence: 'high' },
    { from: 'secondary', to: 'reg-5v', label: '+12V', kind: 'power', evidence: 'labelled', confidence: 'high' },
    { from: 'secondary', to: 'feedback', label: '+12V sense', kind: 'sense', evidence: 'labelled', confidence: 'high' },
    { from: 'secondary', to: 'relay', label: '+12V', kind: 'power', evidence: 'labelled', confidence: 'high' },
    { from: 'feedback', to: 'flyback', label: 'opto feedback across barrier', kind: 'feedback', evidence: 'symbol', confidence: 'high' },
    { from: 'reg-5v', to: 'mcu', label: '+5V', kind: 'power', evidence: 'labelled', confidence: 'high' },
    { from: 'mcu', to: 'relay', label: 'RLY_EN', kind: 'control', evidence: 'labelled', confidence: 'medium' },
    { from: 'mcu', to: 'leds', label: 'port pins', kind: 'digital', evidence: 'inferred', confidence: 'medium' },
  ],
  powerRails: [
    {
      name: 'AC LINE',
      voltage: '230 V AC nominal',
      kind: 'input',
      source: 'CN1',
      feeds: ['mains-in', 'rectifier'],
      notes: 'Fused at 3.15 A slow-blow. Everything up to T1 is at mains potential.',
      evidence: 'labelled',
      confidence: 'high',
    },
    {
      name: 'HV DC',
      voltage: '≈320 V DC',
      kind: 'derived',
      source: 'BR1 into C3',
      derivedFrom: 'AC LINE',
      feeds: ['flyback'],
      notes:
        'Stored on a 100 µF 400 V bulk capacitor. C3 has no visible bleeder resistor on this sheet — assume it stays charged.',
      evidence: 'symbol',
      confidence: 'high',
    },
    {
      name: '+12V',
      voltage: '+12 V DC',
      kind: 'derived',
      source: 'D5 / C8 (T1 secondary)',
      derivedFrom: 'HV DC',
      feeds: ['reg-5v', 'relay', 'feedback'],
      testPoint: 'TP2',
      notes: 'Isolated from the primary side. Regulated by the opto feedback loop, not by a linear pass element.',
      evidence: 'labelled',
      confidence: 'high',
    },
    {
      name: '+5V',
      voltage: '+5 V DC',
      kind: 'derived',
      source: 'IC3',
      derivedFrom: '+12V',
      feeds: ['mcu', 'leds'],
      testPoint: 'TP3',
      evidence: 'labelled',
      confidence: 'high',
    },
    {
      name: 'VREF',
      voltage: '2.495 V',
      kind: 'reference',
      source: 'IC2 (TL431)',
      derivedFrom: '+12V',
      feeds: ['feedback'],
      evidence: 'inferred',
      confidence: 'medium',
    },
  ],
  grounds: [
    {
      name: 'PRI RTN',
      kind: 'isolated',
      detail:
        'Primary-side return, the negative of the bulk capacitor. This sits at mains potential and is NOT chassis ground. Clipping a mains-referenced scope probe here is how instruments and people get hurt.',
      confidence: 'high',
    },
    {
      name: 'GND',
      kind: 'signal',
      detail: 'Secondary-side logic return. Safe to reference for anything after the isolation barrier.',
      tiedTo: 'Joined to PGND at the C8 negative terminal, a single star point.',
      confidence: 'high',
    },
    {
      name: 'PGND',
      kind: 'power',
      detail: 'Return for the relay coil and the +12 V load current, kept separate so coil current does not disturb the logic return.',
      tiedTo: 'C8 negative terminal',
      confidence: 'medium',
    },
    {
      name: 'CHASSIS',
      kind: 'earth',
      detail: 'Protective earth from the inlet, bonded to the metalwork.',
      tiedTo: 'Coupled to the secondary return only through the Y capacitor CY1 — an AC path, not a DC one.',
      confidence: 'high',
    },
  ],
  indicators: [
    {
      ref: 'D10',
      label: 'POWER',
      color: 'green',
      drivenBy: 'Directly from +5 V through R24 — not under MCU control',
      rail: '+5V',
      states: [
        { state: 'solid on', means: 'The +5 V rail is up. The supply is running and the secondary side is alive.' },
        { state: 'off', means: 'No +5 V. Either the supply is not running at all, or IC3 has failed. Check TP2 for +12 V first — if 12 V is present and 5 V is not, the fault is IC3.' },
      ],
      evidence: 'symbol',
      confidence: 'high',
    },
    {
      ref: 'D11',
      label: 'RUN',
      color: 'amber',
      drivenBy: 'IC4 port pin through R25, active high',
      rail: '+5V',
      states: [
        { state: 'solid on', means: 'MCU has closed the relay and the load is energised.' },
        { state: 'blinking 1 Hz', means: 'Start-up delay — the MCU is waiting out its rail-settle timer before pulling in K1.' },
        { state: 'off', means: 'Relay is open. Normal when idle; check the fault LED before assuming a problem.' },
      ],
      evidence: 'inferred',
      confidence: 'medium',
    },
    {
      ref: 'D12',
      label: 'FAULT',
      color: 'red',
      drivenBy: 'IC4 port pin through R26, active high',
      rail: '+5V',
      states: [
        { state: 'off', means: 'No fault latched.' },
        { state: 'blinking, counted flashes', means: 'A fault code. The sheet notes 2 flashes = undervoltage, 3 flashes = overtemperature, 4 flashes = relay feedback mismatch. The pattern repeats after a two-second pause.' },
        { state: 'solid on', means: 'The MCU latched a fault it cannot classify, or firmware halted with the pin high. Power-cycle before condemning the board.' },
      ],
      evidence: 'labelled',
      confidence: 'medium',
    },
  ],
  testPoints: [
    {
      ref: 'TP1',
      label: 'HV',
      where: 'Positive terminal of C3, primary side',
      measure: 'DC volts referenced to PRI RTN — never to chassis',
      expected: '300–340 V DC at 230 V AC in',
      meaning:
        'Zero here with mains present means the fuse, the bridge or the filter. LETHAL and mains-referenced: use an isolated meter and treat the whole primary as live.',
      confidence: 'high',
    },
    {
      ref: 'TP2',
      label: '+12V',
      where: 'Positive of C8, secondary side',
      measure: 'DC volts referenced to GND',
      expected: '11.4–12.6 V DC',
      meaning:
        'Low or sagging points at the feedback loop (IC2, PC1) or a tired C8. Absent with TP1 healthy points at the flyback stage or T1.',
      confidence: 'high',
    },
    {
      ref: 'TP3',
      label: '+5V',
      where: 'Output pin of IC3',
      measure: 'DC volts referenced to GND',
      expected: '4.75–5.25 V DC',
      meaning: 'Present +12 V but no +5 V condemns IC3, unless something downstream is pulling the rail down.',
      confidence: 'high',
    },
  ],
  signals: [
    {
      name: 'FB',
      kind: 'feedback',
      from: 'PC1 collector',
      to: 'IC1 feedback pin',
      levels: '0–5 V, loop bandwidth a few kHz',
      detail: 'Optocoupler output setting the duty cycle. Rising FB current reduces on-time.',
      evidence: 'labelled',
      confidence: 'high',
    },
    {
      name: 'CS',
      kind: 'sense',
      from: 'R7 top',
      to: 'IC1 current-sense pin',
      levels: '0–1 V peak',
      detail: 'Cycle-by-cycle primary current limit. A shorted R7 removes the limit entirely.',
      evidence: 'symbol',
      confidence: 'medium',
    },
    {
      name: 'RLY_EN',
      kind: 'control',
      from: 'IC4 port pin',
      to: 'Q3 base through R21',
      levels: '0–5 V, active high',
      detail: 'MCU command to energise K1.',
      evidence: 'labelled',
      confidence: 'medium',
    },
  ],
  connectors: [
    {
      ref: 'CN1',
      label: 'MAINS IN',
      kind: '3-way IEC / spade terminals',
      pins: [
        { pin: '1', name: 'L', detail: 'Live, through F1' },
        { pin: '2', name: 'N', detail: 'Neutral' },
        { pin: '3', name: 'PE', detail: 'Protective earth to chassis' },
      ],
      confidence: 'high',
    },
    {
      ref: 'CN3',
      label: 'CONTROL',
      kind: '4-pin JST-XH',
      pins: [
        { pin: '1', name: '+5V' },
        { pin: '2', name: 'GND' },
        { pin: '3', name: 'SDA', detail: 'To the front-panel board' },
        { pin: '4', name: 'SCL' },
      ],
      mates: 'Front panel display board',
      confidence: 'medium',
    },
  ],
  components: [
    { ref: 'IC1', part: 'UC3843', role: 'Current-mode PWM controller for the flyback', block: 'flyback', evidence: 'labelled', confidence: 'medium' },
    { ref: 'Q1', part: 'unreadable', role: 'Primary switching MOSFET, TO-220F package', block: 'flyback', evidence: 'symbol', confidence: 'low' },
    { ref: 'T1', role: 'Flyback transformer and the isolation barrier of this supply', block: 'flyback', evidence: 'symbol', confidence: 'high' },
    { ref: 'IC2', part: 'TL431', role: 'Programmable shunt reference setting the +12 V output', block: 'feedback', evidence: 'labelled', confidence: 'high' },
    { ref: 'PC1', part: 'PC817', role: 'Optocoupler carrying feedback across the isolation barrier', block: 'feedback', evidence: 'labelled', confidence: 'high' },
    { ref: 'IC3', part: '7805', value: '+5 V 1 A', role: 'Linear regulator for the logic rail', block: 'reg-5v', evidence: 'labelled', confidence: 'high' },
    { ref: 'C3', value: '100 µF 400 V', role: 'Bulk reservoir on the rectified mains — holds a lethal charge', block: 'rectifier', evidence: 'labelled', confidence: 'high' },
    { ref: 'F1', value: '3.15 A T', role: 'Mains fuse, slow-blow to survive inrush', block: 'mains-in', evidence: 'labelled', confidence: 'high' },
  ],
  theoryOfOperation: [
    'Mains enters at CN1 through fuse F1. RV1 clamps surges, and the common-mode choke L1 with CX1/CY1 keeps switching noise from getting back out onto the supply.',
    'BR1 rectifies the incoming AC and C3 smooths it to roughly 320 V DC. This is the highest-energy node on the board and it stays charged after power-off.',
    'IC1 starts switching Q1, chopping the bulk rail through the primary of T1. Energy is stored in the transformer core on each on-time.',
    'On each off-time that energy dumps through D5 into C8, producing the isolated +12 V secondary rail. L2 takes the edge off the ripple.',
    'IC2 compares a divided sample of +12 V against its internal 2.495 V reference and sinks current through the LED of PC1 accordingly.',
    'PC1 passes that error signal across the isolation barrier to the FB pin of IC1, which shortens or lengthens the on-time to hold +12 V steady. This loop is the entire regulation mechanism.',
    'IC3 drops +12 V to a clean +5 V for the logic. D10 lights straight off this rail, so it is a direct witness that the secondary side came up.',
    'IC4 boots, waits out a settle delay while blinking D11, then asserts RLY_EN to turn on Q3 and pull in K1. If it sees an out-of-range rail or an overtemperature input it latches instead and flashes a count on D12.',
  ],
  safetyNotes: [
    'Everything left of T1 — CN1, F1, RV1, L1, BR1, C3, Q1, R7, IC1 — is at MAINS POTENTIAL. The primary return is not ground. Do not clip a mains-referenced oscilloscope probe to it; use an isolation transformer or a differential probe.',
    'C3 is a 100 µF 400 V bulk capacitor with no bleeder visible on this sheet. It can hold well over 300 V for minutes after the plug is pulled. Verify it is discharged at TP1 before touching the primary side.',
    'The isolation barrier runs through T1 and PC1, and the slot in the board beneath them. Never bridge the two sides with a probe, a clip lead or a repair wire.',
  ],
  unreadable: [
    'The part number on Q1 is blurred in the scan — the package is a TO-220F but the marking cannot be resolved. Re-scan that corner at higher DPI to read it.',
    'The value printed under R6 in the snubber is illegible; only the multiplier band position is visible on the symbol.',
    'The revision note in the bottom-right of the title block is cut off by the page edge.',
  ],
  notes: [
    'This is demo data. It is a plausible board, not a reading of any real schematic — switch to Gemini in Settings and add a key to analyze your own sheet.',
    'Fault-code meanings quoted for D12 come from a note in the sheet margin, not from the circuit itself; confirm against the service manual for the specific model.',
    'Only this sheet was read. Nets leaving at the right edge continue on sheet 3 and were not followed.',
  ],
}

const DEMO_ANSWER =
  'Demo mode answers from a canned report, so this is not a real reading of your sheet.\n\n' +
  'To take the example: if the POWER LED (D10) is dark, that rail is the place to start, because D10 hangs directly off +5 V rather than off a port pin — it cannot be dark because of firmware. Check TP3 for 5 V, then TP2 for 12 V. Twelve present and five absent condemns IC3. Both absent sends you to the primary side, where TP1 should read 300–340 V DC.\n\n' +
  'Before probing anything left of T1: that side is at mains potential and C3 holds a lethal charge after power-off. Verify it is discharged first, and use an isolated meter.\n\n' +
  'Add a Gemini key in Settings to ask this about your own schematic.'

export const mockProvider: Provider = {
  id: 'mock',
  label: 'Demo mode (no key, canned data)',
  needsKey: false,
  defaultModel: 'demo',

  async analyze(): Promise<Analysis> {
    // A beat of delay so the working state is actually visible.
    await new Promise((r) => setTimeout(r, 900))
    return structuredClone(DEMO)
  },

  async chat(_input: ChatInput, _opts, onDelta): Promise<string> {
    // Streamed a word at a time so the chat UI can be exercised without a key.
    const words = DEMO_ANSWER.split(' ')
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 18))
      onDelta?.(i === 0 ? words[i] : ` ${words[i]}`)
    }
    return DEMO_ANSWER
  },
}
