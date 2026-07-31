import type { Analysis, AnalyzeInput, ChatInput, Provider } from '../types'
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT, buildUserPrompt } from '../prompt'
import { proxyStore, usingProxy } from '../proxy'

/**
 * Google AI Studio (generativelanguage) supports CORS, so by default we call it
 * straight from the browser with the user's own key. Nothing passes through the
 * host serving this app.
 *
 * Configuring a proxy in Settings gives that up deliberately: one key, held by
 * the Worker, serves everyone who has the passphrase, and every sheet then
 * travels through whoever runs that Worker. Direct remains the default.
 *
 * Model IDs move around; if you get a 404 listing the model, check
 * https://ai.google.dev/gemini-api/docs/models and update DEFAULT_MODEL, or
 * just hit Test in Settings and pick from what the key can actually reach.
 */
const DEFAULT_MODEL = 'gemini-flash-latest'
const GOOGLE_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Builds the URL and auth headers for one call. Direct mode puts the user's key
 * in the query string; proxy mode sends the shared passphrase and lets the
 * Worker attach the key. Everything downstream — friendlyError, the response
 * schema, readSse — is identical either way, which is why the proxy is a URL
 * swap rather than a whole second provider.
 */
function route(path: string, params: Record<string, string>, apiKey = '') {
  const { url: proxy, token } = proxyStore.get()
  const query = new URLSearchParams(params)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (proxy) headers['X-App-Token'] = token
  else query.set('key', apiKey)

  return { url: `${proxy || GOOGLE_ROOT}${path}?${query}`, headers }
}

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

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
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
 * Lists models the key can reach. Doubles as a key test: it isolates "is this
 * key usable at all" from "is this specific model available", which the analyze
 * call alone can't distinguish.
 */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const { url, headers } = route('/models', { pageSize: '200' }, apiKey)
  const res = await fetch(url, { headers })
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

/**
 * Drops connections whose endpoints don't exist. The model is told every edge
 * must reference a real block id and mostly complies, but one hallucinated
 * endpoint would otherwise put a phantom node in the diagram — and a diagram
 * that invents a block is worse than one that omits an edge.
 */
function pruneConnections(parsed: Analysis): Analysis['connections'] {
  const ids = new Set((parsed.blocks ?? []).map((b) => b.id))
  return (parsed.connections ?? []).filter((c) => ids.has(c.from) && ids.has(c.to) && c.from !== c.to)
}

export const geminiProvider: Provider = {
  id: 'gemini',
  label: 'Gemini (Google AI Studio)',
  needsKey: true,

  defaultModel: DEFAULT_MODEL,

  async analyze(input: AnalyzeInput, { apiKey, model, signal }): Promise<Analysis> {
    if (!apiKey && !usingProxy())
      throw new GeminiError('No API key set. Add one in Settings.')
    const chosen = model || DEFAULT_MODEL
    const { url, headers } = route(`/models/${chosen}:generateContent`, {}, apiKey)

    const res = await fetch(
      url,
      {
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
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GeminiError(friendlyError(res.status, body, chosen), res.status)
    }

    const json = await res.json()

    const blocked = json?.promptFeedback?.blockReason
    if (blocked) throw new GeminiError(blockMessage(blocked))

    const candidate = json?.candidates?.[0]
    const text: string | undefined = candidate?.content?.parts?.[0]?.text
    if (!text) {
      const reason = candidate?.finishReason
      if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT')
        throw new GeminiError(blockMessage(reason))
      throw new GeminiError(
        reason === 'MAX_TOKENS'
          ? 'The report was cut off before it finished. A dense sheet can outrun the response limit — crop to one section and run it again.'
          : 'The model returned an empty response.',
      )
    }

    let parsed: Analysis
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new GeminiError('Could not parse the report the model returned.')
    }

    // Structured output guarantees the shape but not the optional arrays.
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
  },

  async chat(input: ChatInput, { apiKey, model, signal }, onDelta): Promise<string> {
    if (!apiKey && !usingProxy())
      throw new GeminiError('No API key set. Add one in Settings.')
    const chosen = model || DEFAULT_MODEL

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

    const { url, headers } = route(
      `/models/${chosen}:streamGenerateContent`,
      { alt: 'sse' },
      apiKey,
    )

    const res = await fetch(
      url,
      {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
          contents,
          safetySettings: SAFETY_SETTINGS,
          generationConfig: { temperature: 0.2 },
        }),
      },
    )

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GeminiError(friendlyError(res.status, body, chosen), res.status)
    }
    if (!res.body) throw new GeminiError('The model returned an empty response.')

    return readSse(res.body, onDelta)
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
  throw new GeminiError(
    `No answer came back${lastReason ? ` (${lastReason})` : ''}. Retry, or check the model in Settings still supports images.`,
  )
}
