import type { Analysis, AnalyzeInput, AnalyzeOptions, ChatInput, Provider } from '../types'
import { reachable } from '../proxy'
import { apiKeyStore } from '../storage'
import { isRetryable } from './fallback'
import { geminiProvider, listGeminiModels } from './gemini'
import { groqProvider, listGroqModels } from './groq'
import { mockProvider } from './mock'

export const providers: Provider[] = [geminiProvider, groqProvider, mockProvider]

export function getProvider(id: string): Provider {
  return providers.find((p) => p.id === id) ?? geminiProvider
}

/** Key test / model discovery, for providers that support it. */
export const modelListers: Record<string, (apiKey: string) => Promise<string[]>> = {
  gemini: listGeminiModels,
  groq: listGroqModels,
}

// Ranking lives in rank.ts so the providers can share it — they cannot import
// this module without a cycle. Re-exported here because that is where the rest
// of the app has always looked for it.
export { pickDefaultModel, rankModels, scoreModel } from './rank'

export { geminiProvider, groqProvider, mockProvider }

/**
 * The outermost fallback: vendors.
 *
 * Under this sit two more chains, both in fallback.ts — credentials within a
 * vendor, and models within a credential. Three levels sounds like a lot until
 * you notice they fail for unrelated reasons: a model is retired, a key is
 * spent, a whole vendor is having an afternoon. Each level only exists because
 * the one below it cannot fix that class of problem.
 *
 * Demo mode is never entered automatically. Someone reading a report needs to
 * know it came from a real model, and silently substituting canned output for
 * a genuine outage is the one failure mode worse than an error message.
 */
function vendorChain(providerId: string): Provider[] {
  const chosen = getProvider(providerId)
  if (chosen.id === mockProvider.id) return [chosen]

  const alternates = providers.filter(
    (p) =>
      p.id !== chosen.id &&
      p.id !== mockProvider.id &&
      // Only vendors something can actually authenticate to. Groq with no key
      // and no proxy would just CORS-fail, which is not a useful fallback.
      reachable(p.id, apiKeyStore.get(p.id)),
  )

  return [chosen, ...alternates]
}

/** Runs `attempt` against each vendor in turn, stopping at the first that
 *  either succeeds or fails for a reason another vendor would share. */
async function acrossVendors<T>(
  providerId: string,
  opts: AnalyzeOptions,
  attempt: (provider: Provider, opts: AnalyzeOptions) => Promise<T>,
): Promise<T> {
  const chain = vendorChain(providerId)
  let firstError: unknown

  for (const provider of chain) {
    // Each vendor authenticates with its own key, not the one the UI happens
    // to have in hand for the provider the user picked.
    const apiKey = provider.id === providerId ? opts.apiKey : apiKeyStore.get(provider.id)
    // A model ID is vendor-specific; carrying "gemini-flash-latest" over to
    // Groq would guarantee a 404 on the first attempt of every fallback.
    const model = provider.id === providerId ? opts.model : ''

    try {
      const result = await attempt(provider, { ...opts, apiKey, model })
      // Announced on success only, like onModel and onCredential — the caller
      // wants the vendor that produced the answer, not each one that was tried.
      opts.onProvider?.(provider.id)
      return result
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (!isRetryable(e)) throw e
      // The first vendor's failure is the one to keep: it is the provider the
      // user actually chose, so it is the only one whose error they can act
      // on. A fallback vendor complaining about its own misconfiguration is
      // true but useless — it sends them after a setting that is not theirs.
      if (firstError === undefined) firstError = e
    }
  }

  throw firstError ?? new Error('No provider is configured. Add an API key in Settings.')
}

/** Analyze with the full three-level fallback. What the app should call. */
export function analyze(
  providerId: string,
  input: AnalyzeInput,
  opts: AnalyzeOptions,
): Promise<Analysis> {
  return acrossVendors(providerId, opts, (provider, o) => provider.analyze(input, o))
}

/** The same, for a follow-up question. */
export function chat(
  providerId: string,
  input: ChatInput,
  opts: AnalyzeOptions,
  onDelta?: (text: string) => void,
): Promise<string> {
  return acrossVendors(providerId, opts, (provider, o) => provider.chat(input, o, onDelta))
}
