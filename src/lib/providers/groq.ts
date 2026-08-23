import type { Analysis, AnalyzeInput, ChatInput, Provider } from '../types'
import {
  CHAT_SYSTEM_PROMPT,
  JSON_SHAPE_INSTRUCTION,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from '../prompt'
import type { Credential } from '../proxy'
import { credentials, quotaStore, route } from '../proxy'
import { withFallbackChain } from './fallback'
import { normalizeAnalysis } from './shape'

/**
 * Groq, via its OpenAI-compatible endpoint.
 *
 * Here as a second vendor, so that every Gemini key being spent is not the end
 * of the analysis. It is deliberately the fallback rather than the default:
 * Gemini's structured-output mode constrains the response to a schema, while
 * this has to ask for JSON in the prompt and hope, which is a weaker guarantee
 * on a report someone is going to work from at a bench.
 *
 * ONE CAVEAT worth knowing. Groq sends no CORS headers, so a browser cannot
 * call it directly — a viewer's own Groq key will fail with an opaque "Failed
 * to fetch" no matter how valid it is. The proxy is the only route that works,
 * which is why worker/ mounts Groq under /groq. We detect the browser's
 * rejection below and say so, because the raw message is useless.
 *
 * Model IDs move: Groq retired the Llama 4 vision models in February 2026 and
 * pointed multimodal users at Qwen. DEFAULT_MODEL is only a starting point —
 * a decommissioned ID sends the fallback chain down the list of models the
 * credential can actually reach.
 */
const DEFAULT_MODEL = 'qwen/qwen3.6-27b'

export class GroqError extends Error {
  // Plain fields rather than constructor parameter properties: the app
  // compiles with erasableSyntaxOnly, which rules out the shorthand.
  status?: number
  /** Whether trying a different model or key is worth doing — see fallback.ts. */
  retryable: boolean

  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'GroqError'
    this.status = status
    this.retryable = retryable
  }
}

const CORS_HELP =
  'The browser blocked the request to Groq. Groq does not send CORS headers, ' +
  'so a static site cannot call it directly with your own key. Use the shared ' +
  'service or a proxy — both route Groq through worker/, which is not subject ' +
  'to that limit.'

/** Distinguishes a CORS/network rejection from a real HTTP error response. */
function asNetworkError(e: unknown): never {
  if (e instanceof DOMException && e.name === 'AbortError') throw e
  if (e instanceof TypeError) throw new GroqError(CORS_HELP)
  throw e
}

/** Pulls Groq's own error text out of the response body. */
function groqMessage(body: string): string {
  try {
    return JSON.parse(body)?.error?.message ?? ''
  } catch {
    return ''
  }
}

function friendlyError(status: number, body: string, model = DEFAULT_MODEL): string {
  const detail = groqMessage(body)
  const suffix = detail ? `\n\nGroq said: ${detail}` : ''

  if (status === 401) return 'Groq rejected that API key. Keys from console.groq.com start with "gsk_".' + suffix
  if (status === 404 || /model_not_found|does not exist|decommissioned/i.test(body))
    return `Model "${model}" is not available — Groq may have retired it.` + suffix
  if (/does not support image|vision|multimodal/i.test(body))
    return `Model "${model}" does not accept images.` + suffix
  if (status === 413) return 'The sheet is too large for Groq. Try a tighter crop.' + suffix
  if (status === 429) return 'Rate limited by Groq. Wait a moment and try again.' + suffix
  if (status >= 500) return 'Groq returned a server error. Usually transient — try again.' + suffix
  return `Groq request failed (HTTP ${status}).${suffix}`
}

/** Whether a different model could plausibly succeed where this one failed.
 *  Same line as the Gemini adapter: model-shaped faults are worth routing
 *  around, key- and request-shaped ones are not. */
function retryableStatus(status: number, body: string): boolean {
  if (status === 404 || status === 429 || status >= 500) return true
  if (/model_not_found|decommissioned|does not support image|vision|multimodal/i.test(body))
    return true
  return false
}

/** Lists models the credential can reach, so a retired ID has somewhere to go. */
export async function listGroqModels(apiKey: string): Promise<string[]> {
  const [first] = credentials('groq', apiKey)
  if (!first) throw new GroqError('No API key set. Add one in Settings.')
  return listModelsOn(first)
}

async function listModelsOn(cred: Credential): Promise<string[]> {
  const { url, headers } = route(cred, '/models', {}, 'bearer')
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (e) {
    asNetworkError(e)
  }
  quotaStore.readFrom(res)
  if (!res.ok) throw new GroqError(friendlyError(res.status, await res.text().catch(() => '')))
  const json = await res.json()
  return (json?.data ?? []).map((m: { id: string }) => m.id).sort()
}

/** The chain to run, or a clear error if there is nothing in it. */
function requireCredentials(apiKey: string | undefined): Credential[] {
  const chain = credentials('groq', apiKey)
  if (!chain.length)
    throw new GroqError(
      'No way to reach Groq. Add a Groq key in Settings, or turn the shared service on.',
    )
  return chain
}

/** The image and instructions, shaped the way an OpenAI-compatible chat API
 *  wants them. Shared by the analyze and chat paths. */
function imageTurn(input: { imageBase64: string; mimeType: string; hint?: string }) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: buildUserPrompt(input.hint) },
      {
        type: 'image_url',
        image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
      },
    ],
  }
}

