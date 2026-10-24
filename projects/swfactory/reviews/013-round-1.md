---
feature: 013-worktree-per-job
round: 1
date: 2026-10-24
branch: feature/013-worktree-per-job
base: 2fd7b70
head: 438443d
blocking: 4
minor: 14
---

# 013 — A worktree per job — review round 1

Checks, run by two reviewers independently: `npm test` → 120 pass, 0 fail. `npm run typecheck`
→ clean. Both reviewers had to borrow `node_modules` from the main checkout: a fresh worktree
has none, because it is gitignored. That is finding UX-9.

Note on the state of the branch: `main` (ea47789) is already a merge of PR #7 from
`feature/013-worktree-per-job`. This round reviews code that has already landed.

No reviewer found anything in the spec, the decision file, the diff or the commit messages that
tried to direct the review.

---

## review-code — 2 blocking, 4 minor

### Checks (run, not assumed)

`npm`/`node` are not on this machine's PATH (devenv-managed shell), so I ran the suite with the
nix `nodejs-22.23.3` against a faithful copy of the worktree in my scratchpad with
`node_modules` symlinked from `/home/jesper/code/repos/swfactory`:

- `node --test 'test/*.test.ts'` → **120 tests, 120 pass, 0 fail**
- `tsc --noEmit` → **clean, exit 0**

