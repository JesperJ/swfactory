# 014 — Tell the page when it is out of date — review round 1

Date: 2026-10-24
Merged as PR #12 before review; reviewed against `git diff 335e7e3...feature/014-stale-page`.
Reviewers: code, security, UX, run in parallel.

**Counts** — code: 0 blocking, 6 minor. Security: 0 blocking, 6 minor. UX: 0 blocking, 5 minor.

Four findings were reached independently by two or three reviewers: the `queueInFlight` leak, the
ETag that never produces a 304, the boot-time baseline race, and validators on 404s. Convergence
on a minor is worth more than its label — three people looking at different things arrived at the
same four lines.

---

## Code review

**Checks run:** 139/139 tests pass, typecheck clean. The reviewer recomputed `buildId("public")`
from source and got `5d3020b4`, matching what `/api/state` and the SSE `hello` served — so the
running build was confirmed to be this code rather than assumed.

### On the acceptance criteria

> **Changes with `app.js`/`styles.css`, not with a spec — met, verified empirically.** Appending
> a byte to `public/styles.css` moved the id to `6d76b645`; appending to
> `projects/swfactory/features/014-stale-page.md` left it at `5d3020b4`.

> **An open sheet or in-flight queue is never interrupted — met.** The banner is `z-index: 60`
> against the sheet's 50 and the scrim's 40, so it is genuinely on top in both the mobile
> bottom-sheet and the desktop right-drawer layout; all four tokens it uses are defined in the
> light, `prefers-color-scheme` and `[data-theme]` blocks.

> **New code after the reload, proven by the DOM — not independently verifiable from the diff.**
> There is no automated coverage, and I did not drive a browser. The log records a manual desktop
> verification.

> Phone verification is correctly left **unticked**. No criterion is ticked without being true.

### minor 1 — a failed tap permanently downgrades the feature
`public/app.js:650-660`.

> `queueInFlight = true` is set before `await fetch("/api/jobs", …)` and cleared only on the
> fall-through path. A rejected fetch — server restarting, which is precisely the scenario this
> feature exists for — propagates out of the async click handler, so `queueInFlight` stays `true`
> for the rest of the page's life. From then on `checkBuild` can never auto-reload; it only ever
> shows the banner. Sequence: tap Build at the moment the container goes down → the tap fails →
> every later version change is downgraded to a manual prompt, silently and permanently.

### minor 2 — the ETag is never honoured
`src/server.ts:236-242`.

> The ETag is attached after `await next()`, so nothing ever compares it to an inbound
> `If-None-Match`, and `serveStatic`'s own conditional handling is bypassed too. Verified live:
> `If-None-Match: W/"5d3020b4"` on `/app.js` → `200`, 34448 bytes. A 304 is never possible on any
> path. Criterion 7 as written is met; the What section's stated intent — "always ask, but a 304
> is fine" — is not.

### minor 3 — detection can take twice as long as the criterion allows
`public/app.js:566` with `public/app.js:724`.

> The two-consecutive-differing-reads guard needs a second read, and only `hello` supplies one
> promptly. If EventSource stops retrying — it does so permanently when a reconnect is answered
> with a non-2xx or the wrong content type — the only remaining source is the 60s `setInterval`
> poll, so detection takes up to ~120s, over the 60s the criterion names.

### minor 4 — the baseline can be the wrong build
`public/app.js:548-552`.

> `bootBuild` is the first id the *server* reports, not an id stamped into the assets the page
> actually loaded. If the server restarts between the page fetching `app.js` and its first
> `hello`/`/api/state`, the page records the new id as its own and will never reload, running
> superseded code with no signal — the exact failure this feature exists to prevent. The window
> is sub-second on a desktop, so this is narrow rather than likely, but it is the one structural
> weakness in the scheme.

### minor 5 — the document itself is not covered
`src/server.ts:239`. The regex covers `.js`, `.css` and `.webmanifest` but not the HTML document.

