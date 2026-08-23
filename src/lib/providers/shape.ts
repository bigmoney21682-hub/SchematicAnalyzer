import type { Analysis } from '../types'

/**
 * Turning a model's JSON into an Analysis the UI can render without guarding
 * every field.
 *
 * Shared by both adapters, and it has to be: Gemini's structured output
 * guarantees the shape but not the optional arrays, while Groq's JSON mode
 * guarantees nothing at all. The renderer should not have to know which one
 * produced the report it is drawing.
 */

/**
 * Drops connections whose endpoints don't exist. The model is told every edge
 * must reference a real block id and mostly complies, but one hallucinated
 * endpoint would otherwise put a phantom node in the diagram — and a diagram
 * that invents a block is worse than one that omits an edge.
 */
export function pruneConnections(parsed: Analysis): Analysis['connections'] {
  const ids = new Set((parsed.blocks ?? []).map((b) => b.id))
  return (parsed.connections ?? []).filter(
    (c) => ids.has(c.from) && ids.has(c.to) && c.from !== c.to,
  )
}

export function normalizeAnalysis(parsed: Analysis): Analysis {
  return {
    ...parsed,
    isSchematic: parsed.isSchematic !== false,
    sheet: parsed.sheet ?? { title: 'Untitled sheet', circuitType: 'Unknown' },
    blocks: parsed.blocks ?? [],
    connections: pruneConnections(parsed),
    powerRails: parsed.powerRails ?? [],
    grounds: parsed.grounds ?? [],
    indicators: parsed.indicators ?? [],
    testPoints: parsed.testPoints ?? [],
    signals: parsed.signals ?? [],
    connectors: parsed.connectors ?? [],
    components: parsed.components ?? [],
    theoryOfOperation: parsed.theoryOfOperation ?? [],
    safetyNotes: parsed.safetyNotes ?? [],
    unreadable: parsed.unreadable ?? [],
    notes: parsed.notes ?? [],
  }
}
