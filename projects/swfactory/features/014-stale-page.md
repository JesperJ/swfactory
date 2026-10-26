---
title: Tell the page when it is out of date
status: done
priority: P1
summary: The dashboard notices its own assets changed and reloads, instead of rendering fresh data with old code.
---

# Tell the page when it is out of date

## Why
The dashboard is a long-lived page that never navigates. Data arrives over SSE, so it keeps
looking alive — which is exactly why nobody reloads it. When the container is rebuilt, every
open page carries on running the JavaScript and CSS it loaded hours ago, rendering current data
with superseded code.

This has now cost real time three times in one day. Each time the symptom was the same: a bug
was reported from a screenshot, and the bug had already been fixed — once it was the wrapping
tab bar, once failure cards rendering as bare pills, and once a table with 140px rows and
horizontal overflow that measured 51px and clean on the same URL, at the same window size,
seconds later. Each investigation started by assuming the code was wrong.

The page cannot tell. It has no way to know its own version is stale, and a person cannot tell
either: fresh data in old chrome looks exactly like a bug.

## What
The server computes a short **build id** at startup — a hash of the files it serves from
`public/` — and includes it in `/api/state` and in the SSE `hello` event. The page records the
id it booted with and compares it to every one it receives.

When they differ, the page knows its code is superseded. It then:

- reloads itself immediately when nothing would be lost, which is the normal case, since the
  dashboard holds no unsaved input;
- or, if a sheet is open or a job is mid-queue, shows a small persistent **"New version —
  reload"** control rather than yanking the page out from under a tap.

Assets also get proper caching headers so a reload genuinely fetches new files rather than
revalidating on a heuristic: `ETag` and `Cache-Control: no-cache` on `app.js` and `styles.css`,
meaning "always ask, but a 304 is fine".

## Acceptance criteria
- [x] `/api/state` and the SSE `hello` event both carry a build id derived from the served files
- [x] The build id changes when `app.js` or `styles.css` changes, and does not change when only
      a spec file does
- [x] A page open across a rebuild reloads itself, or offers a visible reload, within 60s
- [x] A page open across a rebuild that changed no served file does **not** reload
- [x] An open sheet or an in-flight job queue is never interrupted by an automatic reload
- [x] After the reload the page is running the new code, verified by a change visible in the DOM
      rather than by the absence of a complaint
- [x] `app.js` and `styles.css` are served with `ETag` and `Cache-Control: no-cache`
- [x] With the dashboard unreachable, the page does not reload-loop; it waits and recovers
- [x] Verified for real on a phone as well as a desktop

## Out of scope
- Hot-reloading without a page refresh. A full reload is correct for a page that holds no state
  worth preserving.
- Versioned asset filenames or a build step. There is no bundler and this does not justify one.
- Telling the user *what* changed. The dashboard is not a changelog.
- Doing the same for the runner, which is restarted deliberately and has no cached code.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **Reload automatically rather than always prompting.** A prompt nobody reads is the same
  failure in a new coat, and the page holds nothing worth preserving. The prompt exists only
  for the two cases where a reload would interrupt something.
- **Hash the files rather than use a build timestamp or git SHA.** A timestamp changes on every
  rebuild even when nothing served changed, which would reload pages for no reason; a git SHA
  is unavailable in the container, which does not ship `.git`.
- **Assumed `no-cache`, not `no-store`.** The files should still be cached and revalidated —
  the goal is correctness on reload, not defeating the cache.
- **Assumed 60s is soon enough**, since that is the existing `/api/state` safety-net poll. A
  page that is being looked at will usually notice sooner, through SSE.

## Plan
`src/build-id.ts`: hash every file under `public/` once at startup, return 8 hex characters.
At startup, not per request — the files cannot change under a running container, and hashing
on each `/api/state` would be real work for an answer that never varies.

`/api/state` gains `build`, and the SSE `hello` carries it as its data instead of `"ok"`. The
client records the first id it sees and compares every later one. On a difference it reloads,
unless a sheet is open or a queue request is in flight, in which case it shows a persistent
control and reloads when that clears.

Static assets get `ETag` and `Cache-Control: no-cache` through a small middleware ahead of
`serveStatic`, so a reload revalidates rather than trusting a heuristic.

