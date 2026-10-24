---
title: A worktree per job
status: specced
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
- [ ] A job never runs in the shared checkout; the runner only ever launches inside a worktree
      under its own directory
- [ ] Two jobs for different features run at the same time without either seeing the other's
      changes, each on its own branch
- [ ] A `build` job for feature NNN runs on `feature/<NNN>-<slug>`, whatever branch anything
      else is on
- [ ] Starting a job while I have uncommitted changes in my checkout neither sees nor disturbs
      them
- [ ] A second job for the same feature reuses that feature's worktree rather than failing or
      creating a second one
- [ ] A worktree that cannot be created — a branch already checked out elsewhere, a dirty tree,
      a missing base branch — fails the job with that reason on the dashboard, and starts no
      session
- [ ] Commits made in a worktree are visible in the main repo with no extra step
- [ ] Finished worktrees are cleaned up, and cleanup never removes one with an unmerged branch
      or a live session
- [ ] The tmux session name still identifies the job, and attaching still works
- [ ] `findCheckout` still resolves the repository by git remote; the worktree is created from
      whatever it finds

## Out of scope
- Running jobs for more than one project at once in the same worktree directory. Each project
  gets its own subdirectory and that is all the separation needed.
- Worktrees for sessions a human starts by hand. This is about what the runner does.
- Pushing or merging from a worktree beyond what `/factory build` already does.
- Cleaning up branches. Worktrees are disposable; branches are not.

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

## Log
- 2026-10-24 Specced after the hazard fired three times in one day: a spec job committing to
  `main`, a build started into a checkout holding unrelated uncommitted work, and a review
  session launched into a tree that was mid-build on another branch. The last was triggered by a
  UI test of the very button that queues jobs, which is as clear a sign as any that this gets
  worse the more the dashboard is used rather than better.
  005 named this as an open question and deferred it. It is no longer theoretical.
