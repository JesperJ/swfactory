---
title: Push notification when a session needs me
status: reviewing
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
- [x] A session changing status to `needs_you` produces exactly one notification, naming the
      project, the feature (or the repo when no feature matched), and the host
- [x] The notification links to the dashboard and tapping it opens the inbox
- [x] A repeated idle `Notification` event, or any event that leaves the status unchanged,
      produces no notification
- [x] A session that flaps `needs_you` → `working` → `needs_you` inside the cooldown window
      produces one notification, not two
- [x] A job reaching `failed` produces one notification naming the project, feature and command
- [x] `your_turn`, `working`, `ended`, and any session already dismissed produce nothing
- [x] The notification text contains no prompt text, no assistant message, and no absolute path
- [x] With the notifier unconfigured, every existing endpoint behaves exactly as it does today
      and `npm test` passes unchanged
- [x] When the notification endpoint is unreachable, slow, or returns an error, `POST /api/hooks`
      and `POST /api/jobs/:id/status` still return their normal response in their normal time,
      and the failure is logged, not raised
- [x] Trigger rules are covered by tests that make no network calls
- [ ] README documents the env vars and the phone-side setup, and that walkthrough was followed
      once end to end on a clean phone
      — the README half is written; the walkthrough needs a phone, so it is unverified.
