# Schematic Analyzer

A PWA that reads scanned Japanese schematics and produces an **annotated overlay**:
traced nets colour-coded by function, functional blocks, bilingual captions, suggested
probe points, and an exportable report.

Everything runs in the browser. No server, no upload.

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

The dev server is pinned to **127.0.0.1:5173** with `strictPort`, chosen to stay clear of
the other dev servers on this machine (3000, 5005, 8000, 8080, 8443). If 5173 is ever
taken it will fail loudly rather than drift onto another port.

There's a **Try a 2-sheet sample** button on the landing screen — a synthetic Japanese
PSU/MCU sheet plus the audio output sheet it drives, sharing rails and a connector — so you
can see the whole pipeline, cross-sheet linking included, without hunting for a scan.

---

## What it actually does

**Input:** scanned PDF, PNG or JPEG — as many files as you like. A multi-page PDF, a folder
of scans and a handful of phone photos are all flattened into one ordered list of **sheets**,
and every sheet is analysed.

1. **Prepare** — adaptive local threshold (handles the shadow gradient you get
   photographing a thick manual), then deskew via projection-profile variance.
2. **OCR** — Tesseract with `jpn`+`eng` together, because these drawings mix scripts
   constantly. Recall collapses below ~30px glyph height, and a printed reference
   designator is about 1/200th of a sheet — twelve pixels on the analysis raster, which is
   why perfectly legible text used to come back as nothing. So the page is re-rendered for
   the recogniser at up to 4000px on its long edge (the most that clears iOS's 4096px
   canvas limit), from the PDF's own vectors where there are any rather than by upscaling
   a raster, which invents no detail. Each sheet is then read **twice**: once in Tesseract's
   default mode, which does layout analysis and is what gets the Japanese captions and the
   title block right, and once in sparse mode, which does none and is the only way the
   two-character designators floating alone in a field of wires are found at all. The
   readings are merged, keeping whichever was more confident.
3. **Trace** — long horizontal/vertical ink runs become conductors, merged across stroke
   thickness. Closed rectangles are pulled out as component bodies (see below). Junctions
   are classified by looking for a solder dot.
4. **Detect symbols** — connected components on the residual ink, plus the rectangles from
   step 3. Reference designators and values are attached by proximity.
5. **Interpret** — rules assign each net a role, with evidence ranked: an explicit net
   label beats a Japanese caption, which beats a part-database inference, which beats
   pure topology. Learned part kinds are applied before this, learned net roles after —
   see *Learning from corrections*.
6. **Annotate** — notes, translations, probe points, and review flags.

A sheet can be turned a quarter turn at a time from the viewport (↺ / ↻), which is the
normal fix for a landscape drawing photographed portrait. The turn is applied to the sheet
itself — raster *and* every entity traced off it — so it lands in the exports and survives a
reload. It does not re-read the text: a caption OCR'd from a sideways scan stays misread,
so a sheet that arrived rotated is better turned and then re-analysed.

Steps 1-6 run per sheet. Then, once, for the document:

7. **Link the sheets** — see below.

**Output:** annotated PNG and vector SVG (source embedded, annotations as real geometry, so
it stays editable in Inkscape) per sheet or for every sheet at once, plus one Markdown report
and one JSON model covering the whole document.

### Layers

Everything drawn on top of the scan is switchable from **Layers**, and the exports follow
the switches exactly — an SVG exported with a layer off does not contain it, legend
included. Three of them select what the nets layer draws:

- **Power & ground nets** — power, ground and voltage references. Alone on screen, this is
  the view for chasing a supply.
- **Signal nets** — everything else, unclassified nets included.
- **Flow direction arrows** — which way it goes. Off by default.

The arrows are **inferred and labelled as such**: a traced net is undirected copper, and
nothing in the drawing states a direction. One anchor is picked per net and the segments
are oriented by distance from it —

| net | anchor | arrows |
|---|---|---|
| ground | the ground symbol on it, else the bottom of the net | point **toward** it — return current |
| power / reference | a regulator, transformer, connector or fuse pin on it, else the top of the net | point **away** |
| everything else | an IC, transistor, crystal or connector pin on it, else the left end | point **away** — the driver |

