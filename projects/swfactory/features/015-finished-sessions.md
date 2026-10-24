---
title: Finished sessions stop crowding Next
status: building
priority: P1
summary: A session whose feature is done, or that finished long ago, drops out of Next instead of sitting there unactionable.
---

# Finished sessions stop crowding Next

## Why
Next is meant to name work worth doing. Right now four of its eight rows are finished sessions
that are not work at all:

- a session on **006**, which is `done` and merged, still asking to be looked at 17 hours later;
- sessions on **007** and **010**, idle 337 minutes, whose specs were read and collected hours
  ago;
- none of them carrying a session URL, because they ran locally — so in the table they render
  with **no control whatsoever**. There is no way to dismiss them from Next. The only way to
  clear one is to find it in the Inbox.

Each of those is defensible on its own. Together they mean the view whose entire job is
reducing decisions is showing a majority of rows that cannot be acted on and will not go away.

The 48-hour window was chosen when a finished session was rare and worth chasing. With the
runner starting sessions on a tap, finished sessions are the common case, and a window that
long turns Next into a log.

## What
Three rules, each narrowing what counts as a session worth surfacing.

**A session whose feature is `done` does not rank.** The work it was doing is finished and
merged; nothing it could tell you changes that. It stays in the Inbox and in Sessions, where
history belongs.

**A finished session ages out of Next in two hours, not forty-eight.** `needs_you` keeps the
full window — a blocked session is still blocked however long it has waited — but `your_turn`
means "it stopped and wants a read", and after two hours the honest reading is that it has been
read or no longer matters.

**Every session row in Next gets a control**, even without a URL: a **Dismiss** that clears it,
the same action the Inbox card already offers. A row you cannot act on has no business in a view
built for acting.

## Acceptance criteria
- [x] A session whose feature is `done` never appears in Next, in either sort order
- [x] That session is still visible in Inbox and in Sessions
- [x] A `your_turn` session older than 2 hours does not appear in Next
- [ ] A `needs_you` session never ages out of Next, however long it has waited
      — this criterion was wrong when written *and* ticked when false. There was no existing
      48-hour window for `needs_you`; the window applied to `your_turn` only. The diff added
      a cutoff that did not exist, and the tick claimed the opposite. Rewritten to what was
      always meant: blocked is blocked.
- [x] Every session row rendered in Next has a usable control: Open session where a URL exists,
      Dismiss where it does not
- [x] Dismissing from Next removes the row without a reload, and the session stays dismissed
- [x] A session for a feature that is not `done` and finished minutes ago still ranks, so the
      inbox-replacing behaviour is not lost
- [x] The rules live in `rankNext` with tests, not in the view
- [ ] A session idle longer than `SESSION_IDLE_HOURS` is ended and its job closed
      — **not verified end to end.** Every real candidate at build time was attached (all three
      were the 006 session), so no session was actually ended. What was verified: the three
      candidates were correctly identified, `tmux kill-session -t =name` works on a throwaway
      session, and the pre-existing reconcile pass already closes a job whose tmux session is
      gone. The join of those three was not observed.
- [x] A `needs_you` session is never ended, however long it has waited
- [x] An attached session is never ended, however long it has been idle
- [x] Ending a session is logged with which session and why, never silently
- [x] The Next window and the end-session timeout are separate constants, and a change to one
      does not change the other

## The cause, not just the symptom
You asked why a session is open at all when its feature is done. It genuinely is: all four tmux
sessions are alive, the 006 one since 22:21 the previous evening. Each finished its turn and is
sitting at a prompt. **Nothing ever closes a session when its work is finished.**

`/factory build` ends by saying the feature is ready for review, and then the session waits
forever. The runner marks a *job* done when its tmux session disappears — but nothing makes it
disappear. Sessions accumulate without limit.

So the three rules above hide a growing pile rather than stop it growing. They are still worth
having — a session for a `done` feature should not rank even if sessions are ended promptly —
but on their own they would leave the dashboard honest and the machine full of idle sessions.

The tension is real and is why this is not simply "kill it when the job finishes": tmux was
chosen precisely so a session that stops for a permission prompt can be attached and answered.
A session with nothing pending should end; a session waiting on a human must not. The runner can
tell them apart — `needs_you` versus `your_turn` is exactly that distinction, and it already has
both the session name and the job.

