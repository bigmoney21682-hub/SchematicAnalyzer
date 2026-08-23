/**
 * Shared model proxy for the Schematic Analyzer app.
 *
 * The app is a static site, so any key it ships is public — see the note at
 * the top of src/lib/providers/gemini.ts. This Worker exists so that pools of
 * keys (yours, held as Cloudflare secrets) can serve a shared link without any
 * of them ever reaching a browser.
 *
 * It fronts two upstreams. Google is the default; anything under /groq is
 * rewritten to Groq's OpenAI-compatible API. Groq is here for two reasons: it
 * is a second vendor to fall over to when every Gemini key is spent, and it
 * does not send CORS headers, so a static site cannot call it at all without
 * something like this in the path.
 *
 * The cost of the convenience: every sheet analysed through this Worker passes
 * through your Cloudflare account on its way to the model. Nothing here writes
 * a request body anywhere, and it must stay that way — a single console.log of
 * the body would put customer drawings into your log tail.
 *
 * The second cost is quota. This is your key pools being spent by strangers,
 * so read the limits below and set them before you publish the URL.
 */

/** ISO date in UTC. The quota day boundary, and the KV key's namespace. */
const today = () => new Date().toISOString().slice(0, 10)

/**
 * The two upstreams.
 *
 * `paths` is an allowlist, not decoration: without it the Worker is an open
 * relay to everything the keys can reach the moment the URL leaks — including
 * endpoints that bill at a very different rate.
 *
 * `auth` differs because the vendors differ. Google takes the key as a query
 * parameter, Groq as a bearer header, and pretending otherwise is the kind of
 * detail that fails only in production.
 */
const UPSTREAMS = {
  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta',
    keys: (env) => [env.GEMINI_KEYS, env.GEMINI_KEY],
    label: 'GEMINI_KEYS',
    paths: [
      /^\/models$/,
      /^\/models\/[A-Za-z0-9._-]+:generateContent$/,
      /^\/models\/[A-Za-z0-9._-]+:streamGenerateContent$/,
    ],
    auth: (url, headers, key) => url.searchParams.set('key', key),
  },

  groq: {
    base: 'https://api.groq.com/openai/v1',
    keys: (env) => [env.GROQ_KEYS, env.GROQ_KEY],
    label: 'GROQ_KEYS',
    // Groq model IDs carry slashes ("qwen/qwen3.6-27b"), so the path is fixed
    // and the model travels in the JSON body instead.
    paths: [/^\/models$/, /^\/chat\/completions$/],
    auth: (_url, headers, key) => headers.set('Authorization', `Bearer ${key}`),
  },
}

/** Which upstream a request is for, and the path with its prefix removed. */
function resolveUpstream(pathname) {
  if (pathname === '/groq' || pathname.startsWith('/groq/'))
    return { name: 'groq', up: UPSTREAMS.groq, path: pathname.slice('/groq'.length) || '/' }
  return { name: 'google', up: UPSTREAMS.google, path: pathname }
}

/** An image plus a prompt, base64'd. Anything larger is not a photo of a study
 *  and is the cheapest abuse to refuse. */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** Requests per IP per rolling day, enforced only when a RATE_LIMIT KV
 *  namespace is bound. Unbound means unlimited — fine while the URL is
 *  private, not fine once it is in a public app listing. */
const DEFAULT_DAILY_CAP = 40

/**
 * Compares via SHA-256 so the loop runs over fixed-length input and takes the
 * same time regardless of where the first mismatch falls. A plain `===` on the
 * raw strings leaks the shared secret a character at a time to anyone patient
 * enough to measure.
 */