Unclassified nets get no arrows at all — there is nothing to reason from, and guessing a
direction for a net whose role was never established would be inventing detail.

The fallbacks are the conventions schematics are actually drawn with: supplies enter from
the top, signals run left to right. On the Manhattan trees these drawings are made of, the
distance ordering agrees with a proper graph traversal nearly everywhere, and where it does
not it costs one locally-wrong arrow — never a wrong net. Correct a net's role and the
arrows follow.

---

## Multi-sheet documents

A board's schematic almost never fits on one page, and the sheets are not independent
drawings — they are one circuit drawn in instalments. Analysing them one at a time can tell
you what is *on* sheet 3 but not what sheet 3 *does*.

So the document is the unit. Every entity carries the sheet it came from, ids are namespaced
per sheet, and after each sheet is analysed the links between them are reconstructed from the
three conventions draughtsmen actually use:

| Signal | Confidence | Why |
|---|---|---|
| A net label read on two sheets (`+5V`, `B+`, `SDA`) | high | The draughtsman saying outright that this is one node. Spellings are folded numerically, so `5V`, `+5 V` and `+5.0V` are one rail. |
| Ground on several sheets, unlabelled | medium | Global by convention — but nothing on the drawing says so. |
| The same voltage found independently, no shared label | low | Boards do run one rail everywhere; they also run a switched *and* an always-on 12V. |
| The same connector designator on two sheets (`CN3`) | medium | The physical hand-off: the nets on its pins continue, pin for pin, on the far sheet. |

Two things fall out of this that a page-at-a-time tool cannot do:

- **Evidence is carried between sheets.** If `+5V` is crisply printed on the power supply
  sheet and a smudge on the logic sheet, the smudge inherits the good reading — one step down
  in confidence, provenance `cross-sheet`, and a rationale line naming the sheet it came
  from. Your own corrections propagate the same way when you re-run interpretation.
- **Questions are answered across the whole document.** "What does +5V feed?" returns the
  consumers on every sheet, broken down per sheet, rather than the third of them that happen
  to be on the sheet you are looking at.

A non-connector reference designator appearing on two sheets is *not* treated as a link — it
is reported as a warning, because it is usually an OCR misread.

**Working with sheets:** the strip at the top of the canvas switches between them (arrow keys
too); lists in the side panel toggle between *this sheet* and *all sheets*; the **Sheets** tab
shows the links, and per-sheet trace coverage so a single bad scan among good ones is easy to
find. **Add sheets** appends more files to an open document — already-analysed sheets and your
corrections are left untouched, and only the links and pooled statistics are recomputed.

Long runs are interruptible: **Stop** keeps the sheets already finished and records what was
skipped, rather than throwing away ten minutes of OCR.

---

## The library

Every analysis is saved automatically and lives in a folder tree, reachable from the
landing screen and from **Library** in the toolbar. Rename, move between folders, delete.
Deleting a folder lifts its contents to the parent rather than taking the schematics with
it — an hour of OCR sits behind each of those rows.

Listing is deliberately cheap. A separate `meta` store holds one small record per document
(name, folder, counts, a 320px thumbnail), so opening the library never decodes a full-page
raster. Only the document you actually open is read in full.

### Shared, not per-user

The library is **shared**. There are no accounts and no per-user partitioning: everyone
who can reach the URL sees, opens and edits the same schematics. That is the point — a
manual analysed on the laptop is on the phone a minute later.

Two stores, and neither is "the" store:

| | holds | written |
|---|---|---|
| IndexedDB | the working copy | first, immediately, on every save |
| `data/` on the server | the shared copy | a few seconds later, in the background |

Every save lands locally first and every read falls back to it, so the PWA still works
with no signal — and an upload never sits on the critical path of an edit. When the two
copies disagree the newer `updatedAt` wins. That is last-write-wins, stated plainly: two
people editing one schematic at the same moment will have one overwrite the other. For a
shared bench tool that is the right trade against the machinery real merging needs, and
nothing is lost silently, because each device keeps whatever it last saw.

