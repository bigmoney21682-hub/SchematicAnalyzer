import type { Analysis, AnalyzeInput, ChatInput, Provider } from '../types'
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT, buildUserPrompt } from '../prompt'
import type { Credential } from '../proxy'
import { credentials, quotaStore, route } from '../proxy'
import { withFallbackChain } from './fallback'
import { normalizeAnalysis } from './shape'

/**
 * Google AI Studio (generativelanguage) supports CORS, so a viewer with their
 * own key is called browser-to-Google directly and no sheet touches a server
 * we run. Where the credentials come from, and in what order, is proxy.ts's
 * job; this file just takes the Credential it is handed.
 *
 * Neither the model nor the credential is assumed to work. A retired model, a
 * spent daily quota or a disabled project all get routed around by the chain
 * in fallback.ts rather than surfacing as a dead end, so DEFAULT_MODEL here is
 * a starting point rather than a dependency.
 */
const DEFAULT_MODEL = 'gemini-flash-latest'

const enumConfidence = { type: 'STRING', enum: ['high', 'medium', 'low'] }
const enumEvidence = { type: 'STRING', enum: ['labelled', 'symbol', 'inferred', 'guess'] }
const enumSignalKind = {
  type: 'STRING',
  enum: ['digital', 'analog', 'clock', 'bus', 'feedback', 'control', 'sense', 'rf', 'audio', 'power'],
}
const enumBlockKind = {
  type: 'STRING',
  enum: [
    'power-in',
    'power-conv',
    'protection',
    'control',
    'analog',
    'digital',
    'interface',
    'sensor',
    'drive',
    'output',
    'indicator',
    'other',
  ],
}
const stringArray = { type: 'ARRAY', items: { type: 'STRING' } }

/**
 * Schematics trip the safety filters rarely, but a service manual page can
 * carry warning iconography and text about electric shock and death that a
 * general-purpose filter reads as dangerous content. BLOCK_ONLY_HIGH keeps
 * genuinely harmful content blocked while letting a mains warning through.
 */
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))

/** Structured-output schema. Keeps us from having to parse prose. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    isSchematic: { type: 'BOOLEAN' },
    sheet: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        equipment: { type: 'STRING' },
        circuitType: { type: 'STRING' },
        sheetRef: { type: 'STRING' },
        language: { type: 'STRING' },
      },
      required: ['title', 'circuitType'],
    },
    confidence: enumConfidence,
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          label: { type: 'STRING' },
          kind: enumBlockKind,
          parts: stringArray,
          detail: { type: 'STRING' },
          rails: stringArray,
        },
        required: ['id', 'label', 'kind', 'detail'],
      },
    },
    connections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          from: { type: 'STRING' },
          to: { type: 'STRING' },
          label: { type: 'STRING' },
          kind: enumSignalKind,
          evidence: enumEvidence,
          confidence: enumConfidence,
        },
        required: ['from', 'to', 'label', 'kind', 'evidence', 'confidence'],
      },
    },
    powerRails: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          voltage: { type: 'STRING' },
          kind: {
            type: 'STRING',
            enum: ['input', 'derived', 'reference', 'standby', 'bias'],
          },
          source: { type: 'STRING' },
          derivedFrom: { type: 'STRING' },
          feeds: stringArray,
          testPoint: { type: 'STRING' },
          notes: { type: 'STRING' },
          evidence: enumEvidence,
          confidence: enumConfidence,
        },
        required: ['name', 'kind', 'evidence', 'confidence'],
      },
    },
    grounds: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          kind: {
            type: 'STRING',
            enum: ['signal', 'power', 'chassis', 'earth', 'isolated', 'floating', 'analog'],
          },
          detail: { type: 'STRING' },
          tiedTo: { type: 'STRING' },
          confidence: enumConfidence,
        },
        required: ['name', 'kind', 'detail', 'confidence'],
      },
    },
    indicators: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          label: { type: 'STRING' },
          color: { type: 'STRING' },
          drivenBy: { type: 'STRING' },
          rail: { type: 'STRING' },
          states: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { state: { type: 'STRING' }, means: { type: 'STRING' } },
              required: ['state', 'means'],
            },
          },
          evidence: enumEvidence,
          confidence: enumConfidence,
        },
        required: ['states', 'evidence', 'confidence'],
      },
    },
    testPoints: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          label: { type: 'STRING' },
          where: { type: 'STRING' },
          measure: { type: 'STRING' },
          expected: { type: 'STRING' },
          meaning: { type: 'STRING' },
          confidence: enumConfidence,
        },
        required: ['where', 'measure', 'meaning', 'confidence'],
      },
    },
    signals: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          kind: enumSignalKind,
          from: { type: 'STRING' },
          to: { type: 'STRING' },
          levels: { type: 'STRING' },
          detail: { type: 'STRING' },
          evidence: enumEvidence,
          confidence: enumConfidence,
        },
        required: ['name', 'kind', 'from', 'to', 'detail', 'evidence', 'confidence'],
      },
    },
    connectors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          label: { type: 'STRING' },
          kind: { type: 'STRING' },
          pins: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                pin: { type: 'STRING' },
                name: { type: 'STRING' },
                detail: { type: 'STRING' },
              },
              required: ['pin', 'name'],
            },
          },
          mates: { type: 'STRING' },
          confidence: enumConfidence,
        },
        required: ['pins', 'confidence'],
      },
    },
    components: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          part: { type: 'STRING' },
          value: { type: 'STRING' },
          role: { type: 'STRING' },
          block: { type: 'STRING' },
          evidence: enumEvidence,
          confidence: enumConfidence,
        },
        required: ['role', 'evidence', 'confidence'],
      },
    },
    theoryOfOperation: stringArray,
    safetyNotes: stringArray,
    unreadable: stringArray,
    notes: stringArray,
  },
  required: ['summary', 'isSchematic', 'sheet', 'confidence', 'blocks', 'connections', 'powerRails'],
}

export class GeminiError extends Error {
  // A plain field rather than a constructor parameter property: the app
  // compiles with erasableSyntaxOnly, which rules out the shorthand.
  status?: number
  /** Whether trying a different model or key is worth doing — see fallback.ts. */
  retryable: boolean

  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
    this.retryable = retryable
  }
}

