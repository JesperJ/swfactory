---
title: A worktree per job
status: done
priority: P1
summary: The runner builds in its own git worktree instead of the shared checkout, so jobs can't collide with each other or with me.
---

# A worktree per job

## Why
The runner launches every session in the one shared checkout at
`~/code/repos/<project>`, on whatever branch that checkout happens to be sitting on, with
whatever uncommitted changes happen to be in it. Nothing checks, and nothing can: there is one
working tree and any number of things that want it.

This has gone wrong three times in a single day:

- A spec job ran on `main` and committed there, because `main` was what was checked out. It
  was correct only by accident.
- A build job was started while the checkout sat on `feature/012-next-table` with uncommitted
  work in it. It happened to be the right branch, again by accident.
- A UI test tapped a button, which queued a job, which the runner started as a *review* session
  in that same checkout while it was mid-build on another branch. It was killed within seconds;
  had it run, it would have written a findings file and committed it onto an unrelated feature
  branch.

Twice already I have had to do my own work in a `git worktree` to avoid colliding with a
running session — which is the answer, applied by hand, to a problem the runner should not
create. And the failure mode is quiet: two sessions in one tree do not error, they interleave,
and the damage shows up later as commits on the wrong branch.

Nothing about this gets better with use. It gets worse: the whole point of the dashboard is to
start work with a tap, and every tap is another chance for two sessions to want the same tree.

## What
The runner stops using the shared checkout. For each job it creates a git worktree, dedicated
to that job, on the branch that job's work belongs on, and launches the session there.

```
~/code/repos/swfactory                 ← mine. The runner never touches it.
~/.cache/factory/worktrees/
  swfactory-006-push-notifications/    ← one job, one tree, one branch
  swfactory-012-next-table/
```

A worktree shares the repository's object store, so this costs a checkout of the files and
nothing else — no second clone, no duplicated history, and every branch and commit is visible
from the main repo immediately.

The branch a job gets follows what the command does:

| Command | Branch |
| --- | --- |
| `build` | `feature/<NNN>-<slug>`, created from the default branch if new, reused if it exists |
| `plan`, `spec`, `review` | the same feature branch when it exists, else the default branch |

Worktrees are reused across jobs for the same feature rather than recreated, so a second build
on a feature continues where the first left off. A worktree whose branch has been merged and
whose session has finished is removed, so the directory does not grow without bound.

## Acceptance criteria
- [x] A job never runs in the shared checkout; the runner only ever launches inside a worktree
      under its own directory
- [x] Two jobs for different features run at the same time without either seeing the other's
      changes, each on its own branch
- [x] A `build` job for feature NNN runs on `feature/<NNN>-<slug>`, whatever branch anything
      else is on
- [x] Starting a job while I have uncommitted changes in my checkout neither sees nor disturbs
      them
- [x] A second job for the same feature reuses that feature's worktree rather than failing or
      creating a second one
- [x] A worktree that cannot be created — a branch already checked out elsewhere, a dirty tree,
      a missing base branch — fails the job with that reason on the dashboard, and starts no
      session
- [x] Commits made in a worktree are visible in the main repo with no extra step
- [x] Finished worktrees are cleaned up, and cleanup never removes one with an unmerged branch
      or a live session
- [x] The tmux session name still identifies the job, and attaching still works
- [x] `findCheckout` still resolves the repository by git remote; the worktree is created from
      whatever it finds

## Out of scope
- Running jobs for more than one project at once in the same worktree directory. Each project
  gets its own subdirectory and that is all the separation needed.
- Worktrees for sessions a human starts by hand. This is about what the runner does.
- Pushing or merging from a worktree beyond what `/factory build` already does.
- Cleaning up branches. Worktrees are disposable; branches are not.

## Plan
One module, one call site. The runner already resolves the repository by git remote; everything
here happens between finding it and launching tmux.

**1. `worktreeFor(job)` — pure, so the naming is testable without touching git.** Returns the
directory and the branch a job should use: `<root>/<project>-<feature>` and
`feature/<NNN>-<slug>`, with the feature slug sanitised the same way `sessionName` already
sanitises it. A job with no feature (a project-level `spec`) gets the default branch and a
`<project>-base` tree, because there is no feature branch to put it on.

**2. `ensureWorktree(repoPath, dir, branch, base)` — creates, or adopts what is there.**
Three cases, in order:
- the directory exists and `git -C <dir> rev-parse --git-dir` confirms it is a worktree on the
  expected branch → reuse it, which is what keeps an interrupted build's uncommitted work;
- the directory does not exist → `git worktree add` it, creating the branch from `base` when
  the branch is new and checking it out when it already exists;
- anything else — a directory that is not a worktree, a worktree on the wrong branch, a branch
  already checked out elsewhere → throw a `JobError` naming which, so the job fails with that
  reason on the dashboard and no session starts.

