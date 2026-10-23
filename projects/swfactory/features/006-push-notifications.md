---
title: Push notification when a session needs me
status: specced
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

<!-- Filled in by /plan -->
## Plan
<Approach, affected files/modules, data changes, risks.>

## Tasks
- [ ] <Small, independently verifiable step>

## Log
- 2026-10-23 Specced. Mechanism changed from Web Push to ntfy: Web Push needs a secure context
  and the dashboard is LAN-only HTTP with 004 deferred. Added failed jobs as a second trigger —
  a job queued from the phone can fail with nothing on screen to show it.