A pill in the toolbar says which world you are in — `● Shared`, `◍ Syncing…`,
`⚠ Not uploaded`, or `○ Local` when no server is reachable. Documents this browser has
that the server has not seen are listed anyway, marked "on this device only"; they upload
themselves on the next startup that reaches the server.

**What is not uploaded:** the original PDFs and photos. They exist so a zoomed-in sheet
can be redrawn from the real thing, they are ten to twenty times the size of everything
else, and they stay on the device that did the analysis. The shared copy holds the
analysis and the sheet rasters — sharp to about 150% on any device, sharper than that on
the one that uploaded it.

On disk:

```
data/
  schematics/<id>.json        the document: analysis + sheet rasters
  schematics/<id>.meta.json   name, folder, counts, thumbnail
  folders.json                the library tree
```

Plain files, no database. `server/store.mjs` is the whole API — dependency-free, mounted
as Vite middleware in development and by `server/index.mjs` in production, so there is one
implementation rather than two that drift. Writes go to a temp file and are renamed, so a
phone pulling the library mid-write never sees truncated JSON.

## Sharp at any zoom

The analysis raster is capped at 2600px on its long edge — the resolution the tracer and
OCR want. Past roughly 150% zoom you are magnifying it, and the drawing's own printed text
goes soft exactly when you lean in to read a part number.

So the original upload is kept alongside the analysis, and the region **currently on
screen** is re-rendered from it once the view settles:

- a photo or scan is re-cropped from the full-resolution original;
- a PDF is re-rendered from its vectors, which are sharp at any magnification.

Cost is bounded by the size of the window, not the size of the drawing — a fifteen-sheet
manual costs exactly what a one-sheet one does. The tile's pixel budget is at least the
canvas backing store's own, because a tile smaller than the canvas it lands in arrives
pre-blurred however sharp the source was; when the budget does bind, the off-screen margin
is given up before any magnification is. The patch is painted *over* the magnified raster,
never instead of it, so the sheet is never blank while one is preparing — but it first
clears its own footprint to white, because a part-transparent sharp patch composited onto
an opaque soft one leaves both visible at once, which reads as worse than either.

Two things that are easy to get wrong and cost more sharpness than the tiling wins back:
the device-pixel ratio is honoured up to 3x rather than clamped to 2 (an iPhone reports 3,
and a phone-sized viewport at 3x is well inside the area budget that actually protects
iOS), and the fade that dims the scan under the overlay lifts as you close in — at
whole-page zoom the coloured nets are the point, but 35% grey ink is hard to read however
sharp it is, and by the time you are reading rather than surveying the scan is at full
strength.

The sheet on screen is not the source — it has been scaled, deskewed by a fraction of a
degree, and possibly turned by the user — so `core/image/detail.ts` composes those three
into one matrix and inverts it to work out which part of the original to cut. Documents
analysed before this existed simply keep the old behaviour; nothing breaks, it just does
not sharpen. Originals over 40MB are not kept, and any document's originals can be dropped
from the library to reclaim the space.

## Reading the symbols

Kind comes from the reference designator first, because a printed designator is the drawing
telling you outright what the part is. Both conventions are understood: the western `C55`
and the Japanese `55C` that Sony, Panasonic and Yamaha service manuals use — number first,
letter after. `55C` is capacitor 55, `12L` inductor 12, `7CN` connector 7, `2VC` a variable
capacitor.

Where there is no designator — and a ground symbol never has one — the strokes themselves
are measured, in `core/trace/shapes.ts`. Not a general shape classifier: a handful of
symbols are drawn distinctively enough that simple measurements settle them, and those few
are most of what is on a sheet. A capacitor is two parallel plates facing each other across
a gap. A ground is two or three horizontal bars stacked and shrinking. Where the two could
be confused, the *wiring* decides rather than the geometry — a capacitor is fed on both
faces, a ground on one.

Two details make this work at all:

- Connected-component labelling sees a capacitor as **two** blobs, because its plates do
  not touch. Pairing the strokes back up is what makes it one component; naming it is
  almost a side-effect.