The base branch is read from `refs/remotes/origin/HEAD`, falling back to `main` and then to the
repository's current HEAD. No network call: a runner that needs the network to start a job is a
runner that stops working when the network does.

**3. `start()` launches in the worktree.** The one substantive change to existing code:
`findCheckout` still resolves the repository, then `ensureWorktree` turns that into the
directory tmux is given. The shared checkout becomes the thing worktrees are *made from* and
never the thing anything runs in.

**4. Cleanup, inside the existing reconcile pass.** When reconcile finds a job whose session has
gone, it also considers that job's worktree: if the branch is merged into base and the tree is
clean, `git worktree remove` it. Never `--force`, so a tree with uncommitted work is kept rather
than discarded — a stuck build's unsaved state is worth more than a tidy directory. Reusing the
pass that already runs means no timer and no second place that knows about worktrees.

Chosen over a worktree per *job* (rather than per feature): a second build on the same feature
should continue where the first stopped, and per-job trees would throw that away every time.

Risk worth naming: this is the first code that creates and deletes directories outside the
repository. `git worktree remove` on the wrong path is the kind of mistake that is quiet and
expensive, so removal only ever acts on a path `worktreeFor` produced and only on a tree git
itself reports in `git worktree list`.

Tests use real git repositories in a temp directory, as `test/runner.test.ts` already does for
`findCheckout` — worktree behaviour is exactly the kind of thing a mock would get wrong.

## Tasks
- [x] `worktreeFor`, pure: directory and branch per job, including the no-feature case
- [x] `defaultBranch`, reading `refs/remotes/origin/HEAD` with fallbacks and no network
- [x] `ensureWorktree`: create, reuse, and throw a named `JobError` on every other case
- [x] `start` launches tmux in the worktree; the shared checkout is only ever the source
- [x] Tests against real git repos: two features at once, reuse keeps uncommitted work, a
      branch checked out elsewhere fails the job
- [x] A worktree failure reaches the dashboard as a failed job with its reason, and no session
- [x] Cleanup in reconcile: remove only a merged, clean worktree git itself lists; never force
- [x] Dogfood: queue two jobs for different features at once and watch them not collide

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **`~/.cache/factory/worktrees/<project>-<feature>`**, not a directory inside the repo. Inside
  the repo it would show up in `git status`, in the specs bind mount, and in every editor's file
  tree. `FACTORY_WORKTREE_ROOT` overrides it.
- **Reuse, not recreate.** A worktree per *feature*, not per job. Recreating would throw away an
  interrupted build's uncommitted work, which is the thing most worth keeping after a session
  dies.
- **The base is the repository's default branch**, read from the remote rather than assumed to
  be `main`.
- **Cleanup runs in the runner, not on a timer**, when it notices a worktree whose branch is
  merged and whose session is gone — the same reconcile pass that already closes finished jobs.
- **A job that cannot get a clean worktree fails loudly rather than falling back to the shared
  checkout.** Falling back is what today's behaviour already is, and it is the bug.
- ~~**A fresh worktree has no `node_modules`.**~~ Settled: the session installs, not the runner.
  The runner deals in git and tmux and has no business knowing which language a project is
  written in, while the session is already in the repository and can see. `factory.md` and both
  code-running reviewers now say so. Measured before and after on a fresh worktree: 15
  `ERR_MODULE_NOT_FOUND` failures, then 123 passing.

## Log
- 2026-10-24 Specced after the hazard fired three times in one day: a spec job committing to
  `main`, a build started into a checkout holding unrelated uncommitted work, and a review
  session launched into a tree that was mid-build on another branch. The last was triggered by a
  UI test of the very button that queues jobs, which is as clear a sign as any that this gets
  worse the more the dashboard is used rather than better.
  005 named this as an open question and deferred it. It is no longer theoretical.
- 2026-10-24 Planned. One module and one call site: `findCheckout` still resolves the
  repository, then `ensureWorktree` turns that into the directory tmux is given, so the shared
  checkout becomes the thing worktrees are made *from* and never the thing anything runs *in*.
  Cleanup rides the reconcile pass that already closes finished jobs rather than adding a timer.
  Chose a worktree per feature over per job: a second build on a feature should continue where
  the first stopped, and per-job trees would discard that every time.
  Recorded `decisions/2026-10-24-the-runner-never-touches-my-checkout.md`, because "never run in
  a tree a person uses" is an invariant later work must not quietly undo — particularly as a
  fallback when creating a worktree fails, which is today's behaviour and today's bug.
  Tests use real git repositories rather than mocks: worktree semantics are exactly what a mock
  would get wrong. 8 tasks.
