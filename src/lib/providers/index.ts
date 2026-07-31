import type { Provider } from '../types'
import { geminiProvider, listGeminiModels } from './gemini'
import { mockProvider } from './mock'

export const providers: Provider[] = [geminiProvider, mockProvider]

export function getProvider(id: string): Provider {
  return providers.find((p) => p.id === id) ?? geminiProvider
}

/** Key test / model discovery, for providers that support it. */
export const modelListers: Record<string, (apiKey: string) => Promise<string[]>> = {
  gemini: listGeminiModels,
}

/**
 * Ranks a listed model for this task. Deliberately conservative — anything it
 * can't reason about scores 0 and sorts below the known-good shapes, but stays
 * selectable.
 *
 * Reading a schematic is bottlenecked on resolving small text: a designator on
 * a scanned service sheet is a handful of pixels tall, and the difference
 * between the models is exactly whether "R147" comes back as "R147" or "RI47".
 * So Pro outranks Flash here even though Flash has the roomier free quota.
 */
function scoreModel(id: string): number {
  const s = id.toLowerCase()
  let score = 0

  // Non-starters: no vision, or wrong modality entirely. "-image" catches
  // image *generation* variants, which read as vision models by name but
  // aren't (e.g. gemini-2.5-flash-image).
  if (/embedding|imagen|veo|tts|whisper|guard|moderation|aqa|rerank/.test(s)) return -100
  if (/-image($|-)|image-gen|nano-banana/.test(s)) return -100

  if (s.includes('pro')) score += 30
  if (s.includes('flash')) score += 22

  // "-latest" aliases survive model retirements, which is our whole problem here.
  if (s.includes('latest')) score += 15

  // Prefer stable over preview/experimental dated snapshots.
  if (/preview|exp|beta/.test(s)) score -= 10
  if (/\d{3,4}-\d{2}-\d{2}|\d{6,8}/.test(s)) score -= 5

  // Lite variants trade away exactly the visual acuity this task depends on.
  if (s.includes('lite')) score -= 20

  // Newer generation numbers win, mildly. Takes the first plausible version
  // token: a bare int or decimal under 20, so parameter counts like "120b" and
  // date stamps like "09-2025" aren't mistaken for versions. The trailing
  // [a-z] exclusion matters: "gpt-oss-20b" is a parameter count, not version 20.
  const version = s.match(/(?:^|[-/a-z])(\d{1,2})(?:\.(\d+))?(?![\d.a-z])/)
  if (version) score += Number(version[1]) * 2 + Number(version[2] ?? 0) / 10

  return score
}

/** Best available model from a key's own list, or '' if none look usable. */
export function pickDefaultModel(models: string[]): string {
  const ranked = models
    .map((id) => ({ id, score: scoreModel(id) }))
    .filter((m) => m.score > -100)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return ranked[0]?.id ?? ''
}

export { scoreModel }

export { geminiProvider, mockProvider }