- More awkwardly, a capacitor plate is a few millimetres of horizontal rule, and the wire
  tracer claims any run longer than about twenty pixels. So the plates and every bar of
  every ground symbol are already filed as *wire* before symbol detection looks at the
  leftover ink. They are therefore read back out of the traced strokes as well — which
  turns out to be the better measurement anyway, since those are clean vectors with
  endpoints and orientation rather than pixels.

A shape never overrides a designator or a part number; it fills the gap where there is
neither, and corroborates where there is. Naming a ground pays off immediately elsewhere: a
conductor terminating on one **is** the return, which beats the old fallback of guessing
that the longest, most-connected net is probably ground.

Symbols that still cannot be named come out as **Unidentified**, and the
inspector offers a kind picker plus one-tap chips for the common ones. The **Parts** tab is
the same thing in bulk — unidentified first, a picker on every row — because after
analysing a sheet you usually have thirty of them, not one.

Naming them is not bookkeeping. Component kinds feed the net classifier (regulators define
rails, crystals define clocks) and the functional blocks are built from them, so learned
part kinds are applied *before* nets are classified. Every symbol you name makes the next
re-run better wiring, not just a better parts list.

## Learning from corrections

Correct the same thing twice and the tool should stop asking. Two decisions are learned and
they are the same problem twice over — what a **net** is, and what a **component** is — so
both run through one scorer in `core/learn/model.ts`, differing only in feature extraction:

- **nets:** label text and its shape, nearby Japanese captions by their lexicon reading,
  length and connection buckets, stroke weight, neighbouring part kinds;
- **components:** refdes prefix, part number and the unit its value parses as, outline
  aspect and size, pin count, the roles of the nets it sits on.

Counts of features against classes, scored as naive Bayes over the features it has seen
before. It learns from a single example, costs nothing on a phone, and one wrong entry can
be deleted without retraining anything.

Three commitments, all following from the fact that someone has to trust the output:

- **Rules first, always.** Nothing runs until the rule engine has had its say, and it only
  revises conclusions the rules were unsure of — *unless* the same correction has been made
  twice on an identical net label or part number, which is a standing correction rather
  than a guess.
- **Never overrule the user.** A role or kind you set by hand is final on that entity.
- **Explain, in the same breath.** Everything it assigns writes a rationale naming what it
  learned from and how often, so an inherited mistake is visible.

That last one is load-bearing, and it constrains the model rather than just describing it.
Features like *"the rules gave up on this"* or *"it has no reference designator"* are true
of every entity the model is allowed to revise, so they are perfectly correlated with being
asked the question and say nothing about the answer. They still contribute to the score,
where the arithmetic cancels them across classes, but they cannot be the evidence that
justifies acting and are never quoted as a reason — otherwise two corrections would relabel
every unidentified blob on the sheet and explain itself with *"parts like this one — first
read as unknown"*. Until the model knows more than one class in a category it has nothing
to choose between, so everything it offers is marked low confidence.

The **Learned** tab lists everything it holds, in the terms it learned them ("you have
called B+ a power rail 3 times"; learned part numbers shown as additions to the built-in
part database), with a *Forget* button on each. Nothing is uploaded; the model lives in
IndexedDB beside the schematics.

## The design commitment: annotate, never redraw

The source raster is never modified. Turn every layer off and you are looking at exactly
the scan you uploaded.

This is deliberate. Regenerating a "clean" schematic from an imperfect trace produces a
drawing that *looks* authoritative while quietly containing connections that were never in
the original. On a repair bench that is worse than useless. So the tool draws on top of
your scan and tells you what it thinks, with its reasoning attached.

Two things follow from that:

- **Every conclusion carries its rationale.** Click any net, part or block and you get the
  actual chain of evidence, plus a confidence level and where it came from
  (`ocr` / `partdb` / `topology` / `heuristic` / `cross-sheet` / `user`).
- **Ambiguity is surfaced, not resolved silently.** A wire crossing with no solder dot is
  genuinely ambiguous. It is treated as a hop *and* flagged on the overlay and in the
  Quality tab, so you can check it against the original.

Your corrections always win: editing a net's role sets its provenance to `user`, and
"Re-run interpretation" rebuilds the functional blocks on top of your edits.

---

## Japanese handling

