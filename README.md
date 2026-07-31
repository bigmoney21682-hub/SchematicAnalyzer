# Schematic Analyzer

Upload a schematic. Get a block diagram of the circuit, every supply rail and where it
comes from, which grounds are actually the same net, what each LED means, and where to put
a probe — then ask follow-up questions about the sheet.

Everything runs in the browser against your own Gemini key. There is no backend and
nothing passes through the host serving the app.

```bash
npm install
npm run dev      # http://localhost:5190
```

The dev server is pinned to **5190** with `strictPort`, chosen to stay clear of the other
dev servers on this machine (3000, 5000, 5005, 5173, 5180, 8000, 8080, 8443). If it is ever
taken it fails loudly rather than drifting onto another port. `npm run dev:lan` adds a
self-signed cert so a phone on the same Wi-Fi gets a secure context — and with it the
service worker, the install prompt and `crypto.randomUUID`.

**Demo mode** (Settings → provider) runs the whole app with no key and no network against a
canned analysis of an offline SMPS. It exercises every section, so it is also how the UI
gets checked.

---

## What comes back

One structured report per sheet, rendered in the order you would actually work through it:

| Section | What it holds |
|---|---|
| **Safety** | Mains potential, stored energy, where the isolation barrier runs. First on the page, in red. |
| **Block diagram** | 4–12 functional blocks, laid out and wired. Tap a block for what's in it. |
| **Power rails** | Each rail, its voltage, the part that makes it, what it feeds, where to measure it. |
| **Grounds** | Each return as its own net, with where — and whether — the sheet ties them together. |
| **Indicators** | Every LED: what drives it, off which rail, and what each state means to someone standing in front of the unit. |
| **Test points** | Where to probe, what to measure against, the expected reading, and what a wrong one points at. |
| **How it works** | An ordered walkthrough of the circuit. |
| **Signals, connectors, components** | The named nets worth following, pinouts, and the parts that shape the behaviour. |
| **Couldn't be read** | Exactly what the scan was too coarse to resolve, and where it sits. |

Every claim carries how it was arrived at — `read` off the sheet, from the `symbol`,
`inferred` from topology, or an admitted `guess` — plus a confidence dot. Then a chat panel
takes follow-ups against the same image, so "no power at all, where do I start" gets
answered against your sheet rather than against circuits in general.

Reports are saved to `localStorage` automatically, with a thumbnail, and you can carry on
asking questions about an old one.

---

## The block diagram

The model returns blocks and connections; `src/lib/layout.ts` places them. It is a layered
(Sugiyama-style) layout cut down to what a dozen nodes needs:

1. **Break cycles.** Feedback paths are the point of half these circuits, so back edges are
   kept and drawn as loops round the outside rather than dropped.
2. **Layer by longest path** from an input, so power enters at the top and works down to the
   loads.
3. **Order within a layer** by barycentre sweeps — the cheap classical fix for crossings, and
   more than enough at this size.
4. **Route.** Adjacent layers get an orthogonal elbow straight down the page. Anything else —
   a feedback path, or a rail reaching a load four layers below — takes a lane down the right
   rather than driving its vertical run through whatever boxes sit between.

Top-to-bottom rather than left-to-right is a phone-first choice: a wide diagram needs
horizontal scrolling on a 390px screen, and a tall one is just a page.

Wires are coloured by what flows (power amber, feedback pink dashed, control cyan…) and
blocks carry a tint by kind. An edge whose endpoints don't exist in the block list is
dropped before layout — a diagram that invents a block is worse than one missing an edge.

---

## PDFs

Service manuals are PDFs and the sheet you want is page 47 of 210, so PDFs are a first-class
input. Pick a file and you get a page picker (thumbnails, plus a jump-to-page box once the
document is bigger than a screenful); the page you choose is rendered at analysis resolution
and goes straight into the same path an image would.

pdf.js is most of this app's JavaScript and most sessions never touch it, so it is fetched
the first time a PDF actually appears.

**Two pdf.js traps**, both of which cost a hang with nothing in the console:

- **Its data files.** pdf.js keeps the standard fonts, the Adobe CJK character maps, the ICC
  profiles and the wasm decoders outside its bundle and will not guess where they are. Given
  no URL it asks on a path relative to its worker, which lands on the SPA fallback — it gets
  an HTML document where it expected a font and the render promise never settles. The
  character maps matter most: a Japanese service manual drawn as vector PDF reaches its kanji
  through one of them. `vite.config.ts` copies the four directories into `public/pdfjs`, and
  the service worker caches them on first use rather than precaching four megabytes nobody
  may need.
