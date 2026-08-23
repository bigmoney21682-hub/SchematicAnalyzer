import { useCallback, useEffect, useRef, useState } from 'react'
import { Capture } from './components/Capture'
import { Chat } from './components/Chat'
import { History } from './components/History'
import { PdfPicker } from './components/PdfPicker'
import { Quota } from './components/Quota'
import { Results } from './components/Results'
import { Settings } from './components/Settings'
import { formatBytes, prepareImage, type PreparedImage } from './lib/image'
import type { LoadedPdf } from './lib/pdf'
import { analyze as runAnalysis, getProvider, providers } from './lib/providers'
import { usingProxy } from './lib/proxy'
import { apiKeyStore, historyStore, modelStore, providerStore } from './lib/storage'
import type { Analysis, ChatMessage } from './lib/types'

type Stage = 'idle' | 'picking' | 'preview' | 'analyzing' | 'done'

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

export default function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [image, setImage] = useState<PreparedImage | null>(null)
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [openingPage, setOpeningPage] = useState<number | null>(null)
  const [hint, setHint] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  // Which history row the live report was saved as, so follow-ups land on it.
  const [entryId, setEntryId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the fallback chain had to leave the chosen model or key behind. A
  // report written by something other than what Settings names must say so.
  const [notice, setNotice] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [providerId, setProviderId] = useState(providerStore.get())
  const [apiKey, setApiKey] = useState(() => apiKeyStore.get(providerStore.get()))
  const [model, setModel] = useState(() => modelStore.get(providerStore.get()))

  const abortRef = useRef<AbortController | null>(null)
  // Held separately so we can revoke the previous preview when a new one lands.
  const previewRef = useRef<string | null>(null)
  const pdfRef = useRef<LoadedPdf | null>(null)

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      pdfRef.current?.close()
      abortRef.current?.abort()
    }
  }, [])

  /** Everything that has to happen when a new sheet takes the stage. */
  // Not named useSomething: the hooks lint rule keys off that prefix and reads
  // any such callback as a hook being called from inside another callback.
  const adoptSheet = useCallback(async (blob: Blob, origin?: string) => {
    const prepared = await prepareImage(blob, origin)
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = prepared.previewUrl
    setImage(prepared)
    setAnalysis(null)
    setChat([])
    setEntryId(null)
    setStage('preview')
  }, [])

  const pick = useCallback(
    async (file: File) => {
      setError(null)
      try {
        if (isPdf(file)) {
          // pdf.js is most of this app's JavaScript and most sessions never
          // touch it, so it is fetched the first time a PDF actually appears.
          const { loadPdf } = await import('./lib/pdf')
          const doc = await loadPdf(file)
          pdfRef.current?.close()
          pdfRef.current = doc
          setPdf(doc)
          setStage('picking')
          return
        }
        pdfRef.current?.close()
        pdfRef.current = null
        setPdf(null)
        await adoptSheet(file)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that file.')
      }
    },
    [adoptSheet],
  )

  const pickPage = useCallback(
    async (pageNumber: number) => {
      const doc = pdfRef.current
      if (!doc) return
      setOpeningPage(pageNumber)
      setError(null)
      try {
        const blob = await doc.render(pageNumber)
        await adoptSheet(blob, `page ${pageNumber} of ${doc.pageCount} · ${doc.name}`)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not render that page.')
      } finally {
        setOpeningPage(null)
      }
    },
    [adoptSheet],
  )

  const analyze = useCallback(async () => {
    if (!image) return
    const provider = getProvider(providerId)

    if (provider.needsKey && !apiKey && !usingProxy()) {
      setError('Add an API key in Settings first, or switch to Demo mode to see how it works.')
      setShowSettings(true)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStage('analyzing')
    setError(null)
    setNotice(null)

    const asked = model || provider.defaultModel
    let used = asked
    // Which of the credential sources actually paid for this. Only worth
    // mentioning when it was not the obvious one.
    let via = ''

    let vendor = providerId

    try {
      const result = await runAnalysis(
        providerId,
        { imageBase64: image.base64, mimeType: image.mimeType, hint },
        {
          apiKey,
          model,
          signal: controller.signal,
          onModel: (m) => {
            used = m
          },
          onCredential: (c) => {
            via = c.kind === 'own' ? '' : c.label
          },
          onProvider: (id) => {
            vendor = id
          },
        },
      )
      setAnalysis(result)
      setChat([])
      const vendorName = providers.find((p) => p.id === vendor)?.label ?? vendor
      const moved = [
        vendor !== providerId && `${provider.label} could not run this sheet, so ${vendorName} did`,
        vendor === providerId &&
          used !== asked &&
          `${asked} could not run this sheet, so ${used} wrote this report`,
        via && apiKey && `your key was exhausted, so it ran on ${via}`,
      ].filter(Boolean)
      if (moved.length)
        setNotice(`${moved.join('; ')}. Check Settings if you want a specific model or key.`)
      const entry = historyStore.add({
        analysis: result,
        provider: vendor,
        model: used,
        hint,
        origin: image.origin,
        thumbnail: image.thumbnail,
      })
      setEntryId(entry.id)
      setStage('done')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setStage('preview')
        return
      }
      setError(e instanceof Error ? e.message : 'Something went wrong while reading the sheet.')
      setStage('preview')
    } finally {
      abortRef.current = null
    }
  }, [image, providerId, apiKey, model, hint])

  /** Keeps the live transcript and its saved copy in step. */
  const updateChat = useCallback(
    (messages: ChatMessage[]) => {
      setChat(messages)
      if (entryId) historyStore.setChat(entryId, messages)
    },
    [entryId],
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = null
    pdfRef.current?.close()
    pdfRef.current = null
    setPdf(null)
    setImage(null)
    setAnalysis(null)
    setChat([])
    setEntryId(null)
    setHint('')
    setError(null)
    setNotice(null)
    setStage('idle')
    setShowHistory(false)
  }, [])

  return (
    <div className="app">
      <nav className="topbar">
        <button className="topbar__brand" onClick={reset}>
          Schematic Analyzer
        </button>
        <div className="topbar__actions">
          <button
            className={`btn btn--icon${showHistory ? ' btn--icon-on' : ''}`}
            onClick={() => setShowHistory((v) => !v)}
            aria-label="Saved reports"
            aria-pressed={showHistory}
          >
            🕘
          </button>
          <button
            className="btn btn--icon"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </nav>

      <main className="main">
        {showHistory && (
          <History
            onClose={() => setShowHistory(false)}
            providerId={providerId}
            apiKey={apiKey}
            model={model}
          />
        )}

        {/* Kept mounted behind the history view so an in-flight analysis, the
            chosen sheet and any error all survive a look at the history. */}
        <div hidden={showHistory}>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}

          {notice && (
            <div className="alert alert--info" role="status">
              {notice}
            </div>
          )}

          {stage === 'idle' && (
            <>
              <Quota hasOwnKey={Boolean(apiKey)} />
              <Capture onPick={pick} />
            </>
          )}

          {stage === 'picking' && pdf && (
            <PdfPicker pdf={pdf} onPick={pickPage} onCancel={reset} busyPage={openingPage} />
          )}

          {(stage === 'preview' || stage === 'analyzing') && image && (
            <div className="preview">
              <img className="preview__img" src={image.previewUrl} alt="The sheet you uploaded" />
              <p className="preview__meta">
                {image.origin ? `${image.origin} · ` : ''}
                {image.width} × {image.height} · {formatBytes(image.bytes)}
                {image.lossless ? ' · sent losslessly' : ' · re-encoded to JPEG'}
              </p>

              {stage === 'preview' ? (
                <>
                  <label className="field">
                    <span className="field__label">What do you already know? (optional)</span>
                    <input
                      type="text"
                      value={hint}
                      onChange={(e) => setHint(e.target.value)}
                      placeholder="e.g. Sony STR-DH190, dead, standby LED blinks 3×"
                    />
                    <span className="field__help">
                      The model, the symptom, what the LEDs are doing. This is what turns a
                      description into somewhere to start.
                    </span>
                  </label>
                  <button className="btn btn--primary btn--wide" onClick={analyze}>
                    Analyze this sheet
                  </button>
                  {pdf && (
                    <button className="btn btn--ghost btn--wide" onClick={() => setStage('picking')}>
                      Pick a different page
                    </button>
                  )}
                  <button className="btn btn--ghost btn--wide" onClick={reset}>
                    Choose a different file
                  </button>
                </>
              ) : (
                <div className="working">
                  <div className="scanline" aria-hidden="true" />
                  <p>Reading the sheet…</p>
                  <button className="btn btn--ghost" onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {stage === 'done' && analysis && (
            <Results analysis={analysis} imageUrl={image?.previewUrl} onReset={reset}>
              <Chat
                image={image ? { base64: image.base64, mimeType: image.mimeType } : null}
                analysis={analysis}
                hint={hint}
                providerId={providerId}
                apiKey={apiKey}
                model={model}
                messages={chat}
                onChange={updateChat}
              />
            </Results>
          )}
        </div>
      </main>

      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onChange={(p, k, m) => {
            setProviderId(p)
            setApiKey(k)
            setModel(m)
            setError(null)
          }}
        />
      )}
    </div>
  )
}