/** Pulls Google's own error text out of the response body. */
function googleMessage(body: string): string {
  try {
    return JSON.parse(body)?.error?.message ?? ''
  } catch {
    return ''
  }
}

function friendlyError(status: number, body: string, model = DEFAULT_MODEL): string {
  const detail = googleMessage(body)
  const suffix = detail ? `\n\nGoogle said: ${detail}` : ''

  if (/no longer available|not found|is not supported/i.test(detail))
    return (
      `Model "${model}" is retired or unavailable to your key. Open Settings, hit ` +
      'Test, and pick a model from the list — that list comes from your key, so ' +
      'anything in it will work.' + suffix
    )

  if (status === 400 && /API key not valid/i.test(body))
    return (
      'Google does not recognise this key at all. This specific error means the ' +
      'key string itself is not valid — a disabled API or a restricted key would ' +
      'return a different error. So:\n\n' +
      '• Check the whole key was copied. Truncated selections are the usual cause.\n' +
      '• Check it has not been deleted or regenerated at aistudio.google.com/apikey.\n' +
      '• Make sure it is an AI Studio key, not a key for some other Google service.\n\n' +
      'The character check above the Test button catches malformed keys.' +
      suffix
    )
  if (status === 403 && /SERVICE_DISABLED|has not been used in project/i.test(body))
    return (
      'The key is valid but the Generative Language API is not enabled on its ' +
      'Google Cloud project. Enable it, or make a fresh key at ' +
      'aistudio.google.com/apikey which comes with it enabled.' + suffix
    )
  if (status === 403 && /blocked|referer|referrer/i.test(body))
    return (
      'The key is valid but restricted. If you set an HTTP referrer restriction, ' +
      "this site's URL must be on the allowed list; if you set an API restriction, " +
      'it must include the Generative Language API.' + suffix
    )
  if (status === 403) return `Access denied.${suffix}`
  if (status === 413)
    return (
      'The sheet is too large for the API. Crop to the section you care about — ' +
      'a quarter of an A1 drawing read properly beats the whole page read badly.' +
      suffix
    )
  if (status === 429)
    return 'Rate limited — the free tier has a per-minute cap. Wait a moment and try again.' + suffix
  if (status === 404)
    return (
      `Model "${model}" is not available to your key. Open Settings, hit Test, and ` +
      'pick a model from the list.' + suffix
    )
  if (status >= 500) return 'Google returned a server error. Usually transient — try again.' + suffix
  return `Request failed (HTTP ${status}).${suffix}`
}

/**
 * Whether a different model could plausibly succeed where this one failed.
 *
 * The line to hold: faults that belong to the model are worth routing around,
 * faults that belong to the key or the request are not. A 401, a disabled API,
 * a restricted key or an oversized sheet will fail exactly the same way on
 * every model in the list.
 */