- **Transparency.** A PDF page has no background of its own. A schematic rendered onto
  transparency is black lines on nothing, which encodes to black-on-black the moment it hits
  a JPEG. Every page is composited onto white first.

---

## Resolution is the whole game

A schematic is a text document that happens to be drawn. Everything that makes it useful —
designators, values, net labels, the title block — is small text, and small text is the
first thing a downscale destroys.

- Sheets go to the model at up to **3072px** on the long edge, well above what a photo would
  need. That is roughly where a 2mm designator on a scanned A3 sheet stops being resolvable.
- Re-encodes use **JPEG q0.94**, because ringing gathers around exactly the feature a
  schematic is made of — a thin black line on white — and at the usual 0.8 it is enough to
  turn an 8 into a 6.
- A lossless original small enough to send as-is is sent untouched, and the UI says which
  happened, because it changes how much to trust a borderline character.
- PDF pages are rendered straight to PNG so nothing lossy touches them before the analysis
  does.

The same logic drives model selection: Settings → **Test key & list models** picks the
strongest model your key can reach rather than the fastest, because reading 7px designators
is where the models differ most.

---

## What it refuses to do

The prompt (`src/lib/prompt.ts`) is where the quality lives, and it is built around three
failure modes:

- **Confabulating text off a coarse scan.** A wrong value stated confidently is worse than an
  admitted blank, so illegible parts are described by position and symbol and listed under
  "couldn't be read".
- **Continuing a net off the sheet.** Schematics use net labels and off-page connectors
  precisely so a wire can leave the page. It says where a net is labelled as going, and stops.
- **Getting an isolation barrier wrong.** On an offline supply the primary side sits at mains
  potential and its return is not chassis. Merging those in a ground list is the one error
  here that can hurt somebody.

It also never phrases a schematic reading as a diagnosis of a specific unit: a schematic is
the intended design, and says nothing about a cracked joint or a part fitted at the wrong
value.

---

## Your key

Stored in this browser's `localStorage`, sent only to Google's endpoint. Because this is a
static site the key is readable by anything running in the browser — restrict it by referrer
and rotate it if you share the device. A free-tier AI Studio key lets Google train on what
you send it; a paid key does not, which matters when service manuals are usually somebody's
copyright.

The key diagnostics in Settings catch the common failure before it costs you a request:
pasting a key on a phone picks up trailing newlines and zero-width characters remarkably
often, and Google rejects those with "API key not valid", which reads like the key is wrong
when it is only dirty.

---

## Project layout

```
src/
  lib/
    types.ts            the domain model — rails, grounds, indicators, test points
    prompt.ts           system prompt, JSON shape, chat prompt
    layout.ts           block-diagram layout: layering, ordering, routing
    image.ts            resize, encode, thumbnail
    pdf.ts              PDF loading and page rendering (lazy-loaded)
    storage.ts          key, model, provider and saved reports
    apikey.ts           key sanitising and diagnostics
    proxy.ts            optional Worker proxy settings
    providers/
      gemini.ts         structured output, streaming chat, model listing
      mock.ts           demo mode
      index.ts          registry and model ranking
  components/
    Capture.tsx         landing screen and file input
    PdfPicker.tsx       page picker for PDFs
    Results.tsx         the report
    Diagram.tsx         the block diagram
    Chat.tsx            follow-up questions
    History.tsx         saved reports
    Settings.tsx        provider, key, model, proxy
worker/
  index.js              optional Cloudflare Worker holding the shared key
```

The previous version of this project — a rules/OCR/tracing pipeline that drew an overlay on
top of the scan — is on the `legacy-rules-pipeline` branch.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`.
Enable Pages with source **GitHub Actions** in the repo settings once; after that every push
redeploys.

It is a pure static site otherwise — `npm run build` and serve `dist/` anywhere. The base
path defaults to `./`, which is path-independent; CI sets `BASE_PATH=/<repo>/` because the
service worker's scope and navigation fallback are resolved against the origin rather than
the page, and a relative base would scope the installed PWA to the domain root.

The 3.9 MB of pdf.js fonts, CJK maps and wasm decoders are copied out of `node_modules` at
build time by a plugin in `vite.config.ts`, so they ship without being committed.

### Sharing the link without sharing a key

By default each visitor supplies their own Gemini key. `worker/` is a Cloudflare Worker that
holds one key server-side and gates access with a passphrase, so a link can be handed to
someone who has no key of their own. Deploy it, then fill in **Settings → Proxy URL** and the
passphrase. Every sheet then passes through your Cloudflare account and spends your quota —
see `worker/README.md` before you deploy it.
