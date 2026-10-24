---
title: Finished sessions stop crowding Next
status: specced
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
- [ ] A session whose feature is `done` never appears in Next, in either sort order
- [ ] That session is still visible in Inbox and in Sessions
- [ ] A `your_turn` session older than 2 hours does not appear in Next
- [ ] A `needs_you` session keeps the existing 48-hour window, whatever its age
- [ ] Every session row rendered in Next has a usable control: Open session where a URL exists,
      Dismiss where it does not
- [ ] Dismissing from Next removes the row without a reload, and the session stays dismissed
- [ ] A session for a feature that is not `done` and finished minutes ago still ranks, so the
      inbox-replacing behaviour is not lost
- [ ] The rules live in `rankNext` with tests, not in the view

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

**Proposed, and the part most worth challenging:** when reconcile sees a job whose session has
been `your_turn` for longer than the Next window, and no newer event has arrived, it kills that
tmux session and closes the job. A `needs_you` session is never killed. An attached session is
never killed, because someone is in it.

## Out of scope
- Changing what the Inbox shows. It is the log; this is about Next.
- Auto-dismissing sessions. Disappearing from a ranking is not the same as being marked read.
- Ending a session that is waiting on a human, or one someone is attached to.
- Any change to how sessions are matched to features.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **Two hours for `your_turn`.** Long enough to survive lunch, short enough that yesterday's
  sessions are gone. The number is a guess; the shape — much shorter than `needs_you` — is not.
- **`done` suppresses, rather than the session being dismissed when a feature is approved.**
  Suppressing is one rule in one place; dismissing on approve means `approve` reaching into
  session state, which couples two things that are currently independent.
- **Dismiss rather than a "mark read".** Dismiss already exists, already persists, and already
  means exactly this. A second concept would need a reason to exist.

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