function retryableStatus(status: number, body: string): boolean {
  const detail = googleMessage(body)

  // Retired, invisible to this key, or not multimodal — all per-model facts.
  if (status === 404) return true
  if (/no longer available|not found|is not supported|does not support/i.test(detail)) return true

  // Free-tier quota is metered per model, so the next one down has its own.
  if (status === 429) return true

  // Capacity trouble is rarely uniform across the fleet.
  if (status >= 500) return true

  return false
}

/**
 * Lists models the key can reach. Doubles as a key test: it isolates "is this
 * key usable at all" from "is this specific model available", which the analyze
 * call alone can't distinguish.
 */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const [first] = credentials('gemini', apiKey)
  if (!first) throw new GeminiError('No API key set. Add one in Settings.')
  return listModelsOn(first)
}

/** The same listing, on one specific credential — what the fallback chain
 *  needs, since each credential can reach a different set of models. */
async function listModelsOn(cred: Credential): Promise<string[]> {
  const { url, headers } = route(cred, '/models', { pageSize: '200' })
  const res = await fetch(url, { headers })
  quotaStore.readFrom(res)
  if (!res.ok) throw new GeminiError(friendlyError(res.status, await res.text().catch(() => '')))
  const json = await res.json()
  return (json?.models ?? [])
    .filter((m: { supportedGenerationMethods?: string[] }) =>
      m.supportedGenerationMethods?.includes('generateContent'),
    )
    .map((m: { name: string }) => m.name.replace(/^models\//, ''))
    .sort()
}

/** Turns a safety block into something that says what to do about it. */
function blockMessage(reason: string): string {
  if (/SAFETY/i.test(reason))
    return (
      "Google's safety filter blocked this page. Service-manual sheets carry " +
      'shock-hazard warnings and death-risk text that can trip it. Cropping to ' +
      'the circuit itself, away from the warning panel, usually gets through.'
    )
  if (/PROHIBITED_CONTENT|BLOCKLIST/i.test(reason))
    return 'Google refused this request outright. Nothing to tune here — try a different page.'
  return `Request blocked by Google (${reason}).`
}


/** The chain to run, or a clear error if there is nothing in it. */
function requireCredentials(apiKey: string | undefined): Credential[] {
  const chain = credentials('gemini', apiKey)
  if (!chain.length)
    throw new GeminiError(
      'No way to reach the model. Add your own API key in Settings, or turn the ' +
        'shared service back on.',
    )
  return chain
}

/**
 * One analyze attempt against one model on one credential. Split out of the
 * provider so the fallback chain can run it against each candidate in turn.
 */
async function runAnalyze(
  input: AnalyzeInput,
  cred: Credential,
  chosen: string,
  signal: AbortSignal | undefined,
): Promise<Analysis> {
  const { url, headers } = route(cred, `/models/${chosen}:generateContent`)

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildUserPrompt(input.hint) },
            { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
          ],
        },
      ],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        // Near-deterministic. Reading designators off a sheet is a
        // transcription task, and sampling breadth only invents values.
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  })

  // Proxied responses carry the shared allowance; direct ones carry nothing
  // and this is a no-op. Read before the status check so a 429 still updates
  // the meter that explains it.
  quotaStore.readFrom(res)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GeminiError(
      friendlyError(res.status, body, chosen),
      res.status,
      retryableStatus(res.status, body),
    )
  }

  const json = await res.json()

  // A safety block is a judgement about the sheet, not a fault in the model,
  // so it stops the chain rather than sending the same image round again.
  const blocked = json?.promptFeedback?.blockReason
  if (blocked) throw new GeminiError(blockMessage(blocked))

  const candidate = json?.candidates?.[0]
  const text: string | undefined = candidate?.content?.parts?.[0]?.text
  if (!text) {
    const reason = candidate?.finishReason
    if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT')
      throw new GeminiError(blockMessage(reason))
    if (reason === 'MAX_TOKENS')
      throw new GeminiError(
        'The report was cut off before it finished. A dense sheet can outrun the response limit — crop to one section and run it again.',
      )
    // No text and no stated reason: the model misbehaved. Another one may not.
    throw new GeminiError('The model returned an empty response.', undefined, true)
  }

  let parsed: Analysis
  try {
    parsed = JSON.parse(text)
  } catch {
    // Ignoring the response schema is a model failing at its job — worth
    // handing to the next one down rather than showing the user a dead end.
    throw new GeminiError('Could not parse the report the model returned.', undefined, true)
  }

  // Structured output guarantees the shape but not the optional arrays.
  return normalizeAnalysis(parsed)
}

/**
 * One chat attempt against one model on one credential.
 *
 * The streaming makes this different from analyze: once a fragment has been
 * painted into the transcript, restarting on another model would splice two
 * different answers together mid-sentence. So the moment anything is emitted
 * the attempt stops being retryable, whatever went wrong afterwards.
 */
