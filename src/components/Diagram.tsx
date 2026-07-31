import { useMemo, useState } from 'react'
import { NODE_W, layoutDiagram } from '../lib/layout'
import type { Block, BlockKind, Connection, SignalKind } from '../lib/types'

/**
 * Wire colours by what flows. Kept here rather than in CSS because SVG
 * arrowhead markers can't inherit a stroke colour from a class — each one has
 * to be defined with its own fill, so the palette has to be readable from JS.
 */
const WIRE: Record<SignalKind, string> = {
  power: '#f9a03f',
  digital: '#4cc9f0',
  analog: '#57cc99',
  clock: '#b892ff',
  bus: '#4cc9f0',
  feedback: '#e879a6',
  control: '#7ee8fa',
  sense: '#57cc99',
  rf: '#b892ff',
  audio: '#57cc99',
}

/** Left-edge accent on each box, so kind reads without a legend. */
const BLOCK_TINT: Record<BlockKind, string> = {
  'power-in': '#f9a03f',
  'power-conv': '#f9c74f',
  protection: '#ff6b6b',
  control: '#4cc9f0',
  analog: '#57cc99',
  digital: '#4cc9f0',
  interface: '#7ee8fa',
  sensor: '#b892ff',
  drive: '#f9a03f',
  output: '#e879a6',
  indicator: '#f9c74f',
  other: '#8ea0b5',
}

const KIND_LABEL: Record<BlockKind, string> = {
  'power-in': 'power in',
  'power-conv': 'conversion',
  protection: 'protection',
  control: 'control',
  analog: 'analog',
  digital: 'digital',
  interface: 'interface',
  sensor: 'sensor',
  drive: 'drive',
  output: 'output',
  indicator: 'indicator',
  other: '',
}

/**
 * SVG has no text wrapping, so labels are broken by hand. Two lines at ~19
 * characters is what fits a 156px box at 13px without the type getting small
 * enough to be useless on a phone.
 */
function wrap(text: string, perLine = 19, maxLines = 2): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= perLine) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)

  // Anything that didn't fit is elided rather than silently dropped.
  const used = lines.join(' ')
  if (used.length < text.length && lines.length > 0) {
    const last = lines.length - 1
    lines[last] = `${lines[last].slice(0, perLine - 1).trimEnd()}…`
  }
  return lines
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

interface Props {
  blocks: Block[]
  connections: Connection[]
}

export function Diagram({ blocks, connections }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const layout = useMemo(() => layoutDiagram(blocks, connections), [blocks, connections])

  if (layout.nodes.length === 0) return null

  const open = layout.nodes.find((n) => n.block.id === selected)?.block
  // One marker per colour actually used, rather than ten unused defs.
  const markerKinds = [...new Set(layout.edges.map((e) => e.conn.kind))]

  return (
    <div className="diagram">
      <div className="diagram__scroll">
        <svg
          className="diagram__svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label="Block diagram of the circuit"
        >
          <defs>
            {markerKinds.map((kind) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0.5 L 8 4 L 0 7.5 z" fill={WIRE[kind] ?? WIRE.digital} />
              </marker>
            ))}
          </defs>

          {/* Wires first: nodes paint over them, so a long run passing behind a
              box reads as passing behind rather than through. */}
          <g className="diagram__wires">
            {layout.edges.map((edge, i) => {
              const color = WIRE[edge.conn.kind] ?? WIRE.digital
              return (
                <g key={i} className={edge.back ? 'wire wire--back' : 'wire'}>
                  <path
                    d={edge.d}
                    fill="none"
                    stroke={color}
                    strokeWidth={edge.conn.kind === 'power' ? 2.2 : 1.6}
                    strokeDasharray={edge.back ? '5 4' : undefined}
                    markerEnd={`url(#arrow-${edge.conn.kind})`}
                    opacity={edge.conn.confidence === 'low' ? 0.55 : 0.9}
                  />
                  <text
                    className="wire__label"
                    x={edge.labelX}
                    y={edge.labelY}
                    textAnchor={edge.side ? 'end' : 'middle'}
                    fill={color}
                  >
                    {/* A side-lane label grows leftward across the boxes, so it
                        gets a much tighter budget than one sitting in the open
                        gap between two layers. */}
                    {truncate(edge.conn.label, edge.side ? 13 : 22)}
                  </text>
                </g>
              )
            })}
          </g>

          <g>
            {layout.nodes.map((node) => {
              const tint = BLOCK_TINT[node.block.kind] ?? BLOCK_TINT.other
              const lines = wrap(node.block.label)
              const isOpen = node.block.id === selected
              const parts = node.block.parts?.slice(0, 4).join(' ') ?? ''

              return (
                <g
                  key={node.block.id}
                  className={`node${isOpen ? ' node--open' : ''}`}
                  onClick={() => setSelected(isOpen ? null : node.block.id)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isOpen}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelected(isOpen ? null : node.block.id)
                    }
                  }}
                >
                  <rect
                    className="node__box"
                    x={node.x}
                    y={node.y}
                    width={node.w}
                    height={node.h}
                    rx="10"
                    stroke={isOpen ? tint : undefined}
                  />
                  <rect
                    className="node__tint"
                    x={node.x}
                    y={node.y}
                    width="4"
                    height={node.h}
                    fill={tint}
                  />

                  {lines.map((line, i) => (
                    <text
                      key={i}
                      className="node__label"
                      x={node.x + node.w / 2}
                      y={node.y + (lines.length === 1 ? 34 : 27) + i * 16}
                      textAnchor="middle"
                    >
                      {line}
                    </text>
                  ))}

                  {parts && (
                    <text
                      className="node__parts"
                      x={node.x + node.w / 2}
                      y={node.y + node.h - 22}
                      textAnchor="middle"
                    >
                      {truncate(parts, 24)}
                    </text>
                  )}

                  <text
                    className="node__kind"
                    x={node.x + node.w / 2}
                    y={node.y + node.h - 8}
                    textAnchor="middle"
                    fill={tint}
                  >
                    {KIND_LABEL[node.block.kind] ?? ''}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <p className="diagram__hint">
        {layout.width > NODE_W * 2.5 ? 'Scroll sideways for the full width. ' : ''}
        Tap a block for what's in it.
      </p>

      {open && (
        <div className="diagram__detail">
          <div className="diagram__detail-head">
            <strong>{open.label}</strong>
            <button
              className="btn btn--icon"
              onClick={() => setSelected(null)}
              aria-label="Close block detail"
            >
              ✕
            </button>
          </div>
          <p>{open.detail}</p>
          {open.parts?.length > 0 && <p className="diagram__parts">{open.parts.join(' · ')}</p>}
          {open.rails && open.rails.length > 0 && (
            <p className="diagram__rails">Runs on {open.rails.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}
