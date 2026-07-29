# Next session: deploy, then a login screen

Written 2026-07-28, at the end of the session that added the shared library, the
power/signal layers and the flow arrows.

## The one thing to decide first: where it runs

The shared library writes to `data/` on the server. That rules out a purely static
host for the *sharing* feature — GitHub Pages has no disk, so the app deployed there
falls back to per-browser storage and the library stops being shared.

So the deploy target needs: Node, and a directory that survives a restart.

- **Private repo → Render / Railway / Fly.** Build `npm run build`, start `npm start`,
  attach a persistent disk (or volume) mounted where `DATA_DIR` points. Free tiers exist;
  check whether the free tier's disk is ephemeral, because most are — a redeploy that
  silently empties the library is the failure mode to avoid.
- **Private repo → a small VPS.** Same two commands behind a reverse proxy. Nothing
  clever needed; the server is dependency-free.
- **GitHub Pages.** Works, but per-browser only. Fine as a demo URL, not as the shared
  workbench Joe asked for.

Joe's ask: private GitHub repo, URL usable by anyone he shares it with. Any of the above
satisfies that — GitHub private repos can deploy to all of them.

## The login screen

Wanted: a single username and password, not accounts. Where it goes:

- `server/index.mjs` is the only door. Put HTTP Basic (or a signed cookie set by a tiny
  `POST /api/login`) in front of *both* the static files and `/api/*`, before
  `createLibraryApi`'s handler runs. Credentials from env (`AUTH_USER`, `AUTH_PASS`) —
  never committed, and the repo being private is not a reason to relax that.
- A cookie beats Basic auth for one reason that matters here: the PWA. Basic auth prompts
  are awkward in a standalone-display PWA on iOS, and there is no way to log out.
  A `POST /api/login` that sets an `HttpOnly; SameSite=Lax; Secure` cookie, plus a login
  screen in the app when `/api/status` returns 401, behaves properly when installed.
- `sharedStatus()` in `src/storage/shared.ts` already probes `/api/status` once at
  startup and is where a 401 should be turned into "show the login screen" rather than
  "no shared library" — the distinction matters, because the current fallback silently
  drops to local-only storage, which would look like the library had emptied.
- Rate-limit the login route however crudely (a per-IP counter in memory is enough for
  one password), and serve it over HTTPS only; every host above terminates TLS for you.

Nothing about the login should touch the offline path. A phone that is logged in and then
loses signal must still open its local copies — that already works and should keep working.

## Smaller things noticed but not done

- **Conflicts are last-write-wins.** Two devices editing one schematic: the later save
  wins wholesale. Documented in the README. If it ever bites, the cheap fix is a
  per-document version counter and a "this was changed elsewhere" prompt, not merging.
- **`syncUp()` runs once at startup.** A tab left open for a day will not see another
  device's changes until reload. A poll of `/api/library` every minute or so, or a
  refresh on `visibilitychange`, would fix it cheaply.
- **The sample document's nets are nearly all classified `power`** (the whole sheet draws
  red), including the one labelled GND. Worth a look when the interpretation-quality work
  resumes — the ground symbol is detected, so the role should be reachable.
- **Flow arrows are inferred from one anchor per net.** See `src/render/flow.ts`. If they
  are wrong often enough to be annoying, the upgrade is a real BFS over the segment graph
  from the anchor, which is the same rule done properly rather than a different rule.
