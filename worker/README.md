# Gemini proxy (optional)

A Cloudflare Worker that holds one Gemini key server-side, so the deployed app
can be shared as a link instead of asking every visitor for their own key.

## Read this before deploying it

The app's default is to call Google directly from the browser. No sheet touches
any server you run.

This Worker gives that up. Every sheet analysed through it passes through your
Cloudflare account. Cloudflare does not retain request bodies by default, and
`index.js` never logs one — keep it that way. If you add debugging, do not log
`request.body`.

The passphrase is what stands between your Gemini quota and anyone who finds the
Worker URL. It is not decoration.

## Deploy

From this directory. `wrangler` needs a browser login the first time.

```sh
npx wrangler login
```

Set the two secrets. Neither is ever written to a file in this repo:

```sh
npx wrangler secret put GEMINI_KEY   # paste your AIza... key
npx wrangler secret put APP_TOKEN    # invent a long passphrase
```

For `APP_TOKEN`, generate something you would not want to guess:

```sh
openssl rand -base64 24
```

Check that `ALLOWED_ORIGIN` in `wrangler.toml` matches where the app is served
from — origin only, no path and no trailing slash. For the GitHub Pages
deployment that is `https://<user>.github.io`. Add a comma-separated second entry
if you also want the dev server to reach it, e.g.
`https://bigmoney21682-hub.github.io,http://localhost:5190`.

```sh
npx wrangler deploy
```

Wrangler prints the Worker URL. Then in the app: **Settings → Proxy URL**, paste
that URL, enter the passphrase, Save. Hit **Test proxy & list models** — it
should list models with the key field left empty.

## Why it refuses things

- **401** — passphrase missing or wrong. Compared as a SHA-256 digest so the
  comparison takes the same time regardless of where it first differs.
- **403** — the calling origin is not in `ALLOWED_ORIGIN`.
- **404 "does not forward"** — the path is not one of the three the app uses.
  The allowlist exists so a leaked passphrase cannot turn this into an open
  relay to every Google API the key can reach.

## Cost

Workers' free tier is 100k requests/day, and one analysis is one request. The
Gemini key behind it is the thing with a real quota — a dense sheet at full
resolution is not a cheap request, and every tester shares your quota.

Rotate the passphrase by running `wrangler secret put APP_TOKEN` again; every
client then needs the new one, which is the intended blast radius.