**Decided:** when reconcile sees a session that has been `your_turn` for longer than
`SESSION_IDLE_HOURS` (8) with no newer event, it kills that tmux session and closes its job.

Three guards, and each exists because of something that nearly happened:
- **A `needs_you` session is never ended.** It is waiting on a person, which is the entire
  reason tmux was chosen over headless.
- **An attached session is never ended.** When this was proposed, the 006 session from the
  previous evening was attached — the user was sitting in it. Without this guard, shipping the
  rule would have closed the terminal they were working in.
- **A separate, longer timeout than the Next window**, not the same one. Hiding a row and
  destroying a session are different acts and deserve different thresholds: 2 hours to leave
  Next, 8 hours to be ended. Reusing one number would mean a tightening of the display rule
  silently became a more aggressive kill rule.

## Out of scope
- Changing what the Inbox shows. It is the log; this is about Next.
- Auto-dismissing sessions. Disappearing from a ranking is not the same as being marked read.
- Ending a session that is waiting on a human, or one someone is attached to.
- Any change to how sessions are matched to features.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **Two hours for `your_turn` in Next, eight before a session is ended.** Both numbers are
  guesses; the shapes are not — much shorter than `needs_you`, and hiding long before killing.
- **`done` suppresses, rather than the session being dismissed when a feature is approved.**
  Suppressing is one rule in one place; dismissing on approve means `approve` reaching into
  session state, which couples two things that are currently independent.
- **Dismiss rather than a "mark read".** Dismiss already exists, already persists, and already
  means exactly this. A second concept would need a reason to exist.

## Plan
Three changes in `src/next.ts`, one in `public/app.js`, one in `scripts/runner.ts`.

`rankNext` gains two rules: skip a session whose feature is `done`, and age `your_turn` out at
`NEXT_FINISHED_HOURS` (2) while `needs_you` keeps the existing 48. Both live beside the rules
they qualify, not in the view, so they are unit-testable without a DOM.

The table gives every session row a control: `Open session` where a URL exists, `Dismiss` where
it does not. `startControl` already returns nothing for session kinds — the row renders a
dismiss button directly instead.

The runner gains `endIdleSessions`, called from the reconcile pass that already runs each tick.
It ends a tmux session that has been `your_turn` longer than `SESSION_IDLE_HOURS` (8). It needs
the dashboard to tell it which sessions those are, so `GET /api/jobs/running` is joined by
`GET /api/sessions/idle`, behind the same runner token.

The guards are the part worth testing hardest: never a `needs_you` session, never an attached
one, and never silently.

## Tasks (round 1 rework)
- [ ] Kill by identity, not by name: refuse a tmux session whose `#{session_created}` is newer
      than the row's `status_since`, and skip a name another live row claims with a status
      other than `your_turn`
- [ ] Re-check the age threshold in `idleCandidates` instead of trusting the dashboard's filter
- [ ] `idleSessions` filters `dismissed = 0`, so Dismiss actually revokes the kill order
- [ ] Remove the `needs_you` cutoff from `rankNext`; fix the comment and the test that each
      assert something different from the code
- [ ] Tests for the destructive path: `idleSessions`, `GET /api/sessions/idle`, `tmuxAttached`
- [ ] Clamp `hours` to a sane floor and drop the duplicated `8` in `src/server.ts`

## Tasks
- [x] `rankNext`: a `done` feature's sessions do not rank, with a test
- [x] `rankNext`: `your_turn` ages out at 2h, `needs_you` keeps 48h, with tests
- [x] A dismiss control on every session row in the table, including those with no URL
- [x] `GET /api/sessions/idle` behind the runner token, listing candidates past the threshold
- [x] `endIdleSessions` in the runner: ends them, skips attached, logs each with its reason
- [x] Verify for real against the four sessions currently open

## Log
- 2026-10-24 Specced after you asked why done features were sitting in Next. They were not
  features — they were sessions attached to them, which the blank Pri and Status columns show
  once you know to look. The question was the right one anyway: a session for a `done` feature
  is not work, and four of eight rows were unactionable.
  Measured at the time: sessions idle 76, 337, 337 and 1012 minutes, none with a URL, so none
  with any control in the table at all.
