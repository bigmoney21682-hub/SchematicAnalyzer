import { useState } from 'react'
import { splitDataUrl } from '../lib/image'
import { historyStore, type HistoryEntry } from '../lib/storage'
import type { ChatMessage } from '../lib/types'
import { Chat } from './Chat'
import { Results } from './Results'

interface Props {
  onClose: () => void
  providerId: string
  apiKey: string
  model: string
}

function when(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  if (d.toDateString() === now.toDateString()) return `Today, ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`

  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${date}, ${time}`
}

/** e.g. "Today, 14:02 · gemini-flash-latest". Model can be blank on old entries. */
function provenance(entry: HistoryEntry): string {
  return [when(entry.at), entry.origin, entry.model || entry.provider].filter(Boolean).join(' · ')
}

export function History({ onClose, providerId, apiKey, model }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => historyStore.list())
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const open = entries.find((e) => e.id === openId)

  function remove(id: string) {
    setEntries(historyStore.remove(id))
    if (openId === id) setOpenId(null)
  }

  function saveChat(id: string, chat: ChatMessage[]) {
    historyStore.setChat(id, chat)
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, chat } : e)))
  }

  if (open) {
    // The full-resolution sheet was never stored, so follow-ups here run against
    // the thumbnail. Said out loud, because on a schematic it is the difference
    // between reading a designator and guessing at it.
    const image = open.thumbnail ? splitDataUrl(open.thumbnail) : null

    return (
      <div className="history">
        <button className="btn btn--ghost history__back" onClick={() => setOpenId(null)}>
          ← All saved reports
        </button>
        <Results
          analysis={open.analysis}
          imageUrl={open.thumbnail}
          meta={provenance(open)}
          resetLabel="Back to history"
          onReset={() => setOpenId(null)}
        >
          <Chat
            image={image}
            analysis={open.analysis}
            hint={open.hint}
            providerId={providerId}
            apiKey={apiKey}
            model={model}
            messages={open.chat ?? []}
            onChange={(chat) => saveChat(open.id, chat)}
            note={
              image
                ? 'Answers here run against a small stored thumbnail, not the original sheet. It can reason from the report, but it cannot re-read a designator at this size — re-upload the sheet for anything that depends on fine detail.'
                : undefined
            }
          />
        </Results>
        <button className="btn btn--ghost btn--wide" onClick={() => remove(open.id)}>
          Delete this report
        </button>
      </div>
    )
  }

  return (
    <div className="history">
      <header className="history__head">
        <h1>Saved reports</h1>
        <button className="btn btn--icon" onClick={onClose} aria-label="Close history">
          ✕
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="history__empty">
          Nothing saved yet. Every sheet you analyze is kept here automatically — tap one to see the
          full report again, or to carry on asking about it.
        </p>
      ) : (
        <>
          <ul className="history__list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button className="hitem" onClick={() => setOpenId(entry.id)}>
                  {entry.thumbnail ? (
                    <img className="hitem__thumb" src={entry.thumbnail} alt="" />
                  ) : (
                    <span className="hitem__thumb hitem__thumb--none" aria-hidden="true">
                      ▦
                    </span>
                  )}
                  <span className="hitem__text">
                    <span className="hitem__type">{entry.title || 'Schematic'}</span>
                    <span className="hitem__summary">{entry.summary}</span>
                    <span className="hitem__when">
                      {provenance(entry)}
                      {entry.chat?.length ? ` · ${entry.chat.length} messages` : ''}
                    </span>
                  </span>
                </button>
                <button
                  className="btn btn--icon hitem__del"
                  onClick={() => remove(entry.id)}
                  aria-label={`Delete report of ${entry.title || 'this sheet'}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <button
            className="btn btn--ghost btn--wide"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true)
                return
              }
              historyStore.clear()
              setEntries([])
              setConfirmClear(false)
            }}
          >
            {confirmClear ? 'Tap again to delete everything' : 'Clear history'}
          </button>
        </>
      )}

      <p className="history__note">
        Saved in this browser only, on this device. Sheets are kept as small thumbnails; the
        full-resolution upload is never stored. Clearing history removes them for good.
      </p>
    </div>
  )
}