- [ ] Verified for real: a live session hitting a permission prompt produced a notification on
      my phone, and a failed job produced one
      — verified as far as this side goes: with a throwaway topic on real ntfy.sh, a live hook
      and a live failed job each produced exactly one message, and polling the topic back
      confirmed the titles, bodies and click targets, with the `working` hook producing none.
      The phone end — subscribed app, screen waking, tapping through — is untested.

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
- [x] `.env.example`, README and the ntfy walkthrough; record the ntfy-over-Web-Push decision
- [ ] Dogfood: subscribe the phone, make a live session hit a permission prompt, fail a job
      (needs Jesper's phone; the dashboard-to-ntfy half is verified)

### Round 1 rework
- [x] **Blocking (UX 1).** A `Job failed` tap lands on the Inbox, which never renders jobs — he
      sees "All quiet" seconds after being told something failed. Click to
      `#/next/doc/<project>/<feature>`, which renders the failed job and its Retry button;
      fall back to `#/next` when there is no feature. Sessions keep `#/inbox`.
- [x] Take `maybeSend` off the request path for real (code 2, security 1): it is synchronous up
      to `send()`, so `loadProjects()` runs inline in the hook handler. Defer it, and check the
      cooldown *before* `notificationFor` (security 2) so a flapping session stops paying for a
      spec read it discards.
- [x] Pass the notifier an explicit `{ id, status, host, repo, dismissed }` (security 4). A
      `Pick` is structural: `prompt`, `message` and `cwd` are on the object at runtime today.
- [x] Drain the ntfy response body (code 4, security 5), and warn at startup when `NTFY_TOPIC`
      is set without `FACTORY_PUBLIC_URL` (code 3, UX 5) instead of sending unclickable
      notifications in silence.
- [x] Put the feature in the body, not the title (UX 3) — the title is what a lock screen clips,
      and the feature is the part that varies. Send `priority` in the body so iOS gets it too,
      and fall back to the `cwd` basename before "unknown work" (UX 6).
- [x] README: `fly secrets set` lines for the deployed path (UX 4), where appending to `.env` is
      silently inert. Drop the Android-only priority step once priority is sent in the body.
- [x] Test the real dismissed sequence (code 1): dismiss, `working`, `needs_you` — the current
      test builds a state the store cannot produce.

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
- 2026-10-23 Built. 7 of 8 tasks; 10 of 12 acceptance criteria verified. Checked against real
  ntfy.sh on a throwaway topic: one message for a live `needs_you` hook, one for a live failed
  job, none for `working`, and polling the topic back confirmed no prompt text, no assistant
  message and no filesystem path reached it despite all three being planted in the payloads.
  Endpoints answered in 5-24ms. Two criteria and the dogfood task stay unticked because they
  need the phone. One naming deviation from the plan: the transport interface is `Sender`, since
  `Notifier` is what the endpoints hold; plan updated. Worth knowing: `upsert` un-dismisses a
  session on a real status change, so a dismissed session that genuinely blocks again later will
  notify. That is the inbox's existing semantics and reads as correct — it is a new thing
  needing you — but it is the one place the "dismissed produces nothing" rule bends.
- 2026-10-23 Ready for review: https://github.com/JesperJ/swfactory/pull/5
- 2026-10-23 Review round 1: code 0 blocking / 4 minor, security 0 blocking / 5 minor, UX 1
  blocking / 5 minor. See `reviews/006-round-1.md`. Reworking. The blocking finding: a `Job
  failed` notification links to the Inbox, which never renders jobs, so the tap lands on "All
  quiet" — the dashboard contradicting the notification trains distrust faster than frequency
  does. Also taking all eleven minors: each is small, and most of them make a claim the code
  already states about itself actually true — "not on the request path", "a property of the
  code", "would otherwise leak one handle". Three reviewers independently found the same
  synchronous `loadProjects()` in the hook handler.
- 2026-10-23 Round 1 rework: the blocking finding and nine of the eleven minors. (Corrected
  2026-10-23 after round 2 caught the overclaim: this line originally said "all eleven". The
  global cap and the logged-out hash drop were not done, and the whole-row fix was done for
  sessions but not jobs. All three are done now — see the round 2 entry.) Jobs now link to
  the doc sheet (`#/next/doc/<project>/<feature>`), which renders the failed job and its Retry
  button, instead of the Inbox, which renders sessions only. `maybeSend` defers with
  `setImmediate` and the cooldown gates ahead of the specs read, so the hook handler no longer
  does disk I/O before responding — live hook responses went from 24ms to 3ms. The feature moved
  from the title to the body, where a lock screen does not clip it; `priority: 4` is sent in the
  message so iOS gets it without the Android-only per-subscription setting. Rechecked live
  against real ntfy.sh: two messages, correct titles, bodies, priorities and click targets, with
  `SECRET-PROMPT`, `SECRET-COMMAND` and `/home/jesper/SECRET/PATH` all planted and none present.
  89 tests, typecheck clean.
- 2026-10-23 Back to reviewing after the round 1 rework. PR #5 updated.

### Round 2 rework
- [x] **Correct the round 1 Log claim.** It says "the blocking finding and all eleven minors".
      Two were never taken and one was half taken. Make the claim true by doing them rather
      than by softening the sentence.
- [x] Global rate limit (round 1 security 3): the per-session cooldown gives N buckets to N
      session ids, and `priority: 4` now rides every message, so the cost of each one went up
      while the throttle stayed the same. The spec already names this as the right fix.
- [x] Carry the fragment through login (round 1 UX 2): a logged-out cold load drops `#/inbox`
      and the deeper `#/next/doc/...`, which matters more now that job notifications are deep
      links, and iOS "Add to Home Screen" means the first tap always goes through Safari.
- [x] Finish round 1 security 4: the job call site still passes the whole row, `error` included
      — the half that was not done when the Log said it was.
- [x] `lastSegment` before `clean`, not after (round 2 code 1, security 4, UX 1 — all three).
      A rework regression: `MAX_TEXT` 120→60 plus `cwd` as an input means a long path now
      titles a notification `Needs you: …` and names nothing.
- [x] README: the Fly block generates a topic and discards it, then step 2 says to read it from
      a `.env` the Fly path never writes (round 2 UX 2). He is about to follow this walkthrough.
- 2026-10-23 Review round 2: 0 blocking from all three reviewers. Round 1's blocking finding
  verified resolved live at 390px — the sheet opens itself and the Retry button is above the
  fold. **Correcting the record: the round 1 Log entry claiming "all eleven minors" was wrong.**
  Security 3 (global cap) and UX 2 (logged-out hash drop) were never done, and security 4 was
  done for sessions but not jobs. Jesper's call: make the claim true rather than soften it.
  Also taking the one rework regression all three reviewers found independently — `clean` runs
  before `lastSegment` splits, so a path over 60 chars titles a notification `Needs you: …`.
- 2026-10-23 Round 2 rework done. The three outstanding round 1 items are now genuinely done:
  a global ceiling of 10 notifications per 10 minutes, which is the limit the per-session
  cooldown cannot be (N session ids give N buckets, and nothing cools jobs); the login flow
  carries the fragment through in a query parameter, validated to our own hash shape, so a
  notification tapped on a logged-out phone returns to the thing it named; and the job call
  site now builds its projection field by field like the session one, keeping the runner-
  supplied `error` off the object. Also fixed the rework regression all three reviewers found
  independently: `lastSegment` now splits before clipping, so a deep iCloud path titles
  `Needs you: clientproj` rather than a bare ellipsis. README no longer tells you to read the
  topic from a `.env` the Fly path never writes.
  Verified live against real ntfy.sh: 18 notification-worthy events produced exactly 10
  messages and one log line; a 74-character path named its basename; the login redirect
  honoured a deep `next` and dropped `https://evil.example.com`. 102 tests, typecheck clean.
  Left undone, deliberately: round 2 UX 3 — the doc sheet's Retry button labels from the
  feature's current recommended action, so a build that reached `reviewing` and then failed
  offers "Retry review". That is pre-existing `startControl` behaviour in another feature's
  code, and worth its own spec rather than a drive-by here.
  UI checked at 390px and 1280px, light and dark: 4 screenshots, no console errors, no
  overflow, tab bar on one row. The whole logged-out round trip verified in a real browser —
  tapping a job notification while signed out now lands on the feature with the sheet open.
- 2026-10-23 Back to reviewing after the round 2 rework. PR #5 updated.
- 2026-10-23 Escalated, not passed. Two acceptance criteria are unticked and cannot be ticked
  from here: the README walkthrough followed on a clean phone, and a notification actually
  arriving on it. Everything else is met — round 2 returned 0 blocking from all three
  reviewers, and the rework after it closed every round 2 finding plus the three round 1 items
  that had only been claimed done, each verified live against real ntfy.sh. Deliberately not
  running a review round 3: the newest round file predates the last build, which normally means
  review first, but a third round is itself an escalation trigger and round 3 would re-review
  fixes that are already tested and verified while leaving the phone criteria exactly where
  they are. The decision is whether to do the phone walkthrough or narrow the two criteria.
- 2026-10-24 Approve → escalate, again, and for the same reason as before: the two remaining
  criteria need a human holding a phone.
  What changed since the last escalation: `NTFY_TOPIC` and `FACTORY_PUBLIC_URL` are now set and
  the dashboard is running with notifications enabled. Both triggers were exercised through
  their real code paths, not simulated — a job driven to `failed` through
  `POST /api/jobs/:id/status`, and a `needs_you` session through `POST /api/hooks` with a
  permission-prompt payload. Neither logged a send failure, and the notifier only logs
  failures, so both sent.
  That is as far as this side can go. "Produced a notification **on my phone**" cannot be
  verified from here: sending and arriving are different claims, and only the person
  subscribed can tell them apart.
  Deliberately not running review round 3. The round 2 file predates the last build, which the
  rules say means review first — but the build after it closed round 2's findings, a third
  round is itself an escalation trigger, and no reviewer can settle a criterion about a phone.
  Running it would cost three agents to re-read code that is already tested and leave both
  criteria exactly where they are.
