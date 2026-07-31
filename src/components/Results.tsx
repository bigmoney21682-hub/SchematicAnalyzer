import { useRef, useState } from 'react'
import type { Analysis, Confidence, Evidence, GroundKind, RailKind } from '../lib/types'
import { Diagram } from './Diagram'

const EVIDENCE_LABEL: Record<Evidence, string> = {
  labelled: 'read',
  symbol: 'symbol',
  inferred: 'inferred',
  guess: 'guess',
}

const EVIDENCE_TITLE: Record<Evidence, string> = {
  labelled: 'Read as text off the sheet — a net name, designator, value or note',
  symbol: 'Determined from the drawn symbol rather than from text',
  inferred: 'Deduced from the topology and how such circuits are normally built',
  guess: 'A plausible possibility — treat with suspicion',
}

const GROUND_TITLE: Record<GroundKind, string> = {
  signal: 'Logic and small-signal return',
  power: 'High-current return, kept separate so load current stays out of the signal return',
  chassis: 'Bonded to the metalwork',
  earth: 'Protective earth from the mains inlet',
  isolated: 'Across an isolation barrier — NOT the same net as chassis or logic ground',
  floating: 'Not referenced to any other return on this sheet',
  analog: 'Quiet return for the analog section',
}

/** Input first, then what's derived from it. Matches how you'd trace it. */
const RAIL_ORDER: RailKind[] = ['input', 'derived', 'standby', 'bias', 'reference']

function Badge({ evidence, confidence }: { evidence: Evidence; confidence: Confidence }) {
  return (
    <span className={`badge badge--${evidence}`} title={EVIDENCE_TITLE[evidence]}>
      {EVIDENCE_LABEL[evidence]}
      <span className={`dot dot--${confidence}`} title={`${confidence} confidence`} />
    </span>
  )
}

/** Copies to the clipboard, or falls back to selecting the text where the
 *  Clipboard API is missing (it needs a secure context). */
function RawResponse({ analysis }: { analysis: Analysis }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const json = JSON.stringify(analysis, null, 2)

  async function copy() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      if (!preRef.current) return
      const range = document.createRange()
      range.selectNodeContents(preRef.current)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }

  return (
    <details className="raw">
      <summary>
        <span>Full model response</span>
      </summary>
      <div className="raw__body">
        <button className="btn btn--ghost raw__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <pre ref={preRef}>{json}</pre>
      </div>
    </details>
  )
}

interface Props {
  analysis: Analysis
  imageUrl?: string
  onReset: () => void
  /** Overrides the footer button's label — history views say "Back" instead. */
  resetLabel?: string
  /** Provenance line for a saved report: when it ran, on what model. */
  meta?: string
  /** Rendered between the report and the footer button — the chat panel. */
  children?: React.ReactNode
}