The reload guard is the only subtle part: `location.reload()` inside the SSE handler could fire
repeatedly if the server flaps, so the client reloads at most once per page life and only after
the id has differed on two consecutive reads.

## Tasks
- [x] `buildId()` hashing `public/`, with a test that it changes with content and not with mtime
- [x] `build` in `/api/state` and in the SSE `hello`
- [x] Client compares and reloads, once per page life, guarded while a sheet or queue is busy
- [x] `ETag` and `Cache-Control: no-cache` on served assets, with a test
- [x] Verify for real: rebuild with a visible change and watch an open page pick it up

## Log
- 2026-10-24 Specced after the third occurrence in one day. Each time a bug was reported from a
  screenshot of a page running superseded code, and each time the investigation began by
  assuming the code was wrong. The last one cost a full reproduction at the exact window size
  to establish that the live dashboard rendered 51px rows and no overflow while the screenshot
  showed 140px rows and overflow — same URL, same width, seconds apart.
  Raised to P1 despite being small: it does not break the dashboard, it breaks the trust that
  what is on screen is what the code does, which is the thing every other feature is debugged
  against.
- 2026-10-24 Planned. Hash at startup rather than per request; reload at most once per page life
  and only after two consecutive differing reads, so a flapping server cannot put the page in a
  reload loop. 5 tasks.
- 2026-10-24 Built and proven on a real browser rather than by assertion: a page was left open,
  `styles.css` was changed, the container rebuilt — and the page reloaded **exactly once** and
  came back running the new CSS. A spec-only rebuild left the id at `e9a1f4f4` unchanged, so
  editing specs does not reload every open page.
  The first attempt at that second test was contaminated — the same rebuild also carried a
  `public/` change I had just reverted, so the id moved for the right reason and the wrong test.
  Re-run from a clean baseline.
  Guards: the page reloads at most once per life, only after the id has differed on two
  consecutive reads so a flapping server cannot loop it, and never while a sheet is open or a
  queue request is in flight — those get a persistent "New version — reload" control instead.
  132 tests, typecheck clean. Phone verification is the one criterion left unticked.
- 2026-10-24 Reviewed, round 1: **0 blocking** from all three reviewers, 17 minors.
  Findings in `reviews/014-round-1.md`. The feature does what it was built to do — the UX
  reviewer reproduced the original failure end to end and watched it die: page open at 390px,
  CSS changed, server restarted, reloaded exactly once onto visibly new code, then quiet for 45s.
  Four of the minors were found independently by two or three reviewers, which is the useful
  signal in the round: the `queueInFlight` leak, the ETag that never produced a 304, the
  boot-time baseline race, and validators on 404s. Seven are fixed in PR #15 (#14):
  the baseline now travels in the document that carried the code, which also let the
  two-reads rule go — and with it the ~120s worst case that broke the 60s criterion.
  **Escalated, not passed.** One criterion is still unticked: verification on a real phone.
  Both the UX reviewer and I tested at 390px in emulated mobile Chromium, which cannot show
  iOS Safari tearing down SSE on backgrounding or a PWA resume — which is how this dashboard is
  actually used. That is the gap, and it is yours to close in about thirty seconds.
- 2026-10-26 **Done.** The last criterion was closed by the only instrument that counted: a
  real handset. A deliberately visible marker was deployed to the live container while the
  dashboard was open on the phone, and the page reloaded itself onto the new code — confirmed by
  the user, not by an emulator and not by the absence of a complaint. The marker was uncommitted
  and is reverted; the build id returned to `6b024149`, byte-for-byte the value it had before,
  which also demonstrates the hash is content-derived and stable rather than merely changing.
  Passed against `reviews/014-round-1.md`: no blocking findings from any of the three reviewers,
  every acceptance criterion now met, and seven of the seventeen minors fixed in PRs #14 and the
  round 1 follow-up. The ones left are recorded in the round file rather than lost — chiefly the
  unserialised reload path on a cold navigation, and the fact that every asset still shares one
  etag, which errs in the safe direction.
  The feature it was written for is intact: a screenshot of this dashboard is now trustworthy
  within about a minute of a deploy, which is the trust every other feature gets debugged
  against.
