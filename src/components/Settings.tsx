import { useEffect, useState } from 'react'
import { diagnoseKey, sanitizeKey } from '../lib/apikey'
import { modelListers, pickDefaultModel, providers } from '../lib/providers'
import { proxyStore, sharedProxyStore } from '../lib/proxy'
import { apiKeyStore, modelStore, providerStore } from '../lib/storage'

interface Props {
  onClose: () => void
  onChange: (providerId: string, apiKey: string, model: string) => void
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; models: string[] }
  | { status: 'failed'; message: string }

const KEY_HELP: Record<string, { url: string; label: string; placeholder: string }> = {
  gemini: {
    url: 'https://aistudio.google.com/apikey',
    label: 'aistudio.google.com/apikey',
    placeholder: 'AIza...',
  },
  groq: {
    url: 'https://console.groq.com/keys',
    label: 'console.groq.com/keys',
    placeholder: 'gsk_...',
  },
}

export function Settings({ onClose, onChange }: Props) {
  const [providerId, setProviderId] = useState(providerStore.get())
  const [apiKey, setApiKey] = useState(() => apiKeyStore.get(providerStore.get()))
  const [model, setModel] = useState(() => modelStore.get(providerStore.get()))
  const [reveal, setReveal] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [proxy, setProxy] = useState(() => proxyStore.get())
  const [useShared, setUseShared] = useState(() => sharedProxyStore.get())

  // Switching provider swaps in that provider's own stored key and model.
  useEffect(() => {
    setApiKey(apiKeyStore.get(providerId))
    setModel(modelStore.get(providerId))
    setTest({ status: 'idle' })
  }, [providerId])

  const provider = providers.find((p) => p.id === providerId)
  const help = KEY_HELP[providerId]
  const lister = modelListers[providerId]

  const diagnostic = diagnoseKey(providerId, apiKey)
  const proxied = Boolean(proxy.url.trim())
  // Something can serve a request even with no key in this browser.
  const covered = Boolean(sanitizeKey(apiKey)) || proxied || useShared

  async function runTest() {
    const clean = sanitizeKey(apiKey)
    if (!lister || !covered) return
    setTest({ status: 'testing' })
    try {
      const models = await lister(clean)
      setTest({ status: 'ok', models })
      // Auto-select only if the current choice isn't in the list — a retired
      // model is exactly the case that brought the user here.
      if (!model || !models.includes(model)) setModel(pickDefaultModel(models))
    } catch (e) {
      setTest({ status: 'failed', message: e instanceof Error ? e.message : 'Test failed.' })
    }
  }

  function save() {
    providerStore.set(providerId)
    apiKeyStore.set(providerId, apiKey)
    modelStore.set(providerId, model)
    proxyStore.set(proxy)
    sharedProxyStore.set(useShared)
    onChange(providerId, sanitizeKey(apiKey), model)
    onClose()
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="sheet__inner">
        <header className="sheet__head">
          <h2>Settings</h2>
          <button className="btn btn--icon" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <label className="field">
          <span className="field__label">Analysis provider</span>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {provider?.needsKey && (
          <>
            <label className="field">
              <span className="field__label">API key</span>
              <div className="field__row">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setTest({ status: 'idle' })
                  }}
                  placeholder={help?.placeholder}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button className="btn btn--icon" onClick={() => setReveal((r) => !r)}>
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>

            {diagnostic && (
              <p className={`keydiag keydiag--${diagnostic.level}`}>{diagnostic.message}</p>
            )}

            <button
              className="btn btn--ghost btn--wide"
              onClick={runTest}
              disabled={!covered || test.status === 'testing'}
            >
              {test.status === 'testing'
                ? 'Testing…'
                : proxied
                  ? 'Test proxy & list models'
                  : 'Test key & list models'}
            </button>

            {test.status === 'ok' && (
              <div className="test test--ok">
                <strong>Key works.</strong> {test.models.length} model
                {test.models.length === 1 ? '' : 's'} available. Picked a Flash model: on a free
                key it answers where Pro is usually rate limited. Pro reads 7px designators off a
                scan better — pick it below if your key is paid, or if a sheet comes back wrong.
              </div>
            )}

            {test.status === 'failed' && <div className="test test--fail">{test.message}</div>}

            <label className="field">
              <span className="field__label">Model</span>
              {test.status === 'ok' && test.models.length > 0 ? (
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {test.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={provider.defaultModel}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
              <span className="field__help">
                {test.status === 'ok'
                  ? 'This list comes from your key, so anything in it will work.'
                  : `Blank uses "${provider.defaultModel}". Hit Test to see what your key can actually reach — model IDs get retired without notice.`}
              </span>
            </label>

            {help && (
              <p className="field__help">
                Get a key at{' '}
                <a href={help.url} target="_blank" rel="noreferrer">
                  {help.label}
                </a>
                . It is stored only in this browser and sent only to Google. It never reaches the
                server hosting this app.
              </p>
            )}
            <p className="field__help field__help--warn">
              Because this is a static site, the key is readable by anything running in this
              browser. Restrict it by referrer where the provider supports it, and rotate it if you
              share this device.
            </p>
            <p className="field__help field__help--warn">
              A free-tier AI Studio key lets Google use your prompts and images to improve their
              models. A paid key does not. Check the terms before uploading anything confidential —
              service manuals are usually somebody's copyright.
            </p>

            <label className="field">
              <span className="field__label">Proxy URL (optional)</span>
              <input
                type="url"
                value={proxy.url}
                onChange={(e) => {
                  setProxy((p) => ({ ...p, url: e.target.value }))
                  setTest({ status: 'idle' })
                }}
                placeholder="https://schematicanalyzer-proxy.you.workers.dev"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <span className="field__help">
                Your own deployment of worker/, for a team that wants a shared key without a
                shared operator. Used only when the key above is missing or exhausted. Every sheet
                sent this way passes through whoever runs that proxy.
              </span>
            </label>

            {proxied && (
              <label className="field">
                <span className="field__label">Proxy passphrase</span>
                <input
                  type={reveal ? 'text' : 'password'}
                  value={proxy.token}
                  onChange={(e) => setProxy((p) => ({ ...p, token: e.target.value }))}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <span className="field__help">
                  Must match the proxy's APP_TOKEN. Without it the proxy refuses every request —
                  which is the point, since an open proxy spends its owner's quota.
                </span>
              </label>
            )}

            {sharedProxyStore.available() && (
              <label className="field field--check">
                <input
                  type="checkbox"
                  checked={useShared}
                  onChange={(e) => {
                    setUseShared(e.target.checked)
                    setTest({ status: 'idle' })
                  }}
                />
                <span>
                  <span className="field__label">Use the shared service</span>
                  <span className="field__help">
                    Lets this app work with no key of your own, on a pool of keys the app's owner
                    pays for — so it is rate limited, and every sheet passes through their server.
                    A key of your own is used first and the shared pool only picks up when yours
                    is exhausted. Untick this to guarantee no sheet leaves this browser except to
                    Google.
                  </span>
                </span>
              </label>
            )}

            <p className="field__help">
              <strong>Order of use:</strong> your key, then your proxy, then the shared service —
              whichever is set. Each is skipped when it is out of quota rather than failing the
              request. Within each, a retired or rate-limited model falls through to the next best
              one that credential can reach; and if a whole vendor is unusable, the other one picks
              it up. Nothing ever falls back to Demo mode — a report always comes from a real
              model, and the banner above says which one when it was not the one named here.
            </p>

            {!covered && (
              <p className="field__help field__help--warn">
                Nothing is set to serve a request. Add a key above, point at a proxy, or turn the
                shared service on — otherwise only Demo mode will run.
              </p>
            )}
          </>
        )}

        <div className="sheet__actions">
          <button className="btn btn--primary btn--wide" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
