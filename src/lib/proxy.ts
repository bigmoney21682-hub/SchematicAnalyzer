/**
 * Where the credentials for a request come from.
 *
 * Three sources, tried in this order:
 *
 *   1. The viewer's own key, typed into Settings. Goes browser-to-Google
 *      directly — no sheet touches a server we run, which for a customer's
 *      service manual is the point rather than a detail.
 *   2. The shared proxy: a Cloudflare Worker holding a pool of the owner's
 *      keys, so a plain link works for someone who has no key of their own.
 *      Every sheet sent this way travels through whoever runs that Worker.
 *   3. A custom proxy the viewer points at themselves — their own deployment
 *      of worker/, for a team that wants the shared-link convenience without
 *      the shared operator.
 *
 * A viewer's own key overrides the shared pool, and also adds to it: if their
 * key is exhausted the chain falls through to the shared one rather than
 * stopping. Turning the shared proxy off in Settings removes it from the chain
 * entirely, which is the setting to use if no sheet may leave the browser
 * except to the model vendor.
 *
 * The proxy fronts Groq as well as Google, under a /groq prefix. That is not
 * only for the key pool: Groq sends no CORS headers, so a static site cannot
 * call it directly at all, and the shared route is the only way a viewer
 * without their own Groq key can reach it.
 */

/**
 * The shared proxy, baked in so a link works with no setup. Deploy worker/ and
 * put its URL here — empty means the app ships with no shared service and
 * every viewer brings their own key.
 *
 * SHARED_PROXY_TOKEN is a gate, not a secret: it ships in the bundle and
 * anyone who opens devtools can read it. Its only job is to stop drive-by
 * scripted abuse of the URL. The real limits are the Worker's origin
 * allowlist and its per-IP daily cap.
 */
const SHARED_PROXY_URL = 'https://schematicanalyzer-proxy.bigmoney21682.workers.dev'
const SHARED_PROXY_TOKEN = ''

const KEY_URL = 'schem.proxy.url'
const KEY_TOKEN = 'schem.proxy.token'
const KEY_SHARED_OFF = 'schem.proxy.shared-off'

export interface ProxyConfig {
  /** Worker base URL, no trailing slash. Empty means "no custom proxy". */
  url: string
  /** Shared passphrase the Worker checks. Useless without the URL. */
  token: string
}

/** Trailing slashes produce "//models" once a path is appended, which Google
 *  404s in a way that reads like the model is missing. */
const clean = (v: string | null) => (v ?? '').trim().replace(/\/+$/, '')

export const proxyStore = {
  get(): ProxyConfig {
    return {
      url: clean(localStorage.getItem(KEY_URL)),
      token: (localStorage.getItem(KEY_TOKEN) ?? '').trim(),
    }
  },

  set(config: ProxyConfig) {
    const url = clean(config.url)
    if (url) localStorage.setItem(KEY_URL, url)
    else localStorage.removeItem(KEY_URL)

    const token = config.token.trim()
    if (token) localStorage.setItem(KEY_TOKEN, token)
    else localStorage.removeItem(KEY_TOKEN)
  },
}

/** The shared pool is opt-out, so the default link works untouched. */
export const sharedProxyStore = {
  available: () => Boolean(SHARED_PROXY_URL),
  get: () => Boolean(SHARED_PROXY_URL) && localStorage.getItem(KEY_SHARED_OFF) !== '1',
  set: (on: boolean) => {
    if (on) localStorage.removeItem(KEY_SHARED_OFF)
    else localStorage.setItem(KEY_SHARED_OFF, '1')
  },
}

/** One way of authenticating a request, and how to address it. */
export interface Credential {
  kind: 'own' | 'shared' | 'custom'
  /** Shown when the chain moves on, so an error names the source that failed. */
  label: string
  /** API base. Google's own root for 'own', the Worker's for the rest. */
  base: string
  /** Present only for 'own' — proxied requests never carry the viewer's key. */
  apiKey?: string
  /** Present only for proxied routes. */
  token?: string
}

const GOOGLE_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
const GROQ_ROOT = 'https://api.groq.com/openai/v1'

/** How each provider is addressed on each side of the proxy. `direct` is the
 *  vendor's own root; `prefix` is where the Worker mounts it. */
const VENDORS: Record<string, { direct: string; prefix: string }> = {
  gemini: { direct: GOOGLE_ROOT, prefix: '' },
  // Groq sends no CORS headers, so 'own' is unreachable from a browser and
  // the proxied routes are the only ones that work. See providers/groq.ts.
  groq: { direct: GROQ_ROOT, prefix: '/groq' },
}

