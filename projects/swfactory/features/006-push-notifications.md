---
title: Push notification when a session needs me
status: building
priority: P2
summary: The dashboard pushes to my phone when a session blocks on me or a queued job fails.
---

# Push notification when a session needs me

## Why
The inbox only helps if I look at it. A session that hits a permission prompt sits there
silently, and a Build I tapped from my phone can fail without ever telling me — both cost
real time, and both are invisible until I happen to open the dashboard. The dashboard already
knows the moment either happens; it just doesn't say anything.

## What
When a session's status changes to `needs_you`, my phone gets a notification naming the
project and feature, with a link back to the dashboard. Same when a job the dashboard queued
ends `failed`. Tapping it opens the dashboard.

Nothing else notifies. `your_turn` fires constantly during normal work and would train me to
ignore the channel; a repeated idle nudge is not a new event; a dismissed session has already
been dealt with.

Delivery is an outbound HTTPS POST from the dashboard to **ntfy**, with the phone's ntfy app
subscribed to one topic. Web Push (VAPID + service worker) is the obvious shape for this and
is what the original one-liner said, but it needs a secure context: the dashboard is LAN-only
over plain HTTP and 004 deferred public HTTPS indefinitely. ntfy needs nothing of the
dashboard but an outbound connection, so it works today and keeps working if 004 never lands.
The sender sits behind one small interface so a Web Push sender can be added beside it later
without touching the trigger rules.

Because an ntfy topic is effectively a bearer secret anyone can subscribe to, the notification
body carries only project, feature, host and the link — never prompt text, Claude's message,
or a filesystem path.

## Acceptance criteria
- [ ] A session changing status to `needs_you` produces exactly one notification, naming the
      project, the feature (or the repo when no feature matched), and the host
- [ ] The notification links to the dashboard and tapping it opens the inbox
- [ ] A repeated idle `Notification` event, or any event that leaves the status unchanged,
      produces no notification
- [ ] A session that flaps `needs_you` → `working` → `needs_you` inside the cooldown window
      produces one notification, not two
- [ ] A job reaching `failed` produces one notification naming the project, feature and command
- [ ] `your_turn`, `working`, `ended`, and any session already dismissed produce nothing
- [ ] The notification text contains no prompt text, no assistant message, and no absolute path
- [ ] With the notifier unconfigured, every existing endpoint behaves exactly as it does today
      and `npm test` passes unchanged
- [ ] When the notification endpoint is unreachable, slow, or returns an error, `POST /api/hooks`
      and `POST /api/jobs/:id/status` still return their normal response in their normal time,
      and the failure is logged, not raised
- [ ] Trigger rules are covered by tests that make no network calls
- [ ] README documents the env vars and the phone-side setup, and that walkthrough was followed
      once end to end on a clean phone
- [ ] Verified for real: a live session hitting a permission prompt produced a notification on
      my phone, and a failed job produced one

## Out of scope
- Web Push / VAPID / service worker. Blocked on 004's HTTPS; a second sender later.
- Answering or dismissing from inside the notification.
- Quiet hours and per-project or per-feature subscription rules — the phone OS already mutes.
- Notifying on `your_turn`, or on features changing status.
- Running my own ntfy server. Hosted first; self-hosting is a later swap of one URL.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **ntfy, not Web Push.** Web Push cannot work on a plain-HTTP LAN origin, and 004 is deferred.
  Overturning this means un-deferring 004 first.
- **Hosted ntfy.sh with a long random topic**, treated as a secret, hence the terse body. The
  alternative is a self-hosted ntfy behind the same tunnel 004 doesn't have yet.
- **Cooldown of 10 minutes per session**, so one stuck session can't repeat itself.
- **Two triggers only**: `needs_you`, and `failed` jobs.
- **One topic, no per-device registration.** Whatever is subscribed gets it; there is one user.

## Plan
Three parts. The trigger rules are a pure function, so the thing most likely to be wrong is the
thing easiest to test without a network.

**1. `src/notify.ts` — deciding, then sending.** Two separable pieces in one module:

