/**
 * Model ranking, kept in its own module so both the provider registry and the
 * providers themselves can use it. It used to live in index.ts, which the
 * providers cannot import without a cycle — index.ts imports them.
 */

/**
 * Ranks a listed model for this task. Deliberately conservative — anything it
 * can't reason about scores 0 and sorts below the known-good shapes, but stays
 * selectable.
 *
 * Flash outranks Pro, which is a reversal. Pro genuinely reads faint detail
 * better, and on a paid key it would still be the right default. On the free
 * tier it is rate limited hard enough that it usually answers 429, and every
 * attempt — including the one that fails — is a request against the shared
 * daily allowance. Ranking Pro first therefore spent two units to produce one
 * report, and halved what a viewer could actually do in a day.
 *
 * So the trade is a little acuity on a faint sheet for roughly twice as many
 * analyses, and a first attempt that usually succeeds. Pro stays one line down
 * the list, which is where the fallback chain looks next, and stays selectable
 * outright in Settings for anyone on a paid key.
 */
export function scoreModel(id: string): number {
  const s = id.toLowerCase()
  let score = 0

  // Non-starters: no vision, or wrong modality entirely. "-image" catches
  // image *generation* variants, which read as vision models by name but
  // aren't (e.g. gemini-2.5-flash-image).
  if (/embedding|imagen|veo|tts|whisper|guard|moderation|aqa|rerank/.test(s)) return -100
  if (/-image($|-)|image-gen|nano-banana/.test(s)) return -100

  if (s.includes('flash')) score += 30
  if (s.includes('pro')) score += 22

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

/**
 * Usable models, best first. Drops only the outright unusable — a model that
 * merely scores badly stays in, because when the good ones are rate-limited a
 * mediocre answer beats no answer.
 */
export function rankModels(models: string[]): string[] {
  return models
    .map((id) => ({ id, score: scoreModel(id) }))
    .filter((m) => m.score > -100)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((m) => m.id)
}

/** Best available model from a key's own list, or '' if none look usable. */
export function pickDefaultModel(models: string[]): string {
  return rankModels(models)[0] ?? ''
}
