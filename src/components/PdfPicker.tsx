import { useEffect, useRef, useState } from 'react'
import type { LoadedPdf } from '../lib/pdf'

interface Props {
  pdf: LoadedPdf
  onPick: (pageNumber: number) => void
  onCancel: () => void
  /** Set while the chosen page is being rendered at full resolution. */
  busyPage?: number | null
}

/** Thumbnails are rendered in batches so a 200-page manual doesn't block. */
const BATCH = 24

export function PdfPicker({ pdf, onPick, onCancel, busyPage }: Props) {
  const [thumbs, setThumbs] = useState<string[]>([])
  const [shown, setShown] = useState(Math.min(BATCH, pdf.pageCount))
  const [jump, setJump] = useState('')
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  // Render one page at a time rather than firing off fifty at once: pdf.js
  // serialises on a single worker anyway, and going one by one lets the grid
  // fill in progressively instead of freezing and then appearing all at once.
  useEffect(() => {
    let cancelled = false

    async function fill() {
      for (let page = thumbs.length + 1; page <= shown; page++) {
        const data = await pdf.thumbnail(page)
        if (cancelled || !liveRef.current) return
        setThumbs((prev) => (prev.length === page - 1 ? [...prev, data] : prev))
      }
    }

    void fill()
    return () => {
      cancelled = true
    }
  }, [pdf, shown, thumbs.length])

  function submitJump(e: React.FormEvent) {
    e.preventDefault()
    const n = Number(jump)
    if (Number.isInteger(n) && n >= 1 && n <= pdf.pageCount) onPick(n)
  }

  const jumpNumber = Number(jump)
  const jumpValid = Number.isInteger(jumpNumber) && jumpNumber >= 1 && jumpNumber <= pdf.pageCount

  return (
    <div className="picker">
      <header className="picker__head">
        <div>
          <h2>Which page?</h2>
          <p className="picker__meta">
            {pdf.name} · {pdf.pageCount} page{pdf.pageCount === 1 ? '' : 's'}
          </p>
        </div>
        <button className="btn btn--icon" onClick={onCancel} aria-label="Choose a different file">
          ✕
        </button>
      </header>

      {pdf.pageCount > BATCH && (
        <form className="picker__jump" onSubmit={submitJump}>
          <label className="field">
            <span className="field__label">Straight to a page</span>
            <div className="field__row">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={pdf.pageCount}
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                placeholder={`1–${pdf.pageCount}`}
              />
              <button className="btn btn--ghost" type="submit" disabled={!jumpValid}>
                Go
              </button>
            </div>
            <span className="field__help">
              Faster than scrolling thumbnails when you already know the sheet number.
            </span>
          </label>
        </form>
      )}

      <ul className="picker__grid">
        {Array.from({ length: shown }, (_, i) => i + 1).map((page) => {
          const thumb = thumbs[page - 1]
          const busy = busyPage === page
          return (
            <li key={page}>
              <button
                className={`pagechip${busy ? ' pagechip--busy' : ''}`}
                onClick={() => onPick(page)}
                disabled={busyPage != null}
              >
                {thumb ? (
                  <img src={thumb} alt="" loading="lazy" />
                ) : (
                  <span className="pagechip__blank" aria-hidden="true" />
                )}
                <span className="pagechip__no">{busy ? 'Opening…' : page}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {shown < pdf.pageCount && (
        <button
          className="btn btn--ghost btn--wide"
          onClick={() => setShown((n) => Math.min(n + BATCH, pdf.pageCount))}
        >
          Show more pages ({pdf.pageCount - shown} left)
        </button>
      )}

      <button className="btn btn--ghost btn--wide" onClick={onCancel}>
        Choose a different file
      </button>
    </div>
  )
}
