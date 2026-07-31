/**
 * Gemini proxy for the Schematic Analyzer app.
 *
 * The app is a static site, so any key it ships is public — see the note at the
 * top of src/lib/providers/gemini.ts. This Worker exists so that one key (yours,
 * held as a Cloudflare secret) can serve a shared link without that key ever
 * reaching a browser.
 *
 * The cost of that convenience: every sheet analysed through this Worker passes
 * through your Cloudflare account on its way to Google, where before it went
 * browser-to-Google directly. Nothing here writes a request body anywhere, and
 * it must stay that way — a single console.log of the body would put whole
 * service manuals into your log tail.
 */

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Only the three endpoints the app actually calls. Without this the Worker is
 * an open relay to everything the key can reach the moment the token leaks —
 * including endpoints that bill at a very different rate.
 */
const ALLOWED_PATHS = [
  /^\/models$/,
  /^\/models\/[A-Za-z0-9._-]+:generateContent$/,
  /^\/models\/[A-Za-z0-9._-]+:streamGenerateContent$/,
]

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
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function fail(status, message, request, env) {
  // Shaped like Google's own error body so the app's friendlyError() can read
  // it without needing to know a proxy is in the path at all.
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  })
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    // No allowed origin matched, so the browser would discard the response
    // anyway. Saying so plainly beats letting it fail as an opaque CORS error.
    if (!cors['Access-Control-Allow-Origin'])
      return fail(403, 'This proxy does not serve that origin. Check ALLOWED_ORIGIN.', request, env)

    if (!env.GEMINI_KEY) return fail(500, 'The proxy has no GEMINI_KEY secret set.', request, env)
    if (!env.APP_TOKEN) return fail(500, 'The proxy has no APP_TOKEN secret set.', request, env)

    const token = request.headers.get('X-App-Token') ?? ''
    if (!token || !(await safeEqual(token, env.APP_TOKEN)))
      return fail(401, 'Wrong or missing passphrase for this proxy.', request, env)

    const url = new URL(request.url)
    if (!ALLOWED_PATHS.some((re) => re.test(url.pathname)))
      return fail(404, `This proxy does not forward ${url.pathname}.`, request, env)

    // The client never supplies the key; strip it in case anything upstream
    // tries, so a caller can't pin the request to some other billing account.
    const params = new URLSearchParams(url.search)
    params.delete('key')
    params.set('key', env.GEMINI_KEY)

    const upstream = await fetch(`${GOOGLE}${url.pathname}?${params}`, {
      method: request.method,
      headers: { 'Content-Type': request.headers.get('Content-Type') ?? 'application/json' },
      body: request.method === 'GET' ? undefined : request.body,
    })

    // Passing upstream.body straight through keeps the SSE stream a stream —
    // buffering here would turn the chat's token-by-token output into one lump
    // arriving after the whole answer is done.
    const headers = new Headers(cors)
    headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json')
    headers.set('Cache-Control', 'no-store')

    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
