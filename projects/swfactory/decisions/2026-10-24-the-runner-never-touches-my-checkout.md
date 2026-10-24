---
title: The runner never touches the human's checkout
date: 2026-10-24
status: accepted
---

# The runner never touches the human's checkout

## Context
The runner started sessions in `~/code/repos/<project>` — the same working tree a person edits
in. That is one mutable resource with no owner: the runner, the person, and any number of
started sessions all want it, and git offers no way to share it.

The failure is quiet. Two sessions in one tree do not collide loudly; they interleave, and the
result is a commit on the wrong branch found later. In one day this produced a spec committed
to `main` because `main` happened to be checked out, a build started into a tree holding
unrelated uncommitted work, and a review session launched into a tree that was mid-build on
another branch.

It also gets worse with use rather than better. The dashboard exists to start work with a tap,
so every improvement to it increases the number of things wanting that one tree.

## Decision
The runner never runs anything in a checkout a person uses. It resolves the repository there,
and then works only inside a git worktree it created, under a directory it owns.

This is an invariant, not a default. A future change may alter where worktrees live, how they
are named, or when they are cleaned up. It may not reintroduce a path where a started session
runs in the shared checkout — including as a fallback when creating a worktree fails. Falling
back to the shared tree is precisely today's behaviour, and today's behaviour is the bug.

A worktree shares the repository's object store, so the cost is a checkout of files: no second
clone, no duplicated history, and commits are visible from the main repo with no extra step.

## Consequences
Better:
- Two jobs for different features can run at once, which the dashboard's whole design invites
  and which was previously unsafe.
- A person's uncommitted work is untouchable by anything the runner does.
- A job runs on the branch its work belongs on, rather than whichever branch was checked out.

Worse:
- The runner creates and removes directories outside the repository, which is the first code
  here to do so and the first that could delete something it should not.
- A disk cost per active feature, and a directory that needs cleaning up.
- One more failure mode — a worktree that cannot be created — though it fails loudly by design.

## Revisit if
Jobs need to run on a machine that does not hold the repository at all, in which case the
worktree becomes a clone and this decision's shape survives unchanged. Nothing about the
invariant should be revisited: the shared checkout belongs to the person using it.
