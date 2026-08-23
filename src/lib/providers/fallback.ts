import type { Credential } from '../proxy'
import { rankModels } from './rank'

/**
 * Model-level fallback.
 *
 * One hardcoded model is the most common way this app breaks for someone who
 * did nothing wrong. Google retires an ID, the free tier's per-minute cap
 * trips, or a key simply cannot reach the model we asked for — and all three
 * surface as a dead end the user can only clear by opening Settings and
 * guessing at a replacement.
 *
 * So a refusal is no longer the end of the attempt. We walk down the ranked
 * list of models the key can actually reach and try the next one. Retirements
 * are per-model, quotas are counted per-model, and the ranking already knows
 * which alternates suit this task, so the second attempt is usually the last
 * one needed.
 *
 * Only faults another model could plausibly fix get retried. A bad key, a
 * disabled API, or a safety block fails identically everywhere, and spending
 * four more requests to prove that just makes the error slower to arrive.
 */

/** Total attempts including the first. Past five the user is waiting longer
 *  than a clear error is worth. */
export const MAX_ATTEMPTS = 5

/** Providers set this on errors where a different model is worth a shot. */
export interface RetryableError {
  retryable?: boolean
}

export function isRetryable(err: unknown): boolean {
  return (err as RetryableError | null)?.retryable === true
}

export interface FallbackNotice {
  from: string
  to: string
  /** Why we moved on — already user-readable, straight off the error. */
  reason: string
}

export interface FallbackOptions<T> {
  /** The model the user picked, or the provider default. Always tried first. */
  first: string
  /** Fetches the models this key can reach. Called at most once, and only
   *  after something has already failed, so a healthy run costs nothing. */
  listModels: () => Promise<string[]>
  attempt: (model: string) => Promise<T>
  onFallback?: (notice: FallbackNotice) => void
  /** Fires with the model that actually produced the result. */
  onModel?: (model: string) => void
  /** Shared request budget when this chain is nested inside a longer one. */
  budget?: { left: number }
}

export async function withModelFallback<T>({
  first,
  listModels,
  attempt,
  onFallback,
  onModel,
  budget = { left: MAX_ATTEMPTS },
}: FallbackOptions<T>): Promise<T> {
  const tried = new Set<string>()
  let alternates: string[] | null = null
  let current = first
  let lastError: unknown

  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    if (budget.left <= 0) break
    budget.left--
    tried.add(current)
    try {
      const result = await attempt(current)
      onModel?.(current)
      return result
    } catch (e) {
      // Cancelling is the user's decision, not a fault to route around.
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (!isRetryable(e)) throw e
      lastError = e

      if (alternates === null) {
        try {
          alternates = rankModels(await listModels())
        } catch {
          // If we can't even list the alternatives, the original error is the
          // honest one to show — not a complaint about the model list.
          throw e
        }
      }

      const next = alternates.find((m) => !tried.has(m))
      if (!next) throw e

      onFallback?.({
        from: current,
        to: next,
        reason: e instanceof Error ? e.message : String(e),
      })
      current = next
    }
  }

  // Only reachable by running out of budget mid-chain; otherwise the loop
  // returns or rethrows. Surfacing the real fault beats a generic message.
  throw lastError ?? new Error(`Gave up after ${MAX_ATTEMPTS} models.`)
}


/**
 * Credential-level fallback, wrapped around the model chain.
 *
 * Two things can be exhausted independently: a model (retired, rate-limited)
 * and a key (daily cap spent, project disabled). Walking models under one key
 * cannot fix a spent key, and swapping keys cannot fix a retired model — so
 * the chains nest. Every model is tried on the viewer's own key before the
 * shared pool is touched, which keeps the owner's quota as the last resort
 * rather than the first.
 *
 * The budget is what stops the nesting from turning a bad day into a
 * half-minute of silent retrying: two credentials times five models is ten
 * round trips, and nobody is waiting that long for an error.
 */
export const MAX_REQUESTS = 7

export interface ChainOptions<T> {
  credentials: Credential[]
  /** The model the user picked, or the provider default. */
  first: string
  listModels: (cred: Credential) => Promise<string[]>
  attempt: (cred: Credential, model: string) => Promise<T>
  onFallback?: (notice: FallbackNotice) => void
  onModel?: (model: string) => void
  /** Fires when the chain gives up on one credential and moves to the next. */
  onCredential?: (cred: Credential) => void
}

export async function withFallbackChain<T>({
  credentials,
  first,
  listModels,
  attempt,
  onFallback,
  onModel,
  onCredential,
}: ChainOptions<T>): Promise<T> {
  const budget = { left: MAX_REQUESTS }
  let lastError: unknown

  for (const cred of credentials) {
    if (budget.left <= 0) break
    try {
      const result = await withModelFallback({
        first,
        budget,
        listModels: () => listModels(cred),
        attempt: (model) => attempt(cred, model),
        onFallback,
        onModel,
      })
      onCredential?.(cred)
      return result
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (!isRetryable(e)) throw e
      lastError = e
    }
  }

  throw lastError ?? new Error('No credentials are configured. Add an API key in Settings.')
}
