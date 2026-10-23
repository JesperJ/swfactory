---
title: The factory line
status: specced
priority: P1
summary: One /factory command, a review stage before done, and an approver that absorbs the decisions that don't need me.
---

# The factory line

## Why
Two things are wrong with the workflow today.

**Nothing stands between `building` and `done` except my own say-so.** Four features sat at
`building` while they were actually finished, which filled the Next view with noise and made
the dashboard describe a world that had moved on. A status that only a human remembers to
change is a status that is usually wrong.

**Statuses can lie about approval.** `specced` is supposed to mean the acceptance criteria were
agreed. In practice a spec gets written and the status set in the same breath, with no review
in between — which is exactly how 005 ended up marked `specced` before anyone had read it.

And the commands are five separate things to remember, two of which (`/plan`, `/build`) are
names that collide with ordinary vocabulary.

## What
One namespaced command, and a review stage that produces the approval the statuses claim.

```
/factory next               # do the top thing the dashboard recommends
/factory spec <idea>        # draft a spec           -> specced
/factory plan <id>          # approach and tasks     -> planned
/factory build <id>         # implement on a branch  -> reviewing
/factory review <id>        # run the reviewers      -> reviewing
/factory approve <id>       # accept findings        -> done
/factory rework <id> <note> # send back with a note  -> building
/factory status             # the standing review pass
```

`/factory next` is the one that matters: it reads the same ranking the dashboard shows and does
that thing, so a recommendation becomes an action without my deciding anything twice.

### The line

```
spec ──▶ plan ──▶ build ──▶ ┌─ code review ────┐
                            ├─ security review ├──▶ approver ──┬──▶ done
                            └─ UX review ──────┘               │
                                    ▲                          ├──▶ rework (max 2)
                                    └──────────────────────────┘
                                                               └──▶ escalate to me
```

Reviewers run in parallel against the feature's own acceptance criteria and write findings into
`<project>/reviews/<NNN>-round-<n>.md`. The approver reads them and does exactly one of:

- **pass** — every criterion met, no blocking finding. Sets `done`, logs why.
- **rework** — blocking findings that are clear and local. Returns to `building` with the
  findings as the note. At most two rounds, then it escalates regardless.
- **escalate** — anything needing judgement, taste, or money. Surfaces as **one specific
  question** in the dashboard, not a dump of findings.

### Lifecycle
`idea → specced → planned → building → reviewing → done`, with `reviewing` new. The approver
owns the transition to `done`; no command sets it directly.

### What this deliberately does not do
It does not merge to main. The approver's job is to make sure only reviewed work reaches me,
not to remove the last decision. Merging stays mine, with the findings already attached.

## Acceptance criteria
- [ ] `/factory <sub>` replaces the five loose commands; the old names stop existing
- [ ] `/factory next` acts on the dashboard's top recommendation without being told which it is
- [ ] `reviewing` is a real status: parsed, ranked, and coloured in the dashboard
- [ ] `/factory build` leaves a feature at `reviewing`, never at `done`
- [ ] Reviewers run in parallel and write findings to a per-round file, kept in git
- [ ] Each finding names the acceptance criterion or file it concerns, not a general opinion
- [ ] The approver passes, reworks, or escalates, and records which and why in the spec's Log
- [ ] Rework is capped at two rounds, then escalates
- [ ] An escalation reaches me as one specific question, never as a list of findings
- [ ] Nothing merges to main automatically
- [ ] `/factory status` proposes a diff for stale specs — ticked-but-open, done-but-building,
      blocked-but-planned — and applies only what I accept

## Out of scope
- Starting sessions from the dashboard. That is 005; this is what runs once one is started.
- Replacing GitHub PR review. These reviewers gate the factory's own lifecycle, not the repo's.
- Reviewing anything but the feature in hand.

## Open questions
- Assumed three reviewers — code, security, UX — rather than four. UI and UX reviews collapse
  into one for a project this size; splitting them is easy later.
- Assumed reviewers get a cheaper model than the builder and the approver, since finding a
  problem is easier than fixing one. Worth measuring rather than believing.
- Assumed the approver may set `done` without me, given it cannot merge. If that proves too
  loose, the pass branch becomes an escalation too.
- Assumed review findings live in `reviews/` beside `decisions/`, in git, so a rework round can
  cite the previous one.

## Risks
- A review stage that always passes is worse than none: it manufactures false confidence. The
  approver must be able to say "not met" about a criterion the builder claims is met, and the
  first few rounds should be checked by hand to see whether it ever does.
- Two rounds of rework on a wrong plan is a loop that costs real money. Escalation after the
  cap is not a formality.