A curated lexicon (`src/core/jp/lexicon.ts`, ~180 terms) rather than a general translator.
It's offline, instant, and — the real reason — it maps terms straight onto the analyzer's
own semantic roles:

| On the drawing | Reading | Means | Analyzer infers |
|---|---|---|---|
| 電源 | dengen | power supply | power rail, power-supply block |
| 接地 / アース | setchi / aasu | ground / earth | ground net |
| 三端子レギュレータ | san-tanshi-regyureeta | 3-terminal regulator | regulator part, regulation block |
| 水晶発振子 | suishou-hasshinshi | crystal resonator | crystal, clock block |
| 保護回路 | hogo-kairo | protection circuit | protection block |
| 測定点 | sokuteiten | test point | probe point |
| 注意 / 危険 | chuui / kiken | CAUTION / DANGER | safety callout |

Part numbers decode the JIS families these manuals are full of: `2SC1815` (and the very
common bare `C1815`), `μPC`, `TA`, `AN`, `BA`, `HA/HD`, `LA`, `M5`, plus `78xx`/`79xx`,
`LM317`, `1N400x`, `RD5.1` zeners and the usual 74xx/4000 logic.

---

## Asking questions

The **Ask** tab is a deterministic rules engine over the extracted model — offline, free,
and it cites its evidence. It handles what people actually ask a schematic:

- "what does +5V feed?" · "what are the rails?"
- "how do the sheets connect?" · "what is on sheet 3?"
- "what is Q3?" · "how many capacitors?"
- "where should I probe?" · "what blocks did you find?"
- "what does 電源 mean?" · "how reliable is this analysis?"

When it can't answer, it says so rather than bluffing.

**Optional AI escalation** (off by default, `Ask → settings`): supply an Anthropic API key
and unanswered questions get escalated. Only the *text summary* of the extracted model is
sent — never the image, unless you tick the box. The key is stored in your browser and
sent straight to the provider; there is no backend. AI answers are visibly tagged so they
are never confused with a deterministic result.

---

## Honest limitations

Net extraction from a raster is genuinely hard, and this is v1. Read the **Quality** tab —
it reports trace coverage, OCR confidence, and every warning.

- **Trace coverage below ~20% means don't trust the connectivity.** Faint scans and very
  thin wires are the usual causes.
- **OCR recall on small text is the weakest link.** Refdes and values printed small are
  frequently missed, and that cascades: a missed part number means no part-database hit,
  which means a weaker functional block. Higher-resolution scans help a lot.
- **Cross-sheet links depend on OCR reading the labels.** If no label is read on two sheets
  and no connector designator repeats, the sheets stay unlinked and each is interpreted in
  isolation — the Sheets tab says so plainly rather than pretending otherwise. Confirming a
  couple of labels by hand and re-running interpretation fixes it.
- **Off-page connector arrows and sheet-reference symbols are not read.** Linking works from
  labels and designators only.
- **A big document can exceed the browser storage quota.** Photographed sheets are stored as
  high-quality JPEG to keep that at bay (line art that arrived lossless stays lossless); if a
  save still fails you are told, and exports keep working.
- **Diagonal wires are not traced.** The tracer assumes Manhattan routing, which covers
  the overwhelming majority of schematics but not all of them.
- **Rectangles are assumed to be component bodies.** This is what stops an IC outline
  shorting VCC to GND — a failure that otherwise cascades into one enormous bogus net.
  The trade-off is that a genuine rectangular *wire loop* would be misread as a part.

---

## Project layout

