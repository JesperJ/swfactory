---
title: The sweep stops eating worktrees that were never used
status: done
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

**A branch that has never been committed to is never collected.** Nothing has landed because
nothing has started. ~~Compare the branch tip against the base tip~~ — see the Log: that was
backwards, and the reflog is what actually answers the question.

**A worktree younger than a grace period is never collected**, however its branch looks. This
covers the case the tip check misses: a fresh empty branch whose base moves on underneath it,
which then looks merged while still being brand new. It also matches the human reality the bug
report came from — somebody is about to type in that directory.

The sweep's actual job is unchanged: a feature branch whose work is merged still gets collected,
which is what 013 was for.

## Acceptance criteria
- [x] A worktree on a branch with no commits of its own is not collected, at any age
- [x] A worktree created within the grace period is not collected, even if its branch looks merged
- [x] A worktree whose branch has commits that are merged into the base **is** still collected,
      so 013's purpose survives
- [x] A worktree with uncommitted changes is still kept, as now
- [x] A worktree on an unmerged branch is still kept, as now
- [x] The base tree and a detached tree are still kept, as now
- [x] Each rule has a test against a real git repository, not a mock
- [x] Verified for real: create a worktree by hand with the runner running, and watch it survive

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

## Plan
One function changes: `pruneWorktree` in `scripts/runner.ts`. Nothing else in the runner, the
dashboard or the UI is touched, and the sweep keeps running every tick.

Two guards go in ahead of the existing `--no-merged` check, both failing toward keeping the tree:

1. **Tip equality.** `git rev-parse <branch>` against `git rev-parse <base>`. Equal means the
   branch holds no commit of its own, so nothing about it has landed — it has not started. This
   is the reported bug exactly, and it is decided without a clock.
2. **A grace period.** `WORKTREE_GRACE_MINUTES` (30), measured from the later of the worktree
   directory's `birthtime` and `mtime`, because `birthtime` reads as the epoch on filesystems
   that do not record it and the later of the two fails safe.

The age check is extracted as `worktreeAge`, pure but for one `statSync`, so the boundary can be
tested without waiting thirty minutes.

Chosen over the alternative — marking trees the runner created and only sweeping those — because
a marker is state that has to stay in sync with the filesystem, and gets stale exactly when the
runner crashes, which is when a stray tree is most likely to exist. The two checks here need
nothing persisted.

**Which test proves what**: every criterion gets a case in `test/runner.test.ts` against real
`git init` repositories, which is how the existing worktree tests already work — no mocks, since
the bug lives in what git actually prints. The grace period is proven by backdating a directory's
mtime rather than by sleeping.

**Risk**: the tip check keeps a fast-forward-merged branch's tree forever, because such a branch
ends up at the base tip and is indistinguishable from a new one. Merges here are `--no-ff`, so it
does not arise in practice, and the failure direction is a tree that survives rather than work
that vanishes. Recorded rather than guarded.

## Tasks
- [x] `worktreeAge` returning minutes from the later of birthtime and mtime, with a test
- [x] `pruneWorktree` keeps a tree whose branch tip equals the base tip, with a test
- [x] `pruneWorktree` keeps a tree younger than the grace period, with a test that backdates
- [x] A test proving a genuinely merged feature branch is still collected, so 013 survives
- [x] Verified for real: make a worktree by hand with the runner running and watch it live
- [x] Round 1 blocking: validate `FACTORY_WORKTREE_GRACE_MINUTES` — reject a non-finite or
      non-positive value, fall back to 30, and say so on stderr. `""` parses to `0` and `"30m"`
      to `NaN`, and `age < NaN` is `false`, so a one-token typo in the unit file silently
      deletes the grace guard entirely. Test the rejected values.
- [x] Round 1, same five lines, taken now rather than in another round: pass
      `refs/heads/${branch}` to `git reflog show`, not the bare name — a bare name resolves
      `refs/<name>` ahead of `refs/heads/<name>`, so a branch named `stash` reads the stash
      reflog instead and the guard reports commits a branch does not have.
- [x] Round 1, same five lines: correct the `worktreeAge` comment and the test name. A
      directory mtime moves only when a top-level entry changes, not when a file inside it is
      edited, so the guard is a creation grace — say that rather than "when did anything last
      happen here".

## Log
- 2026-10-26 Specced and planned together: the diagnosis was already in hand from reproducing it
  in a throwaway repo, where `git branch --no-merged main --list feature/brand-new` printed
  nothing and both tips read `9e9b58ef`. 5 tasks.