export function Results({ analysis, imageUrl, onReset, resetLabel, meta, children }: Props) {
  const { sheet } = analysis

  const rails = [...analysis.powerRails].sort(
    (a, b) => RAIL_ORDER.indexOf(a.kind) - RAIL_ORDER.indexOf(b.kind),
  )

  const sheetLine = [sheet?.equipment, sheet?.sheetRef, sheet?.language]
    .filter(Boolean)
    .join(' · ')

  if (analysis.isSchematic === false) {
    return (
      <div className="results">
        {imageUrl && <img className="results__photo" src={imageUrl} alt="The sheet you uploaded" />}
        <section className="panel panel--warn">
          <h2>Not a schematic</h2>
          <p className="results__summary">{analysis.summary}</p>
        </section>
        <button className="btn btn--primary btn--wide" onClick={onReset}>
          {resetLabel ?? 'Try another sheet'}
        </button>
      </div>
    )
  }

  return (
    <div className="results">
      {imageUrl && <img className="results__photo" src={imageUrl} alt="The sheet you uploaded" />}

      <header className="results__head">
        <p className="results__type">{sheet?.title || 'Schematic'}</p>
        <span className={`chip chip--${analysis.confidence}`}>
          {analysis.confidence} confidence overall
        </span>
      </header>

      {sheet?.circuitType && <p className="results__study">{sheet.circuitType}</p>}
      {sheetLine && <p className="results__meta">{sheetLine}</p>}
      {meta && <p className="results__meta">{meta}</p>}

      {analysis.safetyNotes.length > 0 && (
        <div className="critical" role="alert">
          <strong>Before you probe anything.</strong>
          <ul>
            {analysis.safetyNotes.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="results__summary">{analysis.summary}</p>

      {analysis.blocks.length > 0 && (
        <section className="panel">
          <h2>
            Block diagram
            <span className="panel__note">how the circuit is organised</span>
          </h2>
          <Diagram blocks={analysis.blocks} connections={analysis.connections} />
        </section>
      )}

      {rails.length > 0 && (
        <section className="panel">
          <h2>
            Power rails
            <span className="panel__note">what's on the board and where it comes from</span>
          </h2>
          <ul className="rails">
            {rails.map((r, i) => (
              <li className={`rail rail--${r.kind}`} key={i}>
                <div className="rail__top">
                  <span className="rail__name">{r.name}</span>
                  {r.voltage && <span className="rail__volts">{r.voltage}</span>}
                  <span className="rail__kind">{r.kind}</span>
                  <Badge evidence={r.evidence} confidence={r.confidence} />
                </div>
                <dl className="kv">
                  {r.source && (
                    <>
                      <dt>From</dt>
                      <dd>
                        {r.source}
                        {r.derivedFrom ? ` — regulated down from ${r.derivedFrom}` : ''}
                      </dd>
                    </>
                  )}
                  {r.feeds?.length > 0 && (
                    <>
                      <dt>Feeds</dt>
                      <dd>{r.feeds.join(', ')}</dd>
                    </>
                  )}
                  {r.testPoint && (
                    <>
                      <dt>Measure at</dt>
                      <dd>{r.testPoint}</dd>
                    </>
                  )}
                  {r.notes && (
                    <>
                      <dt>Notes</dt>
                      <dd>{r.notes}</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.grounds.length > 0 && (
        <section className="panel">
          <h2>
            Grounds
            <span className="panel__note">which returns are the same net, and which are not</span>
          </h2>
          <ul className="cards">
            {analysis.grounds.map((g, i) => (
              <li className={`card card--gnd-${g.kind}`} key={i}>
                <div className="card__top">
                  <span className="card__name">{g.name}</span>
                  <span className="badge" title={GROUND_TITLE[g.kind]}>
                    {g.kind}
                    <span className={`dot dot--${g.confidence}`} title={`${g.confidence} confidence`} />
                  </span>
                </div>
                <p className="card__body">{g.detail}</p>
                {g.tiedTo ? (
                  <p className="card__tie">Tied to: {g.tiedTo}</p>
                ) : (
                  <p className="card__tie card__tie--alone">
                    Not shown joined to any other return on this sheet.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.indicators.length > 0 && (
        <section className="panel">
          <h2>
            Indicators
            <span className="panel__note">what the LEDs are telling you</span>
          </h2>
          <ul className="cards">
            {analysis.indicators.map((led, i) => (
              <li className="card card--led" key={i}>
                <div className="card__top">
                  <span
                    className="led__dot"
                    style={{ background: ledColor(led.color) }}
                    aria-hidden="true"
                  />
                  <span className="card__name">
                    {led.label || led.ref || 'Indicator'}
                    {led.label && led.ref ? <span className="card__ref"> {led.ref}</span> : null}
                  </span>
                  <Badge evidence={led.evidence} confidence={led.confidence} />
                </div>
                {(led.drivenBy || led.rail) && (
                  <p className="card__where">
                    {led.drivenBy}
                    {led.drivenBy && led.rail ? ' · ' : ''}
                    {led.rail ? `on ${led.rail}` : ''}
                  </p>
                )}
                <ul className="states">
                  {led.states.map((s, j) => (
                    <li key={j}>
                      <span className="states__state">{s.state}</span>
                      <span className="states__means">{s.means}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.testPoints.length > 0 && (
        <section className="panel">
          <h2>
            Test points
            <span className="panel__note">where to probe and what you should see</span>
          </h2>
          <ul className="cards">
            {analysis.testPoints.map((tp, i) => (
              <li className="card card--tp" key={i}>
                <div className="card__top">
                  <span className="card__name">{tp.ref || tp.label || 'Test point'}</span>
                  {tp.expected && <span className="tp__expected">{tp.expected}</span>}
                  <span className={`dot dot--${tp.confidence}`} title={`${tp.confidence} confidence`} />
                </div>
                <dl className="kv">
                  <dt>Where</dt>
                  <dd>{tp.where}</dd>
                  <dt>Measure</dt>
                  <dd>{tp.measure}</dd>
                  <dt>If it's wrong</dt>
                  <dd>{tp.meaning}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.theoryOfOperation.length > 0 && (
        <section className="panel">
          <h2>
            How it works
            <span className="panel__note">start to finish</span>
          </h2>
          <ol className="theory">
            {analysis.theoryOfOperation.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </section>
      )}

      {analysis.signals.length > 0 && (
        <section className="panel">
          <h2>Signals worth following</h2>
          <ul className="signals">
            {analysis.signals.map((s, i) => (
              <li key={i}>
                <div className="signal__top">
                  <span className={`signal__name signal__name--${s.kind}`}>{s.name}</span>
                  <span className="signal__route">
                    {s.from} <span aria-label="to">→</span> {s.to}
                  </span>
                  <Badge evidence={s.evidence} confidence={s.confidence} />
                </div>
                {s.levels && <div className="signal__levels">{s.levels}</div>}
                <div className="signal__detail">{s.detail}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.connectors.length > 0 && (
        <section className="panel">
          <h2>Connectors</h2>
          <ul className="cards">
            {analysis.connectors.map((c, i) => (
              <li className="card" key={i}>
                <div className="card__top">
                  <span className="card__name">{c.ref || c.label || 'Connector'}</span>
                  {c.label && c.ref && <span className="card__where">{c.label}</span>}
                  <span className={`dot dot--${c.confidence}`} title={`${c.confidence} confidence`} />
                </div>
                {c.kind && <p className="card__where">{c.kind}</p>}
                <ol className="pins">
                  {c.pins.map((p, j) => (
                    <li key={j}>
                      <span className="pins__no">{p.pin}</span>
                      <span className="pins__name">{p.name}</span>
                      {p.detail && <span className="pins__detail">{p.detail}</span>}
                    </li>
                  ))}
                </ol>
                {c.mates && <p className="card__tie">Mates with: {c.mates}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.components.length > 0 && (
        <section className="panel">
          <h2>Key components</h2>
          <ul className="parts">
            {analysis.components.map((c, i) => (
              <li key={i}>
                <div className="part__top">
                  {c.ref && <span className="part__ref">{c.ref}</span>}
                  <span className="part__name">{c.part ?? c.value ?? 'Unidentified part'}</span>
                  <Badge evidence={c.evidence} confidence={c.confidence} />
                </div>
                <div className="part__role">{c.role}</div>
                {c.part && c.value && <div className="part__meta">{c.value}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.unreadable.length > 0 && (
        <section className="panel panel--action">
          <h2>
            Couldn't be read
            <span className="panel__note">re-scan these bits and run it again</span>
          </h2>
          <ul>
            {analysis.unreadable.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </section>
      )}

      {analysis.notes.length > 0 && (
        <section className="panel panel--muted">
          <h2>Caveats</h2>
          <ul>
            {analysis.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="results__legal">
        Read by a general-purpose AI model, not by an engineer. It describes the drawing, not the
        board in front of you — treat every line above as a prompt to check the sheet yourself, and
        confirm anything you are about to put a probe or a soldering iron on.
      </p>

      {children}

      <RawResponse analysis={analysis} />

      <button className="btn btn--primary btn--wide" onClick={onReset}>
        {resetLabel ?? 'Analyze another sheet'}
      </button>
    </div>
  )
}

/** Maps a colour word to something renderable, defaulting to a neutral pip. */
function ledColor(color?: string): string {
  const c = (color ?? '').toLowerCase()
  if (c.includes('green')) return '#57cc99'
  if (c.includes('red')) return '#ff6b6b'
  if (c.includes('amber') || c.includes('yellow') || c.includes('orange')) return '#f9c74f'
  if (c.includes('blue')) return '#4cc9f0'
  if (c.includes('white')) return '#e8eef5'
  if (c.includes('infra')) return '#6b4bd6'
  return '#8ea0b5'
}
