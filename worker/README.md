# Shared model proxy

A Cloudflare Worker that holds **pools** of API keys server-side, so the
deployed app can be shared as a plain link instead of asking every visitor for
their own key. When one key runs out of free quota the Worker rotates to the
next, so the link does not go down at the first daily cap.

It fronts two vendors:

| Vendor | Mounted at | Keys | Why |
| --- | --- | --- | --- |
| Google (Gemini) | `/` | `GEMINI_KEYS` | the default |
| Groq | `/groq` | `GROQ_KEYS` | second vendor to fall over to, **and** the only way a browser can reach Groq at all — it sends no CORS headers |

## Read this before deploying it

The app calls Google directly from the browser whenever the viewer has supplied
their own key. No sheet touches any server you run in that case, which for a
customer's service manual is a deliberate property and not an accident of
the architecture.

This Worker gives that up for everyone who has no key of their own. Every sheet
analysed through it passes through your Cloudflare account. Cloudflare does not
retain request bodies by default, and `index.js` never logs one — keep it that
way. If you add debugging, do not log `request.body`.

**It also spends your quota on strangers.** A URL in a published app is a URL
that will be found. Four things stand between the pool and abuse, and you
should set all of them:

| Control | Where | Default |
| --- | --- | --- |
| Origin allowlist | `ALLOWED_ORIGIN` in `wrangler.toml` | set to the Pages origin |
| Path allowlist | `ALLOWED_PATHS` in `index.js` | the three endpoints the app calls |
| Per-IP daily cap | `RATE_LIMIT` KV + `DAILY_CAP` | **off until you bind the KV namespace** |
| Passphrase | `APP_TOKEN` secret | **off until you set it** |

The passphrase is optional because a public app cannot really keep one secret —
it ships in the JavaScript bundle. Set it anyway if the proxy is for a team
rather than the public; it stops casual scripted use of the URL. For a genuinely
public deployment the origin allowlist and the daily cap are doing the work.

## Deploy

From this directory. `wrangler` needs a browser login the first time.

```sh
npx wrangler login
```

Set the key pools — comma- or newline-separated lists. Free keys are free, so
several from different accounts is the cheapest way to multiply the quota
behind a shared link:

```sh
npx wrangler secret put GEMINI_KEYS   # AIzaOne,AIzaTwo,AIzaThree
npx wrangler secret put GROQ_KEYS     # gsk_one,gsk_two
```

`GROQ_KEYS` is optional. Without it the `/groq` routes return a 500 naming the
missing secret, and the app's vendor fallback simply stops at Gemini.

Bind a KV namespace so the per-IP cap actually applies:

```sh
npx wrangler kv namespace create RATE_LIMIT
```

Paste the id it prints into the commented `[[kv_namespaces]]` block in
`wrangler.toml` and uncomment it. Adjust `DAILY_CAP` to taste.

Optionally set a passphrase:

```sh
npx wrangler secret put APP_TOKEN     # openssl rand -base64 24
```

Check that `ALLOWED_ORIGIN` in `wrangler.toml` matches where the app is served
from — origin only, no path and no trailing slash. For the GitHub Pages
deployment that is `https://<user>.github.io`. Add a comma-separated second
entry if you also want the dev server to reach it.

```sh
npx wrangler deploy
```

Wrangler prints the Worker URL. Put it in `SHARED_PROXY_URL` at the top of
`src/lib/proxy.ts` (and `SHARED_PROXY_TOKEN` if you set a passphrase) and
rebuild — that is what makes the shared service the app's built-in default. A
viewer can still point at a different deployment under **Settings → Proxy URL**,
or turn the shared service off entirely.

## The allowance endpoint

`GET /quota` reports the caller's remaining daily allowance **without spending
any of it**, which is what lets the app show a meter on its homescreen before
anyone has uploaded anything:

```json
{ "enabled": true, "limit": 40, "used": 12, "remaining": 28, "reset": "2026-08-23T24:00:00Z" }
```

`enabled: false` means no KV namespace is bound, so there is no cap and the app
renders no meter rather than an invented one. Every proxied response also
carries the same figures as `X-Quota-Limit` / `-Used` / `-Remaining` / `-Reset`
headers, listed in `Access-Control-Expose-Headers` so the browser may actually
read them — that is what keeps the meter current without a second round trip.

## How a request picks its key

Three nested chains, outermost first. They exist separately because they fail
for unrelated reasons, and none can fix another's problem:

1. **Vendor** (`src/lib/providers/index.ts`) — Gemini, then Groq.
2. **Credential** (`src/lib/proxy.ts`) — the viewer's own key, then a custom
   proxy, then this shared Worker.
3. **Model** (`src/lib/providers/fallback.ts`) — the chosen model, then the
   next best one that credential can reach.

A whole level is skipped when it is exhausted rather than failing the request.
The total is capped at 7 upstream calls per analysis, so a bad day surfaces as
an error rather than a half-minute of silent retrying.

Server side, this Worker then walks its own pool. The starting key is chosen at
random per request so one key does not absorb everything and hit its cap alone.
Only key-shaped faults advance the pool — a 429, a disabled project, a revoked
key. A malformed request or a safety block returns immediately, because it
would fail identically on every key.

## Why it refuses things

- **401** — passphrase missing or wrong, and `APP_TOKEN` is set. Compared as a
  SHA-256 digest so the comparison takes the same time regardless of where it
  first differs.
- **403** — the calling origin is not in `ALLOWED_ORIGIN`.
- **404 "does not forward"** — the path is not one the app uses. Each vendor
  has its own allowlist, so a leaked URL cannot turn this into an open relay to
  every API the keys can reach.
- **413** — the request body is over 12 MB. Not a page of a service manual.
- **500 "no GEMINI_KEYS/GROQ_KEYS secret"** — that vendor's pool is unset.
- **429 "daily limit for your address"** — the per-IP cap. The app tells the
  viewer to add their own key, which costs them nothing and costs you nothing.

## Cost

Workers' free tier is 100k requests/day and 1k KV writes/day, and one analysis
is one request plus one KV write. The Gemini keys behind it are the thing with a
real quota. Rotate the pool with `wrangler secret put GEMINI_KEYS` at any time;
clients need no change, since they never see a key.
