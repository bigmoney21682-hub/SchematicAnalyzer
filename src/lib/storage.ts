import { sanitizeKey } from './apikey'
import type { Analysis, ChatMessage } from './types'

const KEY_PROVIDER = 'sch.provider'
const KEY_HISTORY = 'sch.history'

/** Keys are per-provider, so adding a second provider later costs nothing. */
const apiKeyFor = (providerId: string) => `sch.apiKey.${providerId}`
const modelFor = (providerId: string) => `sch.model.${providerId}`

/** Empty means "use the adapter's default". Set once you've picked from Test. */
export const modelStore = {
  get: (providerId: string) => localStorage.getItem(modelFor(providerId)) ?? '',
  set: (providerId: string, v: string) => localStorage.setItem(modelFor(providerId), v),
}

/**
 * The key lives only in this browser's localStorage and is sent only to the
 * provider's own endpoint. Nothing here ever touches the host serving the app.
 */
export const apiKeyStore = {
  get: (providerId: string) => localStorage.getItem(apiKeyFor(providerId)) ?? '',
  // sanitize, not trim — interior zero-width characters survive trim().
  set: (providerId: string, v: string) =>
    localStorage.setItem(apiKeyFor(providerId), sanitizeKey(v)),
  clear: (providerId: string) => localStorage.removeItem(apiKeyFor(providerId)),
}

export const providerStore = {
  get: () => localStorage.getItem(KEY_PROVIDER) ?? 'gemini',
  set: (v: string) => localStorage.setItem(KEY_PROVIDER, v),
}

/**
 * crypto.randomUUID exists only in secure contexts, so it's missing when the
 * dev server is reached over plain http on a LAN address — which is exactly how
 * the phone reaches it. These ids are just local list keys; uniqueness is all
 * that matters, not cryptographic quality.
 */
function historyId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface HistoryEntry {
  id: string
  at: number
  /** Sheet title, for the list row. */
  title: string
  summary: string
  /** Which provider and model produced this, so old entries aren't misread as
   *  the current model's work. */
  provider: string
  model: string
  hint?: string
  /** e.g. "page 3 of 7 of manual.pdf". */
  origin?: string
  /** Small JPEG data: URL. Shed first when storage runs out, so it may be gone
   *  on an old entry even though the report survives. */
  thumbnail?: string
  /** The model's full structured response, exactly as it was rendered. */
  analysis: Analysis
  /** Follow-up conversation, appended to as it happens. */
  chat?: ChatMessage[]
}

export interface HistoryInput {
  analysis: Analysis
  provider: string
  model: string
  hint?: string
  origin?: string
  thumbnail?: string
}

const MAX_ENTRIES = 25

/**
 * Writes as much history as will fit. localStorage is a few MB and thumbnails
 * dominate the payload, so a failed write sheds thumbnails oldest-first, then
 * whole entries — losing detail beats losing the list.
 */
function persist(entries: HistoryEntry[]): HistoryEntry[] {
  let working = entries

  while (working.length > 0) {
    try {
      localStorage.setItem(KEY_HISTORY, JSON.stringify(working))
      return working
    } catch {
      // Entries are newest-first, so the last thumbnail is the oldest one.
      let oldestThumb = -1
      for (let i = working.length - 1; i >= 0; i--) {
        if (working[i].thumbnail) {
          oldestThumb = i
          break
        }
      }
      working =
        oldestThumb >= 0
          ? working.map((e, i) => (i === oldestThumb ? { ...e, thumbnail: undefined } : e))
          : working.slice(0, -1)
    }
  }

  try {
    localStorage.removeItem(KEY_HISTORY)
  } catch {
    // Nothing left to try; history is a nicety, not worth failing the report over.
  }
  return working
}

/** Saved reports, so a reload — or a week later — doesn't lose your work. */
export const historyStore = {
  list(): HistoryEntry[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY_HISTORY) ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((e) => e && e.id && e.analysis) : []
    } catch {
      return []
    }
  },

  add(input: HistoryInput): HistoryEntry {
    const sheet = input.analysis.sheet
    const entry: HistoryEntry = {
      id: historyId(),
      at: Date.now(),
      title: sheet?.title || sheet?.circuitType || 'Schematic',
      summary: input.analysis.summary,
      provider: input.provider,
      model: input.model,
      hint: input.hint || undefined,
      origin: input.origin || undefined,
      thumbnail: input.thumbnail || undefined,
      analysis: input.analysis,
    }
    persist([entry, ...historyStore.list()].slice(0, MAX_ENTRIES))
    return entry
  },

  /** Replaces the stored transcript for one entry. No-op if it's been deleted. */
  setChat(id: string, chat: ChatMessage[]) {
    const entries = historyStore.list()
    if (!entries.some((e) => e.id === id)) return
    persist(entries.map((e) => (e.id === id ? { ...e, chat } : e)))
  },

  remove(id: string): HistoryEntry[] {
    return persist(historyStore.list().filter((e) => e.id !== id))
  },

  clear() {
    localStorage.removeItem(KEY_HISTORY)
  },
}