> A cold navigation (bookmark, PWA launch) can still pair heuristically-cached markup with a fresh
> `app.js` and the id comparison gives no warning.

### minor 6 — 404s carry a validator
Verified: `GET /nope.js` returns `404` carrying `etag: W/"5d3020b4"`.

---

## Security review

**0 blocking.**

> The diff adds no route, no new input path, and no new secret. The reload trigger is reachable
> only by an already-authenticated session, and the build id is derived entirely from files that
> are already served, so it discloses nothing the fetcher couldn't read directly.

### minor 1 — the 304 the spec describes never happens
Independently measured, matching the code reviewer:

> I verified it: a request carrying the exact ETag the server just issued comes back `200` with
> the full 34429-byte body. Not a security defect, a bandwidth one. Related and harmless: every
> asset carries the *same* ETag value. ETags are scoped per-URL, so that collision cannot cause a
> cross-file mix-up — it just means any change to any file in `public/` invalidates all of them,
> which errs in the safe direction.

### minor 2 — validators on responses that are not the asset
`src/server.ts:247`.

> `/nope.js` returns `404` carrying `ETag` and `Cache-Control: no-cache` — a validator advertising
> a body that is not the asset. Inert today, precisely because nothing validates the ETag, but if
> an `etag()` middleware or a caching proxy is ever added, a missing-file response and a real one
> become indistinguishable to the validator. One-line fix: gate on `c.res.ok`.

### minor 3 — the reload guard dies with the page it guards
`public/app.js:551,564-568`.

> The `reloading` flag and the two-consecutive-reads rule hold within one page, but a reload starts
> a fresh page whose `bootBuild` becomes the id it just saw. If two instances ever answer on the
> same host name serving different builds — a rolling restart, or the dev server and the container
> both up — the page boots on A, sees B twice, reloads; boots on B, sees A twice, reloads;
> indefinitely. Each life obeys "once", and the loop still never stops. Noting it because the
> spec's Log asserts a flapping server "cannot put the page in a reload loop", and that claim is
> only true inside a page life.

### minor 4 — `queueInFlight` is never reset when the queue POST throws
Same finding as code minor 1, reached independently.

> It fails in the safe direction — no reload, no loop — but it quietly degrades the feature's main
> behaviour after one failed tap.

### minor 5 — the mechanism can fail open through a boot-time race
Same finding as code minor 4, reached independently.

> The structural fix is to stamp the id into `index.html` at serve time so the baseline comes from
> the same response as the code.

### minor 6 — `buildId` has no error handling around the filesystem walk
`src/build-id.ts:21,24`.

> A dangling symlink or an unreadable file under `public/` throws out of `buildId()`, which runs
> inside `createApp()` — so the server refuses to start rather than serving without an id. Only
> reachable by someone who can already write to the filesystem, so this is robustness, not a
> vulnerability.

### Checked and cleared
- **Secrets.** `.env` untracked, mode `0600`, matched by `.gitignore`. Only `.env.example` and
  `.envrc` are tracked. Correct for a public repo.
- **Build id as an information leak.** *"8 hex of a SHA-256 over relative paths plus content under
  `public/` — no absolute paths, no hostname, no env… it is a digest of bytes any anonymous client
  can already download, so it adds nothing."*
- **Auth placement.** *"Confirmed live: `/api/unknown.js` and `/api/docs/swfactory/foo.js` both
  return `401` with no ETag, i.e. the auth middleware terminates first."* `/api/stream` is not in
  `machineRoute`, so the SSE `hello` stays behind the UI cookie.
- **Response-driven reload as an attack surface.** Both sources are gated and same-origin;
  `checkBuild` early-returns on a falsy id, so the server-down case triggers nothing.
- **Path traversal.** `/../src/server.ts`, `/..%2fsrc%2fserver.ts`, `/%2e%2e/.env`,
  `/../../../etc/passwd` all 404 with no leak. The walk is driven by `readdirSync`, never by
  request input.
- **Injection in the new client code.** The banner uses `createElement` and `textContent` on a
  static string. The build id is only ever compared, never rendered.