- 2026-10-24 Build started on `feature/013-worktree-per-job`.
- 2026-10-24 Built and dogfooded. Two jobs for different features ran at the same time in
  separate worktrees on separate branches, while this checkout stayed on `feature/013` and the
  007 worktree could not see this spec. That is the thing that was impossible before.
  The dogfood found a defect the plan missed: a job for a feature whose session is still alive
  created its worktree and then failed on a raw tmux "duplicate session" error, leaving an empty
  tree behind. The session name is now checked first, so the job fails with a sentence that says
  what to do — attach to it or let it finish — and nothing is created.
  Cleanup is guarded four ways and tested on each: it keeps a dirty tree, keeps an unmerged
  branch, keeps the base tree, and refuses any path git does not itself list as a worktree. It
  never passes `--force`. 120 tests, typecheck clean.
- 2026-10-24 Review round 1 (`reviews/013-round-1.md`): 4 blocking, 15 minor across three
  reviewers. Escalated rather than reworked, because one blocking finding changes the feature's
  premise rather than its code. review-ux 2: the session now writes specs inside the worktree
  and commits them to an unmerged branch, while the dashboard reads `SPECS_DIR` in the shared
  checkout — so the dashboard no longer sees the work it starts. Live proof on this machine:
  007 and 010 are `specced` in their worktrees and `idea` on the dashboard, which keeps
  recommending "Spec it" for both. During a build, tasks never tick. The spec's What and Out of
  scope never considered where specs land once the session stopped sharing my checkout, so this
  is a spec decision, not a bug fix.
  The other three blocking findings are local and reworkable once that call is made:
  review-code 1, cleanup is attempted only in the tick a session ends, which is always before
  the human merges, so a worktree per feature accumulates forever (006 and 012 are merged,
  clean and still present); review-code 2, `worktreeFor` ignores `job.command`, so `spec` and
  `plan` jobs land on a feature branch the What table says should be the default branch;
  review-ux 1, `white-space: nowrap` on `.c-action` means a failure reason blows the layout to
  1384px at 375px width, so the reason the criterion promises is the one thing unreadable.
  Also noted: PR #7 is already merged into `main`, so all of this has landed.
- 2026-10-24 Round 1 reworked. The escalation was answered: **specs are shared state and live in
  one place**, `$FACTORY_HOME/projects`, written and committed there whatever worktree a session
  is working in. The runner passes `FACTORY_HOME` through `tmux -e`, and `factory.md` now says
  it as a rule rather than leaving it to be inferred. Code stays on the feature branch; specs
  and code are committed in different working trees, deliberately.
  The three local blockers are fixed: `worktreeFor` now gives a feature branch only to `build`,
  so `spec`, `plan` and `review` stay on the default branch as the What table always said;
  cleanup became `sweepWorktrees`, running every tick over every tree git lists rather than only
  in the tick a session ended — which was always before a human could merge, so nothing was ever
  collectable; and `.c-action` no longer forces `nowrap` on a failure reason, which was blowing
  a 375px layout to 1384px and hiding the one sentence the criterion promises.
  Found while fixing, and not in any review: **a fresh worktree has no `node_modules`**, so the
  first `npm test` a build runs in one fails with `ERR_MODULE_NOT_FOUND`. I hit it on the first
  command in this very worktree. Recorded as an open question below rather than fixed here —
  whether the runner should install dependencies, or the build command should, is a real choice.
  123 tests, typecheck clean.
- 2026-10-24 Closed the `node_modules` open question. The session installs dependencies when a
  worktree has none, rather than the runner doing it on create: the runner is language-agnostic
  by design and adding `npm ci` to it would make it know about npm, which is the wrong place for
  that knowledge to live. Verified on a throwaway worktree — first `npm test` produced 15
  `ERR_MODULE_NOT_FOUND`, and after installing, 123 passing.
- 2026-10-24 **Passed**, on the user's own review rather than a machine round 2.
  All 10 acceptance criteria met. `reviews/013-round-1.md` returned 4 blocking and 15 minor; the
  escalation it raised was answered — specs are shared state in one place — and the three local
  blockers were fixed and merged, along with the `node_modules` gap that no reviewer found.
  123 tests, typecheck clean on `main` at the time of passing.
  **Deviation recorded, not hidden:** `approve` says never to pass against findings that predate
  the current code, and round 1 does — the rework changed branch selection, cleanup, the phone
  layout and where specs are written. That rule exists to stop this command certifying its own
  work. The user read the rework and merged it, which is the authority the rule defers to, and
  said so explicitly before invoking approve. Spending three agents to re-read code a human had
  already reviewed would have bought nothing.
  If this becomes a habit rather than a judgement, the rule is the thing to change — an
  `approve --reviewed-by-hand` that records who, rather than a convention of ignoring the check.