async function runChat(
  input: ChatInput,
  cred: Credential,
  chosen: string,
  signal: AbortSignal | undefined,
  onDelta?: (text: string) => void,
): Promise<string> {
  // The sheet and the report ride along on the first turn, so every answer is
  // grounded in what was actually drawn rather than in the transcript alone.
  const opening = [
    { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
    { text: buildUserPrompt(input.hint) },
  ]
  const report = {
    role: 'model',
    parts: [{ text: `My structured report on this schematic:\n${JSON.stringify(input.analysis)}` }],
  }

  const contents = [
    { role: 'user', parts: opening },
    report,
    ...input.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
  ]

  const { url, headers } = route(cred, `/models/${chosen}:streamGenerateContent`, { alt: 'sse' })

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
      contents,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: { temperature: 0.2 },
    }),
  })

  // Proxied responses carry the shared allowance; direct ones carry nothing
  // and this is a no-op. Read before the status check so a 429 still updates
  // the meter that explains it.
  quotaStore.readFrom(res)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GeminiError(
      friendlyError(res.status, body, chosen),
      res.status,
      retryableStatus(res.status, body),
    )
  }
  if (!res.body) throw new GeminiError('The model returned an empty response.', undefined, true)

  let emitted = false
  try {
    return await readSse(res.body, (text) => {
      emitted = true
      onDelta?.(text)
    })
  } catch (e) {
    if (emitted && e instanceof GeminiError) throw new GeminiError(e.message, e.status, false)
    throw e
  }
}

export const geminiProvider: Provider = {
  id: 'gemini',
  label: 'Gemini (Google AI Studio)',
  needsKey: true,

  defaultModel: DEFAULT_MODEL,

  async analyze(
    input: AnalyzeInput,
    { apiKey, model, signal, onModel, onCredential },
  ): Promise<Analysis> {
    return withFallbackChain({
      credentials: requireCredentials(apiKey),
      first: model || DEFAULT_MODEL,
      listModels: listModelsOn,
      onModel,
      onCredential,
      onFallback: ({ from, to, reason }) =>
        console.info(`[gemini] ${from} refused this sheet, retrying on ${to}. ${reason}`),
      attempt: (cred, chosen) => runAnalyze(input, cred, chosen, signal),
    })
  },

  async chat(
    input: ChatInput,
    { apiKey, model, signal, onModel, onCredential },
    onDelta,
  ): Promise<string> {
    return withFallbackChain({
      credentials: requireCredentials(apiKey),
      first: model || DEFAULT_MODEL,
      listModels: listModelsOn,
      onModel,
      onCredential,
      onFallback: ({ from, to, reason }) =>
        console.info(`[gemini] ${from} could not answer, retrying on ${to}. ${reason}`),
      attempt: (cred, chosen) => runChat(input, cred, chosen, signal, onDelta),
    })
  },
}

/**
 * Gemini's SSE stream is one `data: {json}` per event. Events can be split
 * across reads, so we buffer to the last complete blank-line boundary rather
 * than assuming a chunk holds whole events.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let blockedBy = ''
  let lastReason = ''

  /** Pulls whole events off the buffer. Google delimits with CRLFCRLF, the SSE
   *  spec allows either, so normalising the line endings up front is what makes
   *  this work at all — splitting on a bare "\n\n" silently matches nothing in
   *  a CRLF stream and drops the entire response. */
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

  function handle(event: string) {
    const payload = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!payload || payload === '[DONE]') return

    try {
      const json = JSON.parse(payload)
      const candidate = json?.candidates?.[0]
      const reason = json?.promptFeedback?.blockReason ?? candidate?.finishReason
      if (reason) lastReason = reason
      if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') blockedBy = reason

      for (const part of candidate?.content?.parts ?? []) {
        // Thinking models emit reasoning as parts flagged `thought`. That is
        // scratch work, not the answer, and must not reach the transcript.
        if (part?.thought === true) continue
        if (typeof part?.text !== 'string' || !part.text) continue
        full += part.text
        onDelta?.(part.text)
      }
    } catch {
      // A malformed event is not worth losing the rest of the answer over.
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
  if (blockedBy) throw new GeminiError(blockMessage(blockedBy))
  if (lastReason === 'MAX_TOKENS')
    throw new GeminiError('The answer was cut off before any of it arrived. Try a shorter question.')
  // Nothing was emitted, so the fallback chain is free to try another model.
  throw new GeminiError(
    `No answer came back${lastReason ? ` (${lastReason})` : ''}. Retry, or check the model in Settings still supports images.`,
    undefined,
    true,
  )
}
