---
title: The sweep stops eating worktrees that were never used
status: specced
priority: P1
summary: A worktree created by hand is deleted within seconds, because an empty branch and a merged branch look identical to the sweep.
---

# The sweep stops eating worktrees that were never used

## Why
`git worktree add -b feature/016-x ~/.cache/factory/worktrees/016 main` and the directory is gone
about twenty seconds later, with `[runner] removed worktree …` in the journal. It happened for
real during 014's rework and cost a detour mid-task; the worktree had to be abandoned and the
work done in the main checkout instead.

It is not a race and not a one-off. `pruneWorktree` decides a tree is collectable when

```
git branch --no-merged <base> --list <branch>
```

comes back empty. That output is empty in **two** situations that have nothing to do with each
other:

- the branch's commits have landed in the base — finished work, safe to collect;
- the branch has no commits at all — a branch created at the base and not yet written to.

A worktree made seconds ago sits exactly at the base tip, so it contains nothing that is not in
the base, and the sweep reads that as "done". 013 added this sweep to stop worktrees accumulating
forever; it collects the one case where nothing has happened yet.

The directory under `~/.cache/factory/worktrees/` is therefore unusable by hand while the runner
is running, which is most of the time.

## What
`pruneWorktree` gains the distinction it is missing: **a branch that has never had a commit of
its own has not landed, it has not started.** Two independent guards, because this deletes a
directory and 015's rounds established that one lock on a destructive path is not enough.

**A branch whose tip equals the base's tip is never collected.** Nothing has been committed to it,
so there is nothing that could have been merged. This is deterministic — no clock, no heuristic —
and it is the exact shape of the reported bug.

**A worktree younger than a grace period is never collected**, however its branch looks. This
covers the case the tip check misses: a fresh empty branch whose base moves on underneath it,
which then looks merged while still being brand new. It also matches the human reality the bug
report came from — somebody is about to type in that directory.

The sweep's actual job is unchanged: a feature branch whose work is merged still gets collected,
which is what 013 was for.

## Acceptance criteria
- [ ] A worktree on a branch with no commits of its own is not collected, at any age
- [ ] A worktree created within the grace period is not collected, even if its branch looks merged
- [ ] A worktree whose branch has commits that are merged into the base **is** still collected,
      so 013's purpose survives
- [ ] A worktree with uncommitted changes is still kept, as now
- [ ] A worktree on an unmerged branch is still kept, as now
- [ ] The base tree and a detached tree are still kept, as now
- [ ] Each rule has a test against a real git repository, not a mock
- [ ] Verified for real: create a worktree by hand with the runner running, and watch it survive

## Out of scope
- Changing when the sweep runs. Every tick is right; 013's log says why.
- Removing worktrees for branches deleted on the remote. Different problem, no evidence it bites.
- Making the runner aware of worktrees a human made. The grace period and the tip check are
  enough, and an ownership marker is state to keep in sync for no proven gain.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **A grace period of 30 minutes.** Long enough to cover making a tree and then being
  interrupted; short enough that an abandoned empty tree is collected the same day. The number is
  a guess; the shape — minutes, not seconds, and not days — is not.
- **Birth time, falling back to mtime.** `statSync` reports `birthtime` on ext4 here. Where it is
  unavailable it reads as the epoch, which would defeat the guard, so the fallback is mtime and
  the check takes whichever is *later* — failing toward keeping the tree.
- **Both guards, not one.** The tip check alone fixes the reported bug. The grace period alone
  would too, for thirty minutes. Keeping both means a mistake in either still leaves the other,
  which is the lesson 015 paid for twice.