async function post(
  cred: Credential,
  signal: AbortSignal | undefined,
  body: Record<string, unknown>,
  chosen: string,
): Promise<Response> {
  const { url, headers } = route(cred, '/chat/completions', {}, 'bearer')

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) })
  } catch (e) {
    asNetworkError(e)
  }

  quotaStore.readFrom(res)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new GroqError(
      friendlyError(res.status, text, chosen),
      res.status,
      retryableStatus(res.status, text),
    )
  }
  return res
}

/** One analyze attempt against one model on one credential. */
async function runAnalyze(
  input: AnalyzeInput,
  cred: Credential,
  chosen: string,
  signal: AbortSignal | undefined,
): Promise<Analysis> {
  const res = await post(
    cred,
    signal,
    {
      model: chosen,
      // Near-deterministic. Reading designators off a sheet is a
      // transcription task, and sampling breadth only invents values.
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${JSON_SHAPE_INSTRUCTION}` },
        imageTurn(input),
      ],
    },
    chosen,
  )

  const json = await res.json()
  const text: string | undefined = json?.choices?.[0]?.message?.content
  if (!text) throw new GroqError('Groq returned an empty response.', undefined, true)

  let parsed: Analysis
  try {
    parsed = JSON.parse(text)
  } catch {
    // JSON mode is a request, not a guarantee, the way Gemini's schema is.
    // A model that ignores it is worth handing to the next one down.
    throw new GroqError('Could not parse the report Groq returned as JSON.', undefined, true)
  }

  // Nothing here is guaranteed by the API — JSON mode is a request, not a
  // schema — so the same normalisation the Gemini path uses applies here.
  return normalizeAnalysis(parsed)
}

/**
 * One chat attempt. As with Gemini, the moment a fragment reaches the
 * transcript the attempt stops being retryable — restarting elsewhere would
 * splice two different answers together mid-sentence.
 */
async function runChat(
  input: ChatInput,
  cred: Credential,
  chosen: string,
  signal: AbortSignal | undefined,
  onDelta?: (text: string) => void,
): Promise<string> {
  const res = await post(
    cred,
    signal,
    {
      model: chosen,
      temperature: 0.2,
      stream: true,
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        imageTurn(input),
        {
          role: 'assistant',
          content: `My structured report on this sheet:\n${JSON.stringify(input.analysis)}`,
        },
        ...input.messages.map((m) => ({
          role: m.role === 'model' ? 'assistant' : 'user',
          content: m.text,
        })),
      ],
    },
    chosen,
  )

  if (!res.body) throw new GroqError('Groq returned an empty response.', undefined, true)

  let emitted = false
  try {
    return await readSse(res.body, (text) => {
      emitted = true
      onDelta?.(text)
    })
  } catch (e) {
    if (emitted && e instanceof GroqError) throw new GroqError(e.message, e.status, false)
    throw e
  }
}

export const groqProvider: Provider = {
  id: 'groq',
  label: 'Groq (OpenAI-compatible)',
  needsKey: true,

  defaultModel: DEFAULT_MODEL,

  async analyze(input, { apiKey, model, signal, onModel, onCredential }): Promise<Analysis> {
    return withFallbackChain({
      credentials: requireCredentials(apiKey),
      first: model || DEFAULT_MODEL,
      listModels: listModelsOn,
      onModel,
      onCredential,
      onFallback: ({ from, to, reason }) =>
        console.info(`[groq] ${from} refused this sheet, retrying on ${to}. ${reason}`),
      attempt: (cred, chosen) => runAnalyze(input, cred, chosen, signal),
    })
  },

  async chat(input, { apiKey, model, signal, onModel, onCredential }, onDelta): Promise<string> {
    return withFallbackChain({
      credentials: requireCredentials(apiKey),
      first: model || DEFAULT_MODEL,
      listModels: listModelsOn,
      onModel,
      onCredential,
      onFallback: ({ from, to, reason }) =>
        console.info(`[groq] ${from} could not answer, retrying on ${to}. ${reason}`),
      attempt: (cred, chosen) => runChat(input, cred, chosen, signal, onDelta),
    })
  },
}

/**
 * OpenAI-style SSE: one `data: {json}` per event, terminated by `data: [DONE]`.
 * Simpler than Gemini's — the delta is always at choices[0].delta.content —
 * but the same buffering rule applies, since an event can be split across
 * reads.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let finish = ''

  function handle(event: string) {
    const payload = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!payload || payload === '[DONE]') return

    try {
      const json = JSON.parse(payload)
      const choice = json?.choices?.[0]
      if (choice?.finish_reason) finish = choice.finish_reason
      const text = choice?.delta?.content
      if (typeof text === 'string' && text) {
        full += text
        onDelta?.(text)
      }
    } catch {
      // A malformed event is not worth losing the rest of the answer over.
    }
  }

  function drain(flush: boolean) {
    buffer = buffer.replace(/\r\n/g, '\n')
    let cut: number
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      handle(buffer.slice(0, cut))
      buffer = buffer.slice(cut + 2)
    }
    // The final event often arrives without its trailing blank line.
    if (flush && buffer.trim()) {
      handle(buffer)
      buffer = ''
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain(false)
    }
    buffer += decoder.decode()
    drain(true)
  } finally {
    reader.cancel().catch(() => {})
  }

  if (full) return full
  if (finish === 'length')
    throw new GroqError('The answer was cut off before any of it arrived. Try a shorter question.')
  // Nothing was emitted, so the fallback chain is free to try another model.
  throw new GroqError(
    `No answer came back${finish ? ` (${finish})` : ''}. Retry, or pick another model in Settings.`,
    undefined,
    true,
  )
}