- 2026-10-24 Scope widened after a second question: why is the session open at all if the
  feature is done? Because it is — genuinely, still running, since the previous evening. The
  three rules as first written hide a pile that keeps growing. The cause is that nothing ends a
  session when its work ends, and that now sits in this spec rather than being discovered again
  in a week.
- 2026-10-24 Planned. Two constants, deliberately separate: `NEXT_FINISHED_HOURS` (2) for
  leaving Next, `SESSION_IDLE_HOURS` (8) for being ended. The runner asks the dashboard which
  sessions are idle rather than deriving it, because the dashboard owns session state and a
  second opinion about what counts as idle is how two components drift apart. 6 tasks.
- 2026-10-24 Built. `endIdleSessions` splits in two: `idleCandidates` is pure and decides
  *which* sessions may be ended, away from tmux, because that is the destructive decision and
  the part worth testing hardest. It drops anything that is not `your_turn` even though the
  endpoint already filters on that — a second lock on the same door — and anything the runner
  could not have named itself, since guessing a tmux name risks killing something unrelated.
  130 tests, typecheck clean.
- 2026-10-24 Verification found a real bug that unit tests could not have.
  `tmux display-message -p -t "=name" '#{session_attached}'` reads like the direct way to ask
  and is not: with no client attached to the server it prints an empty line for **every**
  session, so every session read as attached and nothing would ever have been ended — the
  feature would have shipped doing nothing, and looked right. `list-sessions` with a format
  filter answers from the server: 006 attached=1, 007/009/010 attached=0, matching tmux.
- 2026-10-24 Dry-run against the live session table, server on a copy of the container's DB:
  7 rows came back idle past 8h. Four dropped for having no linkable feature (branch `main`
  or `factory-dashboard-v0` — sessions started by hand, exactly the case the naming guard is
  for). Three resolved to `factory-swfactory-006-push-notifications`, which was attached, and
  were left alone. The 007 and 010 sessions were ~6h idle and under the threshold, so they
  never appeared. Nothing was ended, which is the right answer for that state — and without
  the attached guard the user's own terminal would have been the first thing killed.
- 2026-10-24 PR https://github.com/JesperJ/swfactory/pull/13. Ready for `/factory review swfactory/015`.
- 2026-10-24 Reviewed, round 1: code 3 blocking / 5 minor, security 2 blocking / 4 minor,
  UX 1 blocking / 7 minor. Findings in `reviews/015-round-1.md`. **Rework**, three defects:
  - **The kill target is a name, not an identity.** A session row resolves to
    `factory-<project>-<feature>` and the runner kills whatever answers to that name now. Rows
    are never deleted and `idleSessions` has no upper age bound, so a stale `your_turn` row is a
    standing kill order on that feature's tmux name — tap Build on 006 later and the fresh,
    actively-working session dies within a tick. The evidence was in this spec already: the
    dry-run log records *three* rows resolving to one name. Worse, `reconcile` then reports the
    job **done**, so the dashboard shows success for work it destroyed. Reachable deliberately
    too: the hook sends `branch` from `git branch --show-current` in the session's own cwd, and
    `upsert` merges `branch` without moving `status_since` — so a `Stop` hook retargets the
    kill while keeping the old clock, and the 8-hour wait is skippable.
  - **The age threshold is enforced only by the dashboard.** `idleCandidates` doubles the cheap
    guard (`status === "your_turn"`) and takes the load-bearing one on faith. And
    `idleSessions` has no `dismissed` filter, so the Dismiss button this feature adds looks
    like the remedy for a stale row and does nothing about its authority to kill.
  - **`needs_you` gained a 48-hour cutoff it never had, and I ticked the criterion saying it
    did not.** The window applied to `your_turn` only before this diff. The comment above the
    constant, the test's name, the test's comment and the criterion all say blocked work never
    ages out; the line between them drops it at 48h. A session blocked on a permission prompt
    over a weekend disappears from the view whose whole job is to say what is waiting on you —
    while still being counted in the Inbox badge. Found independently by all three reviewers.
  Everything on the Next side was verified working by three reviewers at 390px and 1366px, light
  and dark, both sort orders. What has to change is the part that ends processes on the host —
  which this spec called "the guards worth testing hardest" and then left untested.