Two adjacent things raised but explicitly *not* charged to 014, since both predate it: `public/` is
served with no auth at all, and over plain HTTP on a LAN an on-path attacker could force open
dashboards to reload — *"but the same attacker can already replace `app.js` outright, so this
feature widens nothing."*

---

## UX review

Reproduced the original failure end-to-end against a server built from the branch.

> **It solves the problem.** A page left open at 390px, `styles.css` changed, server restarted —
> the page reloaded **exactly once** and came back visibly running the new CSS, then did nothing
> for the next 45s. A screenshot from this dashboard is trustworthy within about a minute of a
> deploy now, which is what the Why asked for.

Verified for real: build id in both channels; the id changing with CSS and not with a spec; reload
inside a 25s window at 390px dark and 1366px; **zero** extra loads after a spec-only rebuild; the
open sheet never auto-interrupted at 390px light and 1366px dark; new CSS present in the DOM after
the reload; ETag and `Cache-Control` against live; and the unreachable-server case —

> killed 25s, only connection-refused retries, **one** reload when it returned, 0 further loads
> over 50s.

Could not verify: the in-flight-job-queue guard.

> I had no deterministic way to have a `POST /api/jobs` outstanding at the instant of a rebuild.
> It shares the `showUpdateBanner()` path I did exercise via the sheet, so I read the code rather
> than measured it.

On the phone criterion, the reviewer declined to tick it fully and said why:

> I tested at 390px in an emulated mobile Chromium context — the same instrument `npm run shoot`
> uses. That is not a real handset: I could not test iOS Safari tearing down SSE on backgrounding,
> or a home-screen PWA resume, which is how this dashboard is actually used. I'd call that box
> substantially but not fully ticked.

### minor 1 (new) — the reload control lands in the middle of the spec text on a phone
390px, light and dark. `public/styles.css:558-566`.

> The sheet on a phone is `bottom: 0` and covers the tab bar, but the banner is positioned
> `bottom: calc(var(--tabbar) + env(safe-area-inset-bottom) + 16px)` — 80px up, which puts it 80px
> *inside* the sheet body, floating over a line of prose (measured at y=724 of an 844 viewport).
> It doesn't scroll with the text, so it permanently masks a strip of whatever you're reading, and
> there is no dismiss. Not blocking: I confirmed tapping it is non-destructive — the hash survives,
> the same sheet reopens, banner gone — so the escape is one tap. But a control whose whole
> justification is "don't interrupt" interrupts on the one phone surface where it ever appears.
> At 1366px the same banner is fine (x 592–774, sheet starts at x 806 — no overlap).

### minor 2 — 40px tap target
> `min-height: 40px`; measured 182×40 at both widths. Under the 44px floor. The 182px width makes
> it hittable in practice, so only the height is short.

### minor 3, 4, 5
The `queueInFlight` leak, the baseline race, and the unhonoured ETag — each reached independently
for the third time. On the ETag, the UX angle the other two did not have:

> The criterion as written is literally met and the direction is safe, so this is free on desktop —
> on a phone over cellular it means every version reload re-downloads ~62KB the browser already had.

### Not findings
`npm run shoot` across 15 widths found only the known 012 failure-row issue. 014 adds no overflow
and no console errors. Banner contrast is fine in both schemes, and z-index 60 correctly clears the
sheet's 50 — confirmed by hit-test rather than by reading the stylesheet.

---

## Disposition

All 17 minors, no blocking. Six were fixed in `feature/016-stale-page-minors` (PR #14) before this
file was written: the baseline race (by stamping the id into the document), the 304, validators on
404s, the `queueInFlight` leak, `buildId` robustness, and the cross-life reload guard. Dropping the
two-reads rule — which the trustworthy baseline made unnecessary — also fixed code minor 3.

Not one reviewer found a blocking defect, and the feature does what it was built to do. The
interesting result is elsewhere: **the same four lines were found by three people who were not
looking for the same thing**, which says more about where this code was weak than any single
label does.