`notificationFor(event)` is pure: given what just happened, it returns a `Notification`
(`title`, `body`, `click`) or `null`. Every rule in the spec lives here — `needs_you` only,
never `your_turn`/`working`/`ended`, nothing for a dismissed session, nothing when the status
did not actually change, and `failed` jobs. It builds the body from project, feature, host and
command only, so the "no prompt text, no assistant message, no path" criterion is a property of
the one function that writes the text rather than a rule each caller must remember.

`Sender` is an interface with one method, so a Web Push sender can sit beside the ntfy one
later without touching the rules. `fromEnv()` returns a `Notifier` carrying an ntfy sender
when `NTFY_TOPIC` is set and none otherwise — that is how "unconfigured behaves exactly as
today" is achieved, rather than by scattering `if (enabled)` through the endpoints.

The 10-minute cooldown is a `Map<sessionId, timestamp>` inside the notifier. Deliberately in
memory: a restart can at most allow one extra notification, which is a far smaller cost than a
schema change and a migration for state that is worthless after ten minutes.

**2. The two trigger points.** `upsert` in `src/db.ts` already computes `changed` internally but
returns `void`; it returns `{ session, statusChanged }` instead. `setJobStatus` needs no change —
`POST /api/jobs/:id/status` already fetches the row for its 404 check, so binding that gives the
previous status for free.

Both endpoints then call `void notifier.maybeSend(...)` — never awaited. That is what keeps the
"response is returned in its normal time even when the endpoint is unreachable" criterion true by
construction: the request path does not depend on the notification at all. The sender carries its
own timeout and logs failures.

**3. Config and docs.** `NTFY_TOPIC`, `NTFY_SERVER` (default `https://ntfy.sh`), and
`FACTORY_PUBLIC_URL` for the click target. All optional; absent means no-op. `.env.example`,
the README and `contrib/` get the phone-side walkthrough.

Trade-off taken: ntfy over Web Push, which the spec already argues from the HTTPS constraint.
Recorded separately because it puts session metadata through a third party, and that deserves to
be a decision someone can find later rather than a line in a plan.

Risk worth naming: the cooldown is per session, so two different sessions blocking at once still
produce two notifications. That is correct — they are two things needing you — but it means a
busy moment can still buzz repeatedly, and the spec's own "train me to ignore the channel" worry
applies. If that happens, the fix is a global rate limit, not a longer per-session cooldown.

## Tasks
- [x] `notificationFor` in `src/notify.ts`: the pure trigger rules, with tests covering every
      criterion (needs_you only, no repeat on unchanged status, dismissed produces nothing,
      failed jobs, and no prompt text or path in the body)
- [x] The `Notifier` interface, the ntfy sender with its own timeout, and the no-op `fromEnv`
      returns when `NTFY_TOPIC` is unset
- [x] The per-session cooldown, with a test for the flap case
- [x] `upsert` returns `{ session, statusChanged }`; wire `POST /api/hooks` to the notifier
- [x] Wire `POST /api/jobs/:id/status`, binding the row it already fetches for its 404 check
- [x] A test that both endpoints keep their response and timing when the sender throws or hangs
- [ ] `.env.example`, README and the ntfy walkthrough; record the ntfy-over-Web-Push decision
- [ ] Dogfood: subscribe the phone, make a live session hit a permission prompt, fail a job

## Log
- 2026-10-23 Specced. Mechanism changed from Web Push to ntfy: Web Push needs a secure context
  and the dashboard is LAN-only HTTP with 004 deferred. Added failed jobs as a second trigger —
  a job queued from the phone can fail with nothing on screen to show it.
- 2026-10-23 Planned. The trigger rules become one pure function, so the part most likely to be
  wrong is the part testable without a network, and the "no prompt text, no path" rule is a
  property of the single function that writes the body rather than something each call site must
  remember. Both endpoints fire the notifier without awaiting it, which is what makes "the
  response is unaffected when the endpoint hangs" true by construction rather than by timeout
  tuning. Neither trigger point has more than one caller, so the wiring is small.
  Recorded `decisions/2026-10-23-ntfy-over-web-push.md`, because routing session metadata through
  a third party deserves to be findable later rather than buried in a plan. 8 tasks.
- 2026-10-23 Building on `feature/006-push-notifications`.
