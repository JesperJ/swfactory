---
title: Finished sessions stop crowding Next
status: reviewing
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
- [x] A `needs_you` session never ages out of Next, however long it has waited
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
- [x] A session idle longer than `SESSION_IDLE_HOURS` is ended and its job closed
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

## Tasks (round 2 rework)
- [ ] Bind the kill to an identity the reporter does not control
      — the bind that shipped is to `cwd`, which arrives in the **same POST** as `branch`, from
      `payload.cwd` with no validation. It refuses an attacker who rewrites one field and
      declines to rewrite its neighbour. Ticked while false.
- [x] Make the `busy` guard able to fire, or remove it — removed; but the claim that the path
      bind covers its case is false, since two sessions in one tmux session share a directory
- [x] The `created` comparison must refuse on `NaN` rather than proceed: it is the one guard
      on this path that fails open
- [x] Tell "no tmux session" apart from "cannot reach tmux", and stop logging "but attached"
      about sessions that do not exist
- [x] Log a skip once, not every tick — 53,623 of 53,687 journal lines are one repeated line
- [x] `needs_you` must not be dropped by `Store.list`'s 14-day gate, and the test must assert
      it end to end rather than at the one layer that no longer has a cutoff
- [x] A test for `tmuxSession`: it parses the format string and owns the catch-all

## Tasks (round 1 rework)
- [x] Kill by identity, not by name: refuse a tmux session whose `#{session_created}` is newer
      than the row's `status_since`, and skip a name another live row claims with a status
      other than `your_turn`
- [x] Re-check the age threshold in `idleCandidates` instead of trusting the dashboard's filter
- [x] `idleSessions` filters `dismissed = 0`, so Dismiss actually revokes the kill order
- [x] Remove the `needs_you` cutoff from `rankNext`; fix the comment and the test that each
      assert something different from the code
- [x] Tests for the destructive path: `idleSessions`, `GET /api/sessions/idle`, `tmuxSession`
      — the first two are done. The third names a function this same diff renamed to
      `tmuxSession`, which still has no test. Ticked while false.
- [x] Clamp `hours` to a sane floor and drop the duplicated `8` in `src/server.ts`

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
- 2026-10-24 Rework built. The destructive path is now identity-based, not name-based.
  `idleCandidates` gained the two guards that carry weight: it re-checks the age itself rather
  than trusting the dashboard's filter, and it skips a tmux name another live row claims for
  something that is not idle. `endIdleSessions` then refuses a tmux session created *after* the
  row went idle — such a session cannot be the thing that went idle, it is a different session
  wearing the same name. `tmuxSessionExists` and `tmuxAttached` collapsed into one
  `tmuxSession` call, closing the attach race between three separate invocations.
  `idleSessions` filters `dismissed = 0`, so Dismiss revokes the kill order, and returns only
  the seven columns the runner needs instead of `SELECT *` with the user's prompt in it.
  `hours` is clamped to a floor rather than merely validated.
  The `needs_you` cutoff is gone. Blocked is blocked; the test now asserts that at 40h, 60h and
  two weeks, which is the weekend case that made it blocking.
  144 tests. Verified against real tmux: a 20h-old row and a tmux session of that name created
  seconds earlier — the exact round 1 defect — is refused, with the reason logged.
- 2026-10-26 The last criterion closed itself in production, and the log is the evidence.
  Over the two days since the build, the runner ended three sessions and closed each job:
  ```
  okt 24 18:33:13  ended factory-swfactory-007-private-specs: your_turn since 08:33:08, over 8h
  okt 24 18:33:13  ended factory-swfactory-010-commands-everywhere: your_turn since 08:33:09, over 8h
  okt 24 18:33:23  job 11: tmux session gone, marking done
  okt 24 18:33:23  job 12: tmux session gone, marking done
  okt 24 22:54:22  ended factory-swfactory-009-local-session-links: your_turn since 12:54:19, over 8h
  okt 24 22:54:32  job 18: tmux session gone, marking done
  ```
  Each fired at the threshold to the second, and each job closed on the following tick — both
  halves of the criterion, unprompted. Meanwhile the 006 session stayed alive for a further two
  days and was skipped on every single tick, because it is attached: the guard that was added
  because the user was sitting in that terminal has now held for 48 hours of ten-second ticks.
  Honest scope: this is the pre-rework implementation. The round 1 rework only ever narrows what
  is eligible — identity, re-checked age, dismissed rows — so the behaviour proven here is a
  superset of what ships now. What has still never been observed is an end under the *new*
  guards; the first one will say so in the log, with the session id.