async function safeEqual(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/**
 * Echoes the caller's origin only when it is on the allowlist. ALLOWED_ORIGIN
 * takes a comma-separated list so the Pages URL and a local dev server can
 * coexist without opening this up to every origin on the internet.
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, Authorization',
    // Without this the browser can see the quota headers exist but not read
    // them, and the app's allowance meter silently shows nothing.
    'Access-Control-Expose-Headers': 'X-Quota-Limit, X-Quota-Used, X-Quota-Remaining, X-Quota-Reset',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function fail(status, message, request, env, extra = {}) {
  // Shaped like Google's own error body so the app's friendlyError() can read
  // it without needing to know a proxy is in the path at all.
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
      ...extra,
    },
  })
}

/**
 * One upstream's key pool, in a rotated order.
 *
 * Each var is a comma- or newline-separated list; the singular legacy name
 * stays supported so an existing one-key deployment keeps working across this
 * upgrade. The start offset is random rather than always zero: with a fixed
 * start the first key absorbs every request and hits its daily cap alone while
 * the others sit idle, which is the opposite of what a pool is for.
 */
function poolFor(up, env) {
  return up
    .keys(env)
    .flatMap((v) => (v ?? '').split(/[\s,]+/))
    .map((k) => k.trim())
    .filter(Boolean)
}

function keyPool(up, env) {
  const keys = poolFor(up, env)

  if (keys.length < 2) return keys
  const start = Math.floor(Math.random() * keys.length)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

/**
 * Whether the next key in the pool is worth trying.
 *
 * Only faults that belong to the key itself: a spent quota, a disabled
 * project, a revoked key. A 400 on a malformed request or a safety block will
 * fail the same way on every key, and marching the whole pool through it just
 * multiplies the cost of one bad request.
 */
function keyExhausted(status, body) {
  if (status === 429) return true
  if (status === 401 && /invalid_api_key|invalid api key/i.test(body)) return true
  if (status === 403 && /SERVICE_DISABLED|quota|has not been used in project/i.test(body))
    return true
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body)) return true
  return false
}

/** Per-IP daily allowance. Absent KV, there is no cap and nothing to report. */
const quotaSlot = (request) => `rl:${today()}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`

async function readQuota(request, env) {
  if (!env.RATE_LIMIT) return { enabled: false }
  const limit = Number(env.DAILY_CAP ?? DEFAULT_DAILY_CAP)
  const used = Number((await env.RATE_LIMIT.get(quotaSlot(request))) ?? 0)
  return {
    enabled: true,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    // Caps are keyed on the UTC date, so they turn over at UTC midnight.
    reset: `${today()}T24:00:00Z`,
  }
}

/**
 * Reads and increments in one step.
 *
 * `allowed` is decided on the state *before* the increment and the headers
 * describe the state *after* it. Conflating the two is how you end up
 * refusing the request that spends the final slot: after it, remaining is 0
 * and used has reached the limit, which looks identical to being over.
 */
async function spendQuota(request, env) {
  const before = await readQuota(request, env)
  if (!before.enabled) return { ...before, allowed: true }
  if (before.remaining <= 0) return { ...before, allowed: false }

  // expirationTtl rather than a cleanup pass: the counter should evaporate on
  // its own a day after the last request that touched it.
  await env.RATE_LIMIT.put(quotaSlot(request), String(before.used + 1), {
    expirationTtl: 60 * 60 * 26,
  })
  return { ...before, used: before.used + 1, remaining: before.remaining - 1, allowed: true }
}

/** Quota as response headers, so every answer carries the current allowance
 *  and the app never has to ask separately. */
function quotaHeaders(q) {
  if (!q.enabled) return {}
  return {
    'X-Quota-Limit': String(q.limit),
    'X-Quota-Used': String(q.used),
    'X-Quota-Remaining': String(q.remaining),
    'X-Quota-Reset': q.reset,
  }
}

/**
 * What is in the key pools, without revealing what the keys are.
 *
 * Setting a pool is the step that goes wrong: `wrangler secret put` replaces
 * the value rather than appending to it, so a key silently vanishes from one
 * Worker and not the others, or the same key gets pasted twice and looks like
 * two. Neither shows up as an error — the proxy keeps working on a thinner
 * pool than you think you have.
 *
 * A four-byte SHA-256 prefix is enough to spot both. It cannot be reversed
 * into a 39-to-53-character high-entropy key, and identical keys hash
 * identically, which is exactly the property needed.
 *
 * Deliberately makes no upstream calls. An endpoint that fans one request out
 * into one-per-key would be a neat amplifier for anyone who can reach it, and
 * liveness is what the app's own Test button is for.
 */
