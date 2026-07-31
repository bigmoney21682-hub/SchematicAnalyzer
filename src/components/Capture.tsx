import { useRef } from 'react'

interface Props {
  onPick: (file: File) => void
  disabled?: boolean
}

const TIPS = [
  [
    'Send the file, not a photo of the screen',
    'A PDF page or a PNG export beats a phone photo of a monitor every time. Moiré and glare land on exactly the small text the reading depends on.',
  ],
  [
    'One sheet at a time',
    'A single sheet, or a crop of the section you care about. A whole A1 drawing scaled to fit gives a shallow answer about all of it instead of a good one about the part you need.',
  ],
  [
    'Resolution beats framing',
    'If designators are unreadable when you pinch-zoom on your own phone, they are unreadable to the model too. Crop tighter rather than sending the whole page.',
  ],
  [
    'Say what you already know',
    'The model, the symptom, what the LEDs are doing. It sharpens everything downstream, and it is the difference between a description and a diagnosis path.',
  ],
]

/**
 * A file input rather than getUserMedia. Sheets arrive as PDF exports or gallery
 * images, and where the camera is used the OS one gives autofocus and full
 * sensor resolution, which no in-page capture matches — and on a schematic,
 * resolution is the whole game.
 */
export function Capture({ onPick, disabled }: Props) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)

  function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onPick(file)
    // Reset so picking the same file twice still fires a change event.
    e.target.value = ''
  }

  return (
    <div className="capture">
      <div className="capture__art" aria-hidden="true">
        <svg viewBox="0 0 120 96" role="presentation">
          <rect x="10" y="8" width="100" height="80" rx="7" className="sheet-body" />
          <g className="sheet-trace">
            <path d="M22 30 h18" />
            <path d="M52 30 h46" />
            <path d="M22 52 h14" />
            <path d="M48 52 h50" />
            <path d="M60 30 v22" />
            <path d="M84 52 v20 h-40" />
            <path d="M22 72 h22" />
          </g>
          <g className="sheet-part">
            <rect x="40" y="24" width="12" height="12" rx="2" />
            <rect x="36" y="46" width="12" height="12" rx="2" />
          </g>
          <circle cx="60" cy="30" r="2.4" className="sheet-node" />
          <circle cx="84" cy="52" r="2.4" className="sheet-node" />
        </svg>
      </div>

      <h1>What's on this schematic?</h1>
      <p className="capture__lede">
        Upload a sheet and get a block diagram of the circuit, every supply rail and where it comes
        from, which grounds are actually the same net, what each LED means, and where to put a
        probe. Then ask it anything about the sheet.
      </p>

      <div className="capture__actions">
        <button
          className="btn btn--primary"
          onClick={() => libraryRef.current?.click()}
          disabled={disabled}
        >
          Choose a sheet
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => cameraRef.current?.click()}
          disabled={disabled}
        >
          Take a photo
        </button>
      </div>

      <p className="capture__formats">Images or PDF — for a PDF you pick the page.</p>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handle}
        hidden
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
        onChange={handle}
        hidden
      />

      <section className="tips">
        <h2>For a usable result</h2>
        <ul>
          {TIPS.map(([title, body]) => (
            <li key={title}>
              <strong>{title}.</strong> {body}
            </li>
          ))}
        </ul>
      </section>

      <p className="capture__legal">
        A reading aid, not an engineer. It describes the drawing you give it and nothing else —
        always confirm against the sheet before working on live equipment.
      </p>
    </div>
  )
}