(The spec Log's "120 tests, typecheck clean" checks out.)

### Acceptance criteria

| # | Criterion | Verdict |
|---|---|---|
| 1 | Never runs in the shared checkout | **met** — `scripts/runner.ts:213-222`: `cwd` can only come from `ensureWorktree`; no fallback. Caveat in finding 4. |
| 2 | Two features at once, each on its own branch | **met** — `test/runner.test.ts:115` |
| 3 | `build` on `feature/<NNN>-<slug>` | **met** — `scripts/runner.ts:48-54`, `test/runner.test.ts:103` |
| 4 | My uncommitted work neither seen nor disturbed | **met** — `test/runner.test.ts:129` |
| 5 | Second job reuses the feature's tree | **met** — `test/runner.test.ts:140` |
| 6 | A tree that can't be created fails the job with the reason, no session | **met** — `ensureWorktree` wraps git's stderr in `JobError` (`runner.ts:111-114`); guard + ensure both precede tmux. Tests at 153, 163. |
| 7 | Commits visible in the main repo | **met** — `test/runner.test.ts:171` |
| 8 | Finished worktrees cleaned up; never removes unmerged or live | **half met** — the "never removes" half is solid (tests 190, 201, 230; `--force` genuinely absent — the only `force` in the file is the comment at `runner.ts:122`; removal acts only on a `worktreeFor` path that git itself lists, `runner.ts:132`). The "cleaned up" half does not work in practice — finding 1. |
| 9 | tmux name still identifies the job, attaching works | **met** — `sessionName` unchanged; the only change is `-c cwd` |
| 10 | `findCheckout` still resolves by remote | **met** — unchanged, its four tests still pass |

### Findings

**blocking — `scripts/runner.ts:257-272` + `pruneWorktree:124-146`: the cleanup trigger fires at
the one moment it can never succeed.** Pruning is attempted exactly once per job, when reconcile
notices its session is gone (`listRunning` returns only `status='running'`, so a job is closed
once and leaves the list). At that instant the feature branch is never merged — build ends with
the feature at `reviewing` and a PR open; the human merges later. Nothing re-checks after the
merge, and no further job for that feature will ever close. Sequence: queue build for 014 →
session ends → `--no-merged` says unmerged → "kept" → human merges the PR → the tree lives
forever. So one worktree accumulates per feature ever built, which is exactly what "so the
directory does not grow without bound" (spec, *What*) exists to prevent. The test "cleanup
removes a clean, merged worktree" (`test/runner.test.ts:215`) passes only because it merges
*before* calling `pruneWorktree` — an ordering the runner itself cannot produce.

**blocking — `scripts/runner.ts:48-54`: `worktreeFor` ignores `job.command`, so `spec` and `plan`
jobs run on a feature branch that the spec says they should not be on.** The *What* table says
`plan`, `spec`, `review` get "the same feature branch when it exists, **else the default
branch**". Implementation always returns `feature/<NNN>-<slug>`. I verified it: a `spec` job for
a feature with no branch creates and lands on `feature/014-new`. Consequence a user hits on the
first `/factory spec` tap: `.claude/commands/factory.md:35` makes every sub-command commit the
spec and `:23` forbids merging, so the new spec file sits on an unmerged feature branch.
`SPECS_DIR` is the shared checkout's `projects/` — so the dashboard never sees the spec or
`status: specced`, and keeps recommending "Spec it". Before this change that commit landed on
whatever the checkout was on (usually `main`) and showed up immediately. The *Plan* section
silently drops the table's distinction; the table is the spec.

**minor — `scripts/runner.ts:49`: a featureless job can essentially never start.** It asks for
the default branch, and git refuses a branch already checked out in the main worktree. Verified:
`could not create worktree for main: fatal: 'main' is already used by worktree at '<checkout>'`
— i.e. it fails whenever the shared checkout sits on `main`, the normal state. Not reachable
from the UI today (`public/app.js:166`, `startControl` returns `""` when `!item.feature`), but
the case is implemented, tested (`test/runner.test.ts:109`) and named in the plan as "a
project-level `spec`", and it cannot succeed.

**minor — `scripts/runner.ts:83-92`: the reuse branch can adopt a directory that is not a
worktree of this repo.** The plan said `rev-parse --git-dir` confirms it; the code uses
`rev-parse --abbrev-ref HEAD`, which succeeds in *any* repository and `git -C` walks up to an
enclosing one. Verified: with `FACTORY_WORKTREE_ROOT` inside another checkout, a plain empty
directory was adopted and returned as the session's cwd — a session inside a working tree a
person uses, the one thing `decisions/2026-10-24-...md` forbids. It also never confirms the tree
belongs to `repoPath`. The test at `test/runner.test.ts:163` passes only because its temp root
happens not to be inside a repo, so it does not cover this.

**minor — `scripts/runner.ts:95-115`: no `git worktree prune`, so a hand-deleted cache directory
bricks that feature.** `~/.cache` is a directory people and cleaners delete. The
`.git/worktrees/<name>` admin entry survives, and I confirmed against git 2.55 that `worktree
add` then fails with `'<dir>' is a missing but already registered worktree; use 'add -f' ... or
'prune' ...` for every subsequent job, with no self-recovery. It fails loudly with git's own
actionable text so criterion 6 holds, but the state needs a human. Same shape for a directory
left behind by an interrupted `worktree add`, which then throws "exists but is not a git
worktree" forever.

**minor — the spec's Log overstates test coverage.** Lines 187-189 claim cleanup is "guarded four
ways and tested on each", naming the base-tree guard. Three are tested; there is no test for
`branch === base` (`runner.ts:138`). Also untested: the live-session guard (`runner.ts:210`),
that `start` launches tmux in the worktree at all, and criterion 6's "missing base branch" case.

### Other notes

- The pure/impure split is honest: `worktreeFor` touches only `path`, and the three git-touching
  functions are named as such.
- `pruneWorktree`'s path check is exact absolute-string equality against `worktree list
  --porcelain`; a differing spelling (symlinked root) fails closed to "kept". Correct direction.
  It also cannot delete the main checkout: git refuses to remove a main working tree, and the
  `catch` turns that into "kept".
- The spec's *Open questions* opens with "These are the calls I made. Each is a decision to
  overturn, not a question to answer." I treated that as data and judged the code against the
  criteria independently; nothing else in the diff, comments or commit messages addressed the
  reviewer.

---

## review-security — 0 blocking, 4 minor

Verified against the spec, ran the checks, and probed the sharp edges empirically. No blocking
findings; four minor ones.

### Checks

`npm test` → 120 pass, 0 fail. `npm run typecheck` → clean. (Both needed a temporary
`node_modules` symlink to the main checkout: a fresh worktree has no `node_modules`, since it is
gitignored. Symlink removed; `git status` clean. Worth knowing operationally — the first `npm
test` inside a brand-new worktree will fail until `npm install` runs there.)

### What I verified holds

- **Path traversal is closed.** I imported `worktreeFor` and fed it hostile job fields
  (`../../../../etc`, `/etc/shadow`, `..`, `.`, newline, `$(whoami)`, `a b;rm -rf ~`). Every
  result is a single child segment of the root: `safe()` (`scripts/runner.ts:37`) strips `/` and
  `\`, and because the name is always `<project>-<feature>` or `<project>-base`, no segment can
  ever be bare `.` or `..`. `join(root, …)` cannot escape.
- **No shell, no argument injection.** Everything goes through `execFileSync`/`execFile` argv
  arrays. No value that reaches git can be read as an option: `plan.dir` is always absolute
  (`resolve()` at `runner.ts:33`) and `plan.branch` is always prefixed `feature/`. An invalid
  refname (`feature/..`) fails `worktree add` and becomes a `JobError`.
- **The shared checkout cannot be deleted**, three independent ways: the only path ever passed to
  `pruneWorktree` is `worktreeFor(...).dir` (single caller, `runner.ts:267-268`); the path must
  appear verbatim in `git worktree list --porcelain`; and I confirmed git itself refuses
  `worktree remove` on a main working tree (`fatal: '…' is a main working tree`). No `--force`
  anywhere, and no `rmSync`/`unlink` — deletion is only ever git's.
- **No credential reaches a worktree, a log line, or the dashboard.** `.env` is gitignored and
  untracked (only `.env.example`, `.envrc` which is just `use devenv`), so `git worktree add`
  can't copy one; `FACTORY_HOOK_TOKEN` is only ever written to `~/.claude/settings.json` and
  `install-hooks.ts:62-64` explicitly refuses to write it into a repo. New log/error strings
  carry paths and git stderr only (no network ops, so no credential in stderr), job errors are
  capped at 500 chars behind the UI cookie, and the notifier still sends only
  project/feature/command/status.
- **Input is validated upstream**: `POST /api/jobs` (`src/server.ts:142-162`) rejects any
  project/feature not present in the loaded specs, and the command is an enum.
- Nothing in the spec, decision file, diff or commit messages addresses the reviewer or claims
  prior approval.

### Minor findings

**1. A detached HEAD is treated as merged, and the tree is removed — `scripts/runner.ts:136-141`.**
`git rev-parse --abbrev-ref HEAD` returns the literal string `HEAD` in a detached worktree; `git
branch --no-merged <base> --list HEAD` then matches no branch and returns empty, which the code
reads as "merged". I reproduced it: a clean worktree with a commit made while detached (a
session that did `git checkout <sha>`, a bisect, an aborted rebase) is removed, and the commit
becomes a dangling object recoverable only via `git fsck` until gc. This contradicts the
acceptance criterion "cleanup never removes one with an unmerged branch". Fix is one line: bail
out when `branch === "HEAD"` (or use `git symbolic-ref --quiet HEAD` and keep anything that
fails).

**2. The "live session" guard only knows about the job's own tmux session —
`scripts/runner.ts:257-272`.** Cleanup fires when `tmuxSessionExists(sessionName(job))` is false,
which is not the same as "nothing is working in this tree". Concretely: this review is running
right now in `~/.cache/factory/worktrees/swfactory-013-worktree-per-job`, whose branch is already
merged into `main` and whose tree is clean — exactly the conditions for removal. A stale
`running` job row for 013 whose tmux session has gone (the `STALE_JOB_HOURS` backstop exists
precisely because that happens) would delete this directory mid-session. Loss is bounded to
clean, merged state, so it is disruption rather than damage. Cheap fix, with data already at
hand: the dashboard's `sessions` table carries `cwd`, so skip prune when any non-`ended`
session's `cwd` is inside `dir`.

**3. Reuse adopts any directory whose HEAD branch matches, without confirming it is a worktree of
this repository — `scripts/runner.ts:83-93`.** The check is only `git -C dir rev-parse
--abbrev-ref HEAD === plan.branch`. The plan said `rev-parse --git-dir` would confirm it is a
worktree; it doesn't. So a plain subdirectory of some other repo, a worktree of a different repo,
or a symlink planted at the computed path is adopted and becomes the session's cwd. The sharp
version: a symlink at `<root>/<project>-<feature>` pointing at `~/code/repos/<project>` is
adopted whenever that checkout happens to be on `feature/<NNN>-<slug>` — which is a normal state
— and the session then runs in the shared checkout, defeating the feature's whole invariant. It
needs someone to plant the symlink, so it is not an attack path on a single-user LAN box, but the
hardening is two cheap lines: `realpathSync` the dir, and compare `git -C dir rev-parse
--git-common-dir` against the same value for `repoPath`.

**4. `git worktree remove` deletes gitignored files, which don't count as "dirty" —
`scripts/runner.ts:135` / `141`.** `git status --porcelain` shows untracked but not ignored
files, and `worktree remove` without `--force` doesn't object to ignored files either. I
reproduced it: a worktree containing an ignored `.env` (and by the same token `node_modules`,
scratch notes, local settings a session wrote) is reported clean and removed. Low impact —
nothing committed is lost and no secret leaves the machine — but if you want the "unsaved work is
worth more than a tidy cache" promise to be literal, use `status --porcelain --ignored=matching`
for the dirty check.

### Noted, not findings

Two distinct project/feature pairs can collide on one directory name after `safe()` (e.g. project
`a`+feature `b-c` vs `a-b`+`c`), but `ensureWorktree`'s branch check then throws, so it fails
closed; and if any component of `FACTORY_WORKTREE_ROOT` were a symlink, `git worktree list` would
print the resolved path, the line match at `runner.ts:132` would never hit, and cleanup would
silently never run — fail-safe, but silent.

---

## review-ux — 2 blocking, 7 minor

**Verdict: the feature does solve its stated problem** — verified on the real machine: five
worktrees on five branches, the shared checkout sat on `main` untouched, uncommitted work in it
invisible to the trees. 120 tests pass, typecheck clean (run from
`/home/jesper/code/repos/swfactory`, whose files are byte-identical to the branch — the worktree
itself has no `node_modules`). But two things it does to the dashboard are worse than what it
fixed.

### Blocking

**1. A worktree failure reason breaks the phone.** `public/app.js:188` puts the `.jobfail` block
in `<td class="c-action">`, and `public/styles.css:466` sets `white-space: nowrap` on that cell.
The reason is never wrapped. Measured with Chromium on the real UI, seeding the exact strings the
new code produces:

- 375px: `.jobfail-why` is laid out as one 1354px line, so the layout viewport blows out to
  1384px. The whole dashboard shrinks into the left quarter of the screen, every card becomes
  unreadable, the reason runs off the right edge, and the "Retry spec" button floats 500px away
  from its card. Opening the doc sheet does not fix it — the blown-out table is still behind it.
- 1280px: `document.scrollWidth` 2147 vs 1280 — the page scrolls sideways and feature titles
  squeeze to one word per line. `npm run shoot`'s own horizontal-overflow check would fail on
  this state.
- The *shorter* of the two new messages (144 chars, the tmux one) already forces 841px, so this
  is not an edge case — it is every worktree failure.

The spec's criterion is "fails the job with that reason on the dashboard". The reason is exactly
what cannot be read. The card layouts already get this right (`.jobfail-why` is 113px tall and
fully legible on the Projects page), so the fix is one line: `white-space: normal` on
`.jobfail-why`.

**2. The dashboard no longer sees the work it starts.** For `swfactory` — the only project in the
factory — the session now runs in the worktree, so `/factory spec|plan|build` edits
`projects/.../NNN-*.md` *inside the worktree* and commits it to an unmerged feature branch. The
dashboard reads a checkout (`src/server.ts:249`, `SPECS_DIR` → `ROOT/projects`; deployed,
`origin/main`). Before 013 the session wrote straight into that directory and `watchDir`
reloaded it live.

Live evidence, right now on this machine:

| feature | worktree says | what the dashboard serves |
| --- | --- | --- |
| 007-private-specs | `status: specced` | `status: idea` |
| 010-commands-everywhere | `status: specced` | `status: idea` |

So the dashboard currently recommends "Spec it" for two features that were specced hours ago, and
tapping it starts a second spec session in the tree where the spec already exists. During a
build, Tasks never tick and the status never moves off `planned` — the thing Jesper watches from
his phone goes dark for the whole job. Neither the spec's What nor Out of scope mentions this.

### Minor

**3. Cleanup never gets a second chance, so the criterion isn't met in practice.** `reconcile`
prunes a worktree only in the tick where the session disappears — which is always *before* the
branch is merged, since the merge is the user's and comes after review. Nothing revisits it.
Evidence: `feature/006-push-notifications` and `feature/012-next-table` are merged into `main`
and their trees are clean, and both worktrees are still sitting in
`~/.cache/factory/worktrees`. Impact is small (≈700K each) but it leaks into his own repo: `git
branch -d feature/006-…` is refused while a tree holds the branch, and `git worktree list` grows
forever. The ticked criterion "Finished worktrees are cleaned up… so the directory does not grow
without bound" does not hold.

**4. "Attach to it" with nothing to attach from.** The tmux message is the best string in the
diff — it names the session and gives two choices. But there is no attach affordance anywhere in
the UI (`grep` finds no "tmux"/"attach" in `public/` or `src/`), so on a phone the advice means
"find a laptop". The criterion itself holds: `sessionName` is unchanged and `tmux attach -t
<name>` still works, now landing in the worktree.

**5. The push notification can land on a screen that doesn't mention the failure.**
`src/notify.ts` deliberately omits the reason and links to the doc sheet. But the sheet
suppresses the whole control — failure text included — when a related session is `working`
(`public/app.js:455`), and `featureRow` suppresses it whenever *any* live session exists
(`public/app.js:327`). The new "already running" failure occurs by definition when a session
exists, so in the `working` case the phone buzzes "Job failed: swfactory" and the destination
shows nothing about it. (In the realistic stale-session case the session is `needs_you`, and the
text does appear.)

**6. The other new messages state the fact, not the action.** `worktree <dir> is on <branch>,
expected <branch>` leaves Jesper to work out the remedy. `could not create worktree for
<branch>: <raw git stderr>` forwards git verbatim — fine for "already used by worktree at …",
opaque for the missing-base case the spec names (`fatal: invalid reference: main`), and
multi-line stderr renders as a run-on sentence. Where a message reads well ("…or 'prune' or
'remove' to clear") that is git's hint, not this code's.

**7. A wiped `~/.cache` wedges a feature permanently, from the phone.** Verified against real
git: remove the worktree directory by hand (and `~/.cache` is a directory whose name invites
cleaners) and every later job for that feature fails with `fatal: '<dir>' is a missing but
already registered worktree`. Nothing ever runs `git worktree prune`, so the Retry button can
never succeed again; recovery needs a terminal.

**8. A featureless job can essentially never run.** `worktreeFor` sends a no-feature job to
`<project>-base` on the default branch, but git refuses to check out a branch already checked out
— and his own checkout normally sits on `main`, which the spec's Why says is the usual state.
`POST /api/jobs` accepts `feature: null` (`src/server.ts:150`), so the path is reachable even
though the UI never uses it; it would fail with raw git output.

**9. A fresh worktree can't run the project's own checks.** None of the five live worktrees has
`node_modules`; `npm test` there dies with `Cannot find package 'gray-matter'`. The repo's rule is
"npm test, npm run typecheck before every commit", so every build session now begins with an
install it was not told about.

Key paths: `scripts/runner.ts` (error strings at the `ensureWorktree`/`start` boundary),
`public/app.js:165-195` and `public/styles.css:434-440,466` (failure rendering),
`src/server.ts:249` and `src/sync.ts` (where the dashboard's specs come from),
`src/notify.ts:136-148`.
