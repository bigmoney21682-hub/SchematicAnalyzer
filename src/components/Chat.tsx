import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getProvider } from '../lib/providers'
import { usingProxy } from '../lib/proxy'
import type { Analysis, ChatMessage } from '../lib/types'

interface Props {
  /** The sheet the report was made from. Null disables the whole panel. */
  image: { base64: string; mimeType: string } | null
  analysis: Analysis
  hint?: string
  providerId: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  onChange: (messages: ChatMessage[]) => void
  /** Shown above the log, e.g. when answering against a stored thumbnail. */
  note?: string
}

/**
 * Openers aimed at what someone actually stands in front of the board wanting
 * to know. Fault-finding first — that is the job the report is a means to.
 */
const SUGGESTIONS = [
  'It has no power at all. Where do I start?',
  'Which parts of this are at mains potential?',
  'Walk me through the regulation loop step by step.',
  'What would I measure to prove the regulator is dead?',
  'What does each LED tell me at power-up?',
]

export function Chat({
  image,
  analysis,
  hint,
  providerId,
  apiKey,
  model,
  messages,
  onChange,
  note,
}: Props) {
  const [draft, setDraft] = useState('')
  // Non-null while a request is in flight; holds the answer built so far.
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  // Follow the stream, but only when the user is already near the bottom —
  // yanking the view away mid-read to chase new tokens is worse than nothing.
  useLayoutEffect(() => {
    const log = logRef.current
    if (!log) return
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight
    if (distance < 120) log.scrollTop = log.scrollHeight
  }, [messages, streaming])

  const busy = streaming !== null

  async function send(text: string) {
    const question = text.trim()
    if (!question || busy || !image) return

    const provider = getProvider(providerId)
    if (provider.needsKey && !apiKey && !usingProxy()) {
      setError('Add an API key in Settings first, or switch to Demo mode.')
      return
    }

    const asked: ChatMessage[] = [...messages, { role: 'user', text: question }]
    onChange(asked)
    setDraft('')
    setError(null)
    setStreaming('')

    const controller = new AbortController()
    abortRef.current = controller
    let partial = ''

    try {
      const answer = await provider.chat(
        {
          imageBase64: image.base64,
          mimeType: image.mimeType,
          analysis,
          hint,
          messages: asked,
        },
        { apiKey, model, signal: controller.signal },
        (delta) => {
          partial += delta
          setStreaming(partial)
        },
      )
      onChange([...asked, { role: 'model', text: answer }])
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      if (aborted && partial) {
        // Keep what arrived rather than discarding a half-read answer.
        onChange([...asked, { role: 'model', text: `${partial}\n\n[stopped]` }])
      } else if (aborted) {
        // Nothing useful arrived — drop the question so it can be re-asked.
        onChange(messages)
        setDraft(question)
      } else {
        onChange(messages)
        setDraft(question)
        setError(e instanceof Error ? e.message : 'That question could not be answered.')
      }
    } finally {
      abortRef.current = null
      setStreaming(null)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. Sending is what you want 95% of
    // the time, and the Send button covers the rest.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  if (!image) return null

  return (
    <section className="chat" aria-label="Follow-up questions">
      <h2 className="chat__head">Ask about this schematic</h2>
      {note && <p className="chat__note">{note}</p>}

      {(messages.length > 0 || busy) && (
        <div className="chat__log" ref={logRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg msg--${m.role}`}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div className="msg msg--model">
              {streaming}
              <span className="caret" aria-label="answering" />
            </div>
          )}
        </div>
      )}

      {messages.length === 0 && !busy && (
        <div className="chat__suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggest" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="alert alert--inline" role="alert">
          {error}
        </div>
      )}

      <div className="chat__compose">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a follow-up…"
          rows={1}
          aria-label="Your question"
        />
        {busy ? (
          <button className="btn btn--ghost chat__send" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button
            className="btn btn--primary chat__send"
            onClick={() => void send(draft)}
            disabled={!draft.trim()}
          >
            Send
          </button>
        )}
      </div>
    </section>
  )
}
