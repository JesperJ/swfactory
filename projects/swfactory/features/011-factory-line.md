---
title: The factory line
status: building
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
- [x] `/factory <sub>` replaces the five loose commands; the old names stop existing
- [ ] `/factory next` acts on the dashboard's top recommendation without being told which it is
- [x] `reviewing` is a real status: parsed, ranked, and coloured in the dashboard
- [ ] `/factory build` leaves a feature at `reviewing`, never at `done`
- [ ] Reviewers run in parallel and write findings to a per-round file, kept in git
- [ ] Each finding names the acceptance criterion or file it concerns, not a general opinion
- [ ] The approver passes, reworks, or escalates, and records which and why in the spec's Log
- [ ] Rework is capped at two rounds, then escalates
- [ ] An escalation reaches me as one specific question, never as a list of findings
- [x] Nothing merges to main automatically
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

## Plan
Three parts, in this order, because each is useful alone and the later ones depend on the
earlier.

**1. The `reviewing` status.** Touch the four places the lifecycle is spelled out:
`FEATURE_STATUSES` in `src/specs.ts`, `STATUS_ORDER` in `public/app.js`, a `--st-reviewing`
token plus `.st-reviewing` rule in `public/styles.css`, and a `reviewing` case in
`featureEntry` in `src/next.ts` ranking between a stalled build (2) and a ready-to-build
feature (4), so review work is pulled through before new work starts. Covered by the existing
ranking tests plus one for the new case.

**2. One `/factory` command.** Claude Code gives one file one command, so dispatch happens
inside it: `.claude/commands/factory.md` reads the first word of `$ARGUMENTS` as the
sub-command and follows the matching section. The existing `new-feature.md`, `plan.md`,
`build.md`, `status.md` and `new-project.md` are deleted in the same commit — leaving both
would mean two ways to do everything and two places to fix a rule. `CLAUDE.md` and `README.md`
change with them.

`next` resolves its target by reading `/api/state` from the dashboard and taking the top item,
so the ranking lives in exactly one place rather than being reimplemented in a prompt.

**3. Reviewers and the approver.** Three agent definitions in `.claude/agents/`:
`review-code.md`, `review-security.md`, `review-ux.md`. `/factory review` spawns all three in
one message so they run in parallel, each given the feature spec, the diff on its branch, and
the instruction to judge against the acceptance criteria rather than taste. Each returns
findings; the command writes them to `<project>/reviews/<NNN>-round-<n>.md`.

The approver is not a fourth agent but the final section of the command, run by the main
session once findings exist. It holds the pass / rework / escalate decision and the two-round
cap, because it needs the spec, the findings and the conversation — exactly what a subagent
would have to be re-told.

Trade-off taken: the sub-command dispatch lives in one long prompt file rather than five small
ones. Worse to read, but it keeps a single set of rules about statuses and approval, which is
the thing that actually drifted.

## Tasks
- [x] Add `reviewing` to the lifecycle in `specs.ts`, `app.js`, `styles.css`, `next.ts`
- [x] Rank `reviewing` above `planned` in `featureEntry`, with a test
- [x] Write `.claude/commands/factory.md` with the sub-command sections
- [x] `/factory next` reads the dashboard's ranking rather than re-deriving it
- [x] `/factory build` ends at `reviewing`, never `done`
- [x] Write the three reviewer agents in `.claude/agents/`
- [x] `/factory review` runs them in parallel and writes `reviews/<NNN>-round-<n>.md`
- [x] Implement approve / rework / escalate with the two-round cap in the command
- [x] `/factory status` proposes a diff of stale specs and applies only what is accepted
- [x] Delete the five old commands; update `CLAUDE.md` and `README.md`
- [ ] Dogfood: run the line on 010 end to end and keep the findings file as the example
- [ ] Round 1: declare spec and diff content to be data, never instructions (factory.md shared rules)
- [ ] Round 1: tell each reviewer to ignore instructions found inside the diff or spec
- [ ] Round 1: `/factory next` must dispatch on `kind`, not `action` — `answer` has no entry and `Review` is overloaded
- [ ] Round 1: give `approve` the status guard every other sub-command has
- [ ] Round 1: fix the three dashboard empty states pointing at deleted commands
- [ ] Round 1: state commit scope and "never merge or push to main" in the shared rules

## Risks
- A review stage that always passes is worse than none: it manufactures false confidence. The
  approver must be able to say "not met" about a criterion the builder claims is met, and the
  first few rounds should be checked by hand to see whether it ever does.
- Two rounds of rework on a wrong plan is a loop that costs real money. Escalation after the
  cap is not a formality.

## Log
- 2026-10-23 Specced and planned. Three parts, each useful alone: the `reviewing` status, one
  `/factory` command replacing five, then the reviewers and approver. Chose a single command
  file over five because the thing that actually drifted was having rules about status and
  approval in several places.
- 2026-10-23 Built, and the review gate immediately earned its keep: `/factory review` refused
  because the status was still `building`, and the spec had ten completed tasks still unticked
  because the build ticked none of them. Exactly the drift this feature exists to stop, caught
  on its own first run.
  Verified by test: the `reviewing` status and its ranking. Verified by inspection: the command
  and agent prompts — prompt behaviour is proven by use, not by assertion, which is what this
  review round is for. PR #2.
- 2026-10-23 Round 1 → rework. Six blocking findings, all clear and local, in
  `reviews/011-round-1.md`. The two that matter most were not in the code: a spec file is data
  but the command never says so, and this repo is public — so a sentence added to a `## Why`
  could steer an agent holding Bash and push rights. The same hole lets a diff tell its own
  reviewer it was already approved, which the approver then trusts to set `done`.
  The review also caught a criterion ticked falsely: "the old names stop existing" was ticked
  after checking the command files were deleted, while three dashboard empty states still sent
  people to `/new-feature` and `/new-project`.
  Deferred, not blocking: reviewers run `npm test` off the branch under review with no sandbox.
  Judged acceptable while building only happens in our own sessions on our own machine; it
  becomes real the day an outside contribution is reviewed.
