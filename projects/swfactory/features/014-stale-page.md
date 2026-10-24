---
title: Tell the page when it is out of date
status: planned
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
- [ ] `/api/state` and the SSE `hello` event both carry a build id derived from the served files
- [ ] The build id changes when `app.js` or `styles.css` changes, and does not change when only
      a spec file does
- [ ] A page open across a rebuild reloads itself, or offers a visible reload, within 60s
- [ ] A page open across a rebuild that changed no served file does **not** reload
- [ ] An open sheet or an in-flight job queue is never interrupted by an automatic reload
- [ ] After the reload the page is running the new code, verified by a change visible in the DOM
      rather than by the absence of a complaint
- [ ] `app.js` and `styles.css` are served with `ETag` and `Cache-Control: no-cache`
- [ ] With the dashboard unreachable, the page does not reload-loop; it waits and recovers
- [ ] Verified for real: rebuild the container with a visible CSS change while a page is open on
      a phone and on a desktop, and watch both pick it up

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
- [ ] `buildId()` hashing `public/`, with a test that it changes with content and not with mtime
- [ ] `build` in `/api/state` and in the SSE `hello`
- [ ] Client compares and reloads, once per page life, guarded while a sheet or queue is busy
- [ ] `ETag` and `Cache-Control: no-cache` on served assets, with a test
- [ ] Verify for real: rebuild with a visible change and watch an open page pick it up

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