/**
 * The credentials to try for one provider, best first. Order is the whole
 * design: the viewer's own key first because it is theirs and it keeps images
 * off our servers, the shared pool last because it spends someone else's
 * quota.
 */
export function credentials(providerId: string, apiKey = ''): Credential[] {
  const vendor = VENDORS[providerId]
  if (!vendor) return []

  const chain: Credential[] = []
  const key = apiKey.trim()
  const custom = proxyStore.get()

  if (key) chain.push({ kind: 'own', label: 'your API key', base: vendor.direct, apiKey: key })

  if (custom.url)
    chain.push({
      kind: 'custom',
      label: 'your proxy',
      base: custom.url + vendor.prefix,
      token: custom.token,
    })

  if (sharedProxyStore.get())
    chain.push({
      kind: 'shared',
      label: 'the shared service',
      base: SHARED_PROXY_URL + vendor.prefix,
      token: SHARED_PROXY_TOKEN,
    })

  return chain
}

/** Whether this provider can be reached at all right now. Groq with no proxy
 *  and no key is not a chain worth starting — the browser will just CORS-fail. */
export function reachable(providerId: string, apiKey = ''): boolean {
  return credentials(providerId, apiKey).length > 0
}

/**
 * Builds the URL and auth headers for one call on one credential.
 *
 * `auth` says how the vendor wants its key when the browser holds one: Google
 * takes a query parameter, Groq a bearer header. Proxied calls never carry a
 * viewer key either way — they send the gate token and let the Worker attach
 * one from its pool.
 */
export function route(
  cred: Credential,
  path: string,
  params: Record<string, string> = {},
  auth: 'query' | 'bearer' = 'query',
) {
  const query = new URLSearchParams(params)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (cred.kind === 'own') {
    if (auth === 'bearer') headers.Authorization = `Bearer ${cred.apiKey ?? ''}`
    else query.set('key', cred.apiKey ?? '')
  } else if (cred.token) {
    headers['X-App-Token'] = cred.token
  }

  const qs = query.toString()
  return { url: `${cred.base}${path}${qs ? `?${qs}` : ''}`, headers }
}

/**
 * The shared service's daily allowance for this browser's address.
 *
 * Two ways in, because neither alone is enough: /quota answers before anything
 * has been uploaded, which is what the homescreen needs, and the response
 * headers on every real call keep it current without a second round trip.
 */
export interface Quota {
  enabled: boolean
  limit: number
  used: number
  remaining: number
  /** ISO instant the counter turns over, or '' when uncapped. */
  reset: string
}

type QuotaListener = (q: Quota | null) => void
const listeners = new Set<QuotaListener>()
let current: Quota | null = null

function publish(q: Quota | null) {
  current = q
  for (const fn of listeners) fn(q)
}

export const quotaStore = {
  get: () => current,
  subscribe(fn: QuotaListener) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },

  /** Picks the allowance off a proxied response. No-op for direct calls,
   *  which carry no such headers and spend no shared quota. */
  readFrom(res: Response) {
    const limit = res.headers.get('X-Quota-Limit')
    if (limit === null) return
    publish({
      enabled: true,
      limit: Number(limit),
      used: Number(res.headers.get('X-Quota-Used') ?? 0),
      remaining: Number(res.headers.get('X-Quota-Remaining') ?? 0),
      reset: res.headers.get('X-Quota-Reset') ?? '',
    })
  },

  /** Asks the proxy outright, without spending any of it. */
  async refresh(): Promise<Quota | null> {
    const proxied = credentials('gemini').find((c) => c.kind !== 'own')
    if (!proxied) {
      publish(null)
      return null
    }
    try {
      const res = await fetch(`${proxied.base}/quota`, {
        headers: proxied.token ? { 'X-App-Token': proxied.token } : {},
      })
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as Partial<Quota>
      publish({
        enabled: Boolean(json.enabled),
        limit: Number(json.limit ?? 0),
        used: Number(json.used ?? 0),
        remaining: Number(json.remaining ?? 0),
        reset: String(json.reset ?? ''),
      })
      return current
    } catch {
      // An unreachable proxy is not worth a banner of its own — the first real
      // request will say so far more usefully than a meter can.
      publish(null)
      return null
    }
  },
}

/** True when something other than the viewer's own key can serve a request,
 *  so the app needn't insist on one before it will run. */
export function usingProxy(): boolean {
  return Boolean(proxyStore.get().url) || sharedProxyStore.get()
}