```
src/
  core/
    analyze.ts          per-sheet pipeline + multi-sheet orchestration
    link/sheets.ts      cross-sheet net/connector linking, evidence propagation
    model/types.ts      document model + palette
    model/sheet.ts      sheet id namespacing and per-sheet views
    image/raster.ts     load, threshold, deskew, morphology
    image/detail.ts     high-resolution redraw of the visible region
    image/pdf-worker.ts pdf.js worker entry, with the compat shims installed
    image/pdf-assets.ts where pdf.js finds its fonts/CJK maps, and render intent
    learn/model.ts      learning from net reclassifications
    compat/modern.ts    shims for JS that pdf.js uses and iOS Safari lacks
    edit/rotate.ts      quarter-turn rotation of a sheet, raster and geometry
    trace/wires.ts      conductors, junctions, nets, rectangle extraction
    trace/symbols.ts    component blobs and pin attachment
    trace/shapes.ts     naming a symbol from its strokes (capacitor, ground, ...)
    ocr/ocr.ts          Tesseract wrapper, text classification, phrase grouping
    jp/lexicon.ts       Japanese schematic lexicon
    rules/parts.ts      part-number and refdes decoding
    rules/classify.ts   net roles, functional blocks, test points
    qa/engine.ts        offline question answering
    ai/adapter.ts       optional AI escalation
    export/exporters.ts PNG / SVG / Markdown / JSON
  render/overlay.ts     canvas renderer, hit testing, label collision avoidance
  render/flow.ts        inferred direction of flow, shared by canvas and SVG
  ui/                   Viewport, SidePanel, Toolbar, Library
  storage/db.ts         IndexedDB: documents, library metadata, folders,
                        original uploads, learned model
  storage/shared.ts     client for the shared library API
  storage/library.ts    shared-first / local-always policy over both stores
  dev/sample.ts         synthetic 2-sheet sample (also the test fixture)
server/
  store.mjs             the shared library API (dev middleware + production)
  index.mjs             production server: dist/ + the API
```

## Two pdf.js traps

Both cost a hung progress bar with nothing in the console, so they are worth naming.

**Its data files.** pdf.js keeps the standard Type 1 fonts, the Adobe CJK character maps,
the ICC profiles and the wasm decoders outside its bundle and will not guess where they
are. Given no URL it asks on a path relative to its worker, which lands on the SPA
fallback — it gets an HTML document where it expected a font and the render promise never
settles. The character maps matter most here: a Japanese schematic drawn as vector PDF
reaches its kanji through one of them. `vite.config.ts` copies the four directories into
`public/pdfjs`, `core/image/pdf-assets.ts` points pdf.js at them, and the service worker
caches them on first use rather than precaching four megabytes nobody may need.

**Its render loop.** For its default `display` intent pdf.js drives rendering with
`requestAnimationFrame`, and browsers do not fire those for a tab that is not visible.
Nothing here paints a PDF to the screen — every render is an offscreen rasterisation whose
pixels are then copied out — so backgrounding the tab, which is the normal thing to do
while a twenty-sheet manual is analysed on a phone, would stop every render in flight dead
with no error and no timeout. All three render sites use the `print` intent, which
schedules without `requestAnimationFrame` and finishes whether the tab is on screen or not.

## On a phone

Most of the use of this is one-handed, on an iPhone, at a bench. Below 900px the side
panel takes the bottom 45% of the screen, and everything in that panel that is not the
list you are working through is competing with it. So the re-run bar is one row — the
button and an ⓘ that unfolds the explanation, closed by default — the tabs and body lose
a few pixels of padding, and the bar honours `safe-area-inset-bottom`. That is about 80px
back, a fifth of the panel, and it goes to the list.

Touch targets stay 44px regardless: the bar shrinks, the things you hit do not.

## Offline / PWA

Installable, and works offline after the first run. Tesseract's wasm core and the ~15MB
Japanese language pack are fetched once from jsDelivr and cached by the service worker
(`CacheFirst`, 1 year) alongside tesseract.js's own IndexedDB cache. Your documents — every
sheet of them, plus the originals they were made from and the model your corrections have
trained — persist in IndexedDB, so the app reopens where you left off.

## Deploying

`base: './'` is set, so the build is path-independent — it runs from a domain root or a
subpath without a rebuild.

```
npm run build     # -> dist/
npm start         # serves dist/ + the shared library API on :8787
```

`PORT`, `HOST`, `DATA_DIR` and `DIST_DIR` are all environment variables.

**The shared library needs a host that runs Node and gives the process a directory that
survives a restart.** A purely static host (GitHub Pages, or the static tier of anything
else) has no disk to write to: the app still works there, but it falls back to per-browser
storage and the library stops being shared — which is the behaviour it had before this
existed, not a broken state.

Note that `data/` is gitignored. Commit it deliberately if you ever want a fixed set of
schematics to ship with the app itself.