async function keyReport(env) {
  const out = {}

  for (const [name, up] of Object.entries(UPSTREAMS)) {
    const keys = poolFor(up, env)
    const seen = new Map()

    const entries = await Promise.all(
      keys.map(async (k) => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k))
        const fp = [...new Uint8Array(digest)]
          .slice(0, 4)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
        seen.set(fp, (seen.get(fp) ?? 0) + 1)
        return { fp, prefix: k.slice(0, 4), length: k.length }
      }),
    )

    const duplicates = [...seen].filter(([, n]) => n > 1).map(([fp]) => fp)
    out[name] = {
      secret: up.label,
      count: entries.length,
      distinct: seen.size,
      duplicates,
      keys: entries.map((e) => ({ ...e, duplicate: duplicates.includes(e.fp) })),
    }
  }

  return out
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    // No allowed origin matched, so the browser would discard the response
    // anyway. Saying so plainly beats letting it fail as an opaque CORS error.
    if (!cors['Access-Control-Allow-Origin'])
      return fail(403, 'This proxy does not serve that origin. Check ALLOWED_ORIGIN.', request, env)

    // The gate is optional. Set APP_TOKEN and the app must present it; leave
    // it unset and the origin allowlist plus the daily cap are the only
    // limits, which is the right trade for a proxy meant to serve a public
    // app to people who have no key of their own.
    //
    // Checked before anything else answers, so a tokened deployment does not
    // leak its allowance or its pool shape to an unauthenticated caller.
    if (env.APP_TOKEN) {
      const token = request.headers.get('X-App-Token') ?? ''
      if (!token || !(await safeEqual(token, env.APP_TOKEN)))
        return fail(401, 'Wrong or missing passphrase for this proxy.', request, env)
    }

    const url = new URL(request.url)

    // What is in the key pools. Costs nothing and reveals nothing — see
    // keyReport. Answered before the vendor routing because it spans vendors.
    if (url.pathname === '/keycheck')
      return new Response(JSON.stringify(await keyReport(env), null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
      })

    // The allowance, readable without spending any of it. The app calls this
    // on load so the homescreen can show what is left before anyone uploads
    // anything — polling the real endpoints for that would be self-defeating.
    if (url.pathname === '/quota')
      return new Response(JSON.stringify(await readQuota(request, env)), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
      })

    const { up, path } = resolveUpstream(url.pathname)

    const keys = keyPool(up, env)
    if (!keys.length) return fail(500, `The proxy has no ${up.label} secret set.`, request, env)

    if (!up.paths.some((re) => re.test(path)))
      return fail(404, `This proxy does not forward ${url.pathname}.`, request, env)

    const quota = await spendQuota(request, env)
    if (!quota.allowed)
      return fail(
        429,
        'The shared service has hit its daily limit for your address. Add your own ' +
          'API key in Settings to keep going — it is free from aistudio.google.com/apikey.',
        request,
        env,
        quotaHeaders(quota),
      )

    // Buffered rather than streamed upstream, because retrying on the next key
    // means sending the same body twice and a ReadableStream can only be read
    // once. The response stays a stream; only the request is held.
    let body
    if (request.method !== 'GET') {
      body = await request.arrayBuffer()
      if (body.byteLength > MAX_BODY_BYTES)
        return fail(413, 'That sheet is too large for the shared service.', request, env)
    }

    // The client never supplies a key; strip anything that looks like one so a
    // caller can't pin the request to some other billing account.
    const target = new URL(`${up.base}${path}`)
    for (const [k, v] of url.searchParams) if (k !== 'key') target.searchParams.set(k, v)

    let last = null
    for (const key of keys) {
      const headers = new Headers({
        'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
      })
      up.auth(target, headers, key)

      const upstream = await fetch(target, { method: request.method, headers, body })

      if (upstream.ok) {
        // Passing upstream.body straight through keeps the SSE stream a stream
        // — buffering here would turn the chat's token-by-token output into
        // one lump arriving after the whole answer is done.
        const out = new Headers({ ...cors, ...quotaHeaders(quota) })
        out.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json')
        out.set('Cache-Control', 'no-store')
        return new Response(upstream.body, { status: upstream.status, headers: out })
      }

      // Reading the error body is what lets us tell "this key is finished"
      // from "this request is wrong", and it is small enough to hold.
      const text = await upstream.text().catch(() => '')
      last = { status: upstream.status, text }
      if (!keyExhausted(upstream.status, text)) break
    }

    // Every key refused, or the first one failed for a reason no other key
    // would fix. Either way the app sees the vendor's own error, unwrapped.
    const out = new Headers({ ...cors, ...quotaHeaders(quota) })
    out.set('Content-Type', 'application/json')
    out.set('Cache-Control', 'no-store')
    return new Response(last?.text || JSON.stringify({ error: { message: 'Upstream failed.' } }), {
      status: last?.status ?? 502,
      headers: out,
    })
  },
}