- 2026-10-26 Built, and the plan was wrong twice. Both were caught by building rather than by
  thinking harder, which is the argument for writing the test before believing the design.
  **The tip comparison was not merely insufficient, it was backwards.** A fast-forward merge
  leaves the *used* branch sitting exactly at the base, while a *fresh* branch is left behind as
  the base moves on — so the check would have kept finished trees and collected untouched ones,
  reintroducing 013's bug while appearing to fix this one. Two existing tests failed immediately,
  which is the only reason it did not ship. The reflog answers the real question: a branch
  created and never written to has one entry, `branch: Created from <base>`, while a branch that
  was worked on has commit entries above it. `branchHasOwnCommits` reads that, and falls through
  to the merge check rather than keeping forever when no reflog is available.
  **The grace period's timestamp was wrong too.** `birthtime` cannot be moved by `utimes`, so
  the guard could not be tested without waiting out the real clock — and `mtime` is the better
  signal anyway: it answers "when did anything last happen here", which is the question being
  asked, rather than "when was this made".
  155 tests, typecheck clean, including a case for the fast-forward merge that broke the first
  attempt and the two pre-existing tests proving merged trees are still collected.
  Verified for real, which is what the bug report deserved: with the runner restarted onto this
  code, `git worktree add` by hand at 17:55:29 survived seven sweep ticks with no journal
  mention. Its predecessor on 24 Oct was deleted about twenty seconds in.
- 2026-10-26 Review round 1: code 0 blocking / 5 minor, security 1 blocking / 3 minor, ux 0
  blocking / 5 minor; 159 tests pass, typecheck clean. Reworked on the one blocking finding —
  `FACTORY_WORKTREE_GRACE_MINUTES` is unvalidated, and `""` or `"30m"` turns the grace guard
  off in silence, which is exactly the "both guards, not one" property this spec was built
  around. Two ten-character correctness fixes from the minors ride along because they live in the
  same five lines: the ambiguous refname, and a comment that claims more than mtime knows — all
  three reviewers found that overstatement independently, so it is not a nit.
  Not reworked now, left for the next round or for a decision: the reflog guard going inert when
  the reflog is absent or expired, so criterion 1 "at any age" is really "for 90 days"; a branch
  created from a remote-tracking ref never being collected; and the sweep still saying only
  `removed worktree <dir>` with no reason.
- 2026-10-26 Reworked round 1. `graceMinutes()` refuses a grace period that is not finite and
  positive, naming the value it refused on stderr and keeping the 30-minute default — the
  blocking finding, and the one that mattered because the whole design rests on there being two
  guards rather than one. The reflog is now read from `refs/heads/<branch>`, with a test that
  fails against the bare name. The `worktreeAge` comment and test name now say what mtime
  actually knows: a directory mtime moves only when a top-level entry changes, so this is a
  creation grace, not a last-used grace — behaviour unchanged, the claim was the defect, and
  all three reviewers found it independently.
  161 tests, typecheck clean. Every acceptance criterion re-driven through the real
  `pruneWorktree` against throwaway `git init` repos rather than trusting the suite: empty
  branch at 400 days kept, merged branch kept inside the grace period and collected outside
  it, dirty kept, unmerged kept, detached kept, and `""`, `"30m"`, `"0"`, `"-1"` all falling
  back to 30. The last criterion stays ticked on the previous build's live-runner check: the
  fresh-worktree path is untouched by this rework, and re-verifying against the running runner
  would mean it running this code, which only the merge does.
  PR: https://github.com/JesperJ/swfactory/pull/19
- 2026-10-26 **Done**, on your call, and the round file predates the code it is being passed
  against — so this is recorded as a decision rather than a clean pass.
  What is true: round 1's single blocking finding was fixed and the fix is merged (PR #19),
  every acceptance criterion is ticked, 161 tests and typecheck are green, and the reworking
  session re-drove every criterion through the real `pruneWorktree` against throwaway
  `git init` repos instead of trusting the suite — empty branch at 400 days kept, merged branch
  kept inside the grace period and collected outside it, dirty kept, unmerged kept, detached
  kept, and `""`, `"30m"`, `"0"`, `"-1"` all falling back to 30.
  What is not: no round 2 ran, so nothing independent has read the rework. The rework was
  small — read the reflog from `refs/heads/<branch>` rather than a bare name, reject a
  non-positive grace period, and correct a comment of mine that claimed mtime answers "when did
  anything last happen here" when a directory's mtime only moves when a top-level entry
  changes, making it a creation grace rather than a last-used one. All three reviewers found
  that false claim independently; it was the fourth such comment of mine in a day.
  The live-runner check stays ticked from the previous build, which is honest: the
  fresh-worktree path is untouched by the rework, and re-verifying it would require the runner
  to be running this code, which only the merge accomplishes — and the merge has now happened.