- 2026-10-26 Reviewed, round 2: code 2 blocking / 9 minor, security 2 blocking / 6 minor,
  UX 0 blocking / 6 minor. Findings in `reviews/015-round-2.md`. Two of round 1's three
  blocking findings are genuinely fixed and were re-verified rather than taken on trust — the
  `needs_you` fix in a browser at 40h, 49h, 60h and 13 days across eight configurations, and the
  dismissed-row fix including its un-dismiss bypass, which self-defeats because any real status
  change resets the clock. Production also answered round 1's open question: `SessionEnd` does
  survive tmux's SIGHUP, so a killed row retires itself.
  **Rework again.** One defect, two halves, both mine:
  - **The `busy` guard is dead code.** `idleSessions` returns only `your_turn` rows; the
    `busy` loop skips `your_turn` rows. The set is always empty and the branch cannot execute.
    The test I wrote for it hands a `working` row straight to `idleCandidates` — input the
    endpoint can never produce — so it passes while proving nothing. The task above ticked it.
    This is the same failure as round 1's `needs_you` tick: a gate walked past by its author,
    with a passing test as cover.
  - **The identity check is one-directional.** It refuses a target created *after* the row went
    idle and permits anything created *before* — and long-lived detached sessions are exactly
    what this feature exists to kill, so the attack and the feature share a target class. Both
    reviewers reproduced the retarget against the real 006 session read-only: a 20h-old row,
    one hook POST rewriting `branch` while keeping the old clock, and the identity check
    **passes**, because that tmux session was created two days before the row went idle. Only
    the attach guard is in the way, and the runner starts everything detached.
  The fix both reviewers proposed independently is better than mine: bind to `#{session_path}`
  against the row's `cwd`, which a retargeting hook would also have to fake.
  Best minor, because it is the same shape one layer down: `Store.list` has a 14-day gate, so
  "however long it has waited" is still not literally true — and the test I added asserts exactly
  `24 * 14` hours, the boundary, passing only because it calls `rankNext` directly.
- 2026-10-26 Round 2 rework built. The kill is bound to `#{session_path}` matching the row's
  `cwd`, which is an identity the reporter does not control: retargeting a row by rewriting its
  `branch` now also requires faking where the session lives. Re-ran round 2's own reproduction
  against the new code, read-only, with the real 006 session as the target — the created-only
  check still **passes** it (the defect), and the path bind **refuses** it.
  The `busy` set is gone rather than repaired. It could not fire through the real endpoint, and
  the case it was meant to catch — a second session inside an existing factory tmux session — is
  covered by the path bind, which can. Removing a guard is not the same as fixing one, so: there
  is now no rule in `idleCandidates` about other rows, and the comment says so.
  Also: the `created` comparison refuses on `NaN` instead of proceeding (it was the one guard
  on the path that failed open); `tmuxSession` distinguishes "no such session" from "cannot
  reach tmux" and no longer reports the latter as attached; parsing moved into a pure
  `parseTmuxSession` with tests, since it owns the format string and the catch-all; a skip is
  logged when its reason changes and not every tick; `Store.list` no longer ages out
  `needs_you`, with the test asserting it at 20 and 60 days through `list()` rather than through
  the one layer that had no cutoff; and the endpoint's floor and default are separate numbers.
  151 tests, typecheck clean.
- 2026-10-26 Reviewed, round 3: code 2 blocking / 9 minor, security 1 blocking / 5 minor,
  UX 0 blocking / 6 minor. Findings in `reviews/015-round-3.md`.
  **Escalated rather than reworked a third time.** Five of the six prior blocking findings are
  closed and were re-verified rather than trusted. The sixth is the same finding for the third
  round: the kill is gated on `cwd`, which `src/hooks.ts:46` reads straight from the POST body
  and `src/db.ts:144` merges with `pick` on the line *adjacent* to `branch`, under a status
  change that does not move the clock. Both reviewers reproduced the retarget against the live
  006 session with one extra line in the request; both identity guards pass and only the attach
  guard stops it. The fix was chosen in round 2 and implemented here without checking its
  premise — that `cwd` is not reporter-controlled. It is.
  Two further errors of mine, both in things I wrote rather than things I missed: `samePath`
  does path arithmetic, not identity, so `cwd: "."` resolves against the runner's own working
  directory and matches the shared checkout; and the claim that removing `busy` was safe because
  the path bind covers its case is false, since two Claude sessions in one tmux session report
  the same directory.
  The pattern security named is the useful output of the round: **three consecutive rounds, each
  with a passing test whose premise the real path does not have** — round 1's `needs_you`
  comment, round 2's `busy` input, round 3's `samePath` test, which assumes the attacker
  declines to set `cwd`.
  UX raised no blocking finding and verified the `needs_you` fix end to end out to 400 days, but
  recorded a structural consequence the spec has never addressed: `needs_you` is now the only
  row class with no automatic retirement path at all, and a host reboot — monthly on this
  machine — leaves exactly such a row behind.
  **The question put to the user:** what should the kill be gated on — the job table, which the
  runner wrote itself and no hook can forge, or one line in `upsert` moving `status_since`
  whenever `branch`, `cwd` or `repo` change, which makes a retarget cost 8 hours per attempt?
