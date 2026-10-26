# 016 — The sweep stops eating worktrees that were never used — review round 1

- Date: 2026-10-26
- Branch: `feature/016-worktree-sweep`, base `main` (already merged as PR #17)
- Diff reviewed: `git diff da056bd c607522 -- scripts/runner.ts test/runner.test.ts`
- Checks, run by all three reviewers: `npm test` → **159 tests, 159 pass**; `npm run typecheck` → clean.
- Counts: **code 0 blocking / 5 minor · security 1 blocking / 3 minor · ux 0 blocking / 5 minor**

---

## review-code

### Checks run

`export PATH="/home/jesper/code/repos/swfactory/.devenv/profile/bin:$PATH"` then, in
`/home/jesper/.cache/factory/worktrees/swfactory-base`:

- `npm test` → **159 tests, 159 pass, 0 fail** (duration 676 ms). The four new sweep tests pass.
- `npm run typecheck` → `tsc --noEmit`, **clean, no output**.

Everything below the criteria table I verified by driving the real exported functions
(`pruneWorktree`, `branchHasOwnCommits`, `worktreeAge`) against throwaway `git init` repos, plus
`git version 2.55.0` probes of reflog behaviour and `stat`/`touch` probes of directory mtime
semantics. One structural point in the implementation's favour, stated up front: **both new
checks only add early `return "kept"` paths**, so no input that was kept before 016 can now be
removed. This diff is monotonically less destructive than the code it replaces — which is the
right shape for the only code in the factory that deletes a directory outside the repo.

### Acceptance criteria

1. **A worktree on a branch with no commits of its own is not collected, at any age** — **met**
   in git's default configuration. `test/runner.test.ts:452` backdates the tree a full day and
   still gets `kept`, and I reproduced it independently. **Not met when the branch's reflog is
   unavailable** — see finding 1, where I watched a never-touched worktree get deleted.
2. **A worktree created within the grace period is not collected, even if its branch looks
   merged** — **met**. `test/runner.test.ts:472` merges `--no-ff` and still gets `kept` seconds
   after creation; `backdate` then flips it to `removed`. Caveat in finding 2 (the guard can be
   switched off by an env typo, silently).
3. **A worktree whose branch has commits merged into the base is still collected** — **met**.
   `test/runner.test.ts:224`, `:260` and the new `:489` (fast-forward) all end in `removed`, and
   all three pass. One real exception in finding 3.
4. **A worktree with uncommitted changes is still kept** — **met**. `scripts/runner.ts:214` runs
   `status --porcelain` before either new guard, so `test/runner.test.ts:199` still exercises
   exactly the check it names.
5. **A worktree on an unmerged branch is still kept** — **met as behaviour**: I drove
   `pruneWorktree` on an unmerged branch with the directory backdated 600 minutes and got `kept`;
   `test/runner.test.ts:269-275` also covers old-and-unmerged. But the test *named* for this rule
   no longer reaches the merge check — finding 4.
6. **The base tree and a detached tree are still kept** — **met**. `branch === base` and
   `branch === "HEAD"` at `scripts/runner.ts:217-219` both precede the new guards, so
   `test/runner.test.ts:318` is unaffected.
7. **Each rule has a test against a real git repository, not a mock** — **met**. Every new case
   builds a real repo with `git init` / `git worktree add`; the only non-repo test is
   `worktreeAge` on a plain `mkdtempSync` directory, which is correct for a function whose entire
   body is one `statSync`.
8. **Verified for real** — **not verifiable from the diff.** The Log's account is specific and
   internally consistent (17:55:29, seven ticks, no journal mention), and the hand-made directory
   is no longer on disk so I cannot inspect it. Corroborating circumstantially: the runner is
   live on this code (pid 3615538, started 19:41:53, no `FACTORY_WORKTREE_GRACE_MINUTES` in its
   environment, so grace = 30), and `~/.cache/factory/worktrees/swfactory-007-private-specs` from
   24 Oct is still there after 3505 minutes — kept legitimately, for the right reason
   (`feature/007-private-specs` is clean and genuinely unmerged).

### Findings

**1. minor — `scripts/runner.ts:198`: when a branch has no reflog, the reported bug comes
straight back, and both guards are silent at once.**
`git reflog show <branch> --format=%gs` on a branch whose reflog is absent or expired exits
**0 with empty stdout** (verified on git 2.55.0 — both for `core.logAllRefUpdates=false` and
after `git reflog expire --expire=now --all`), so control reaches `if (lines.length === 0) return
true`, the empty branch is declared to have own commits, and the `--no-merged` check — which
prints nothing for an empty branch — collects it. I ran this against the real function: fresh
`git worktree add -b feature/016-new`, `git reflog expire --expire=now --expire-unreachable=now
--all`, mtime backdated one hour → `branchHasOwnCommits` returned `true`, `pruneWorktree`
returned `removed`, directory gone. That is the exact failure in the Why section, on a branch
that was never written to. The grace period does not save it, because past 30 minutes there is no
second guard left — which is precisely the "both guards, not one" property the spec bought and
the Log says 015 paid for twice. The comment at `:196-197` shows the fall-through is deliberate
and argues "nothing to read is not evidence of nothing happening"; that reasoning is sound for a
branch that *was* worked on, but it also hands the untouched case back to the check that cannot
tell the two apart. Realistic triggers: an explicit `git reflog expire --all` (routine after a
history rewrite), a repo with `core.logAllRefUpdates` off, or the default 90-day
`gc.reflogExpire` eating the lone `branch: Created from` entry of a long-lived empty branch. What
is lost is bounded — the tree is clean and the branch has no commits, so only gitignored content
(`node_modules`, `.env`, local scratch files) goes with it — but the criterion's words are "at
any age", and in this configuration no age is safe.

**2. minor — `scripts/runner.ts:161`: a malformed `FACTORY_WORKTREE_GRACE_MINUTES` removes the
grace guard entirely, with no error and no log line.**
`Number(process.env.FACTORY_WORKTREE_GRACE_MINUTES ?? 30)` yields `NaN` for `"30m"` or
`"half an hour"` and `0` for `""`; `worktreeAge(dir) < NaN` is `false`, so `:226` never returns
and the only remaining protection is the reflog check. Driven for real on a seconds-old, merged,
clean worktree: unset → `kept`; `"30"` → `kept`; `""` → `removed`; `"30m"` → `removed`; `"-5"` →
`removed`. A blank `Environment=FACTORY_WORKTREE_GRACE_MINUTES=` line in the systemd unit, or
minutes written with a unit suffix, therefore silently returns the sweep to its pre-016
aggressiveness on the merged path. The same `Number("")` pattern on `FACTORY_SESSION_IDLE_HOURS`
was already carried as an open finding in `projects/swfactory/reviews/015-round-2.md:208`; there
it at least fails closed because the endpoint 400s and the runner complains every 10 s. Here
nothing complains. It also compounds with `worktreeAge`'s `return 0` error path (`:174`): with
grace parsed as `0` or `NaN`, "I cannot stat this directory" stops meaning "leave it alone". The
live runner does not set the variable, so this is latent rather than active.

**3. minor — `scripts/runner.ts:199`: `branchHasOwnCommits` measures "was this branch's ref ever
moved locally", not "does this branch have commits", so a branch created from a remote-tracking
ref is never collected.**
`git checkout -b feature/001-a origin/feature/001-a` (or `git worktree add -b feature/001-a <dir>
origin/feature/001-a`) writes one reflog entry, `branch: Created from origin/feature/001-a`,
which matches the regex. Verified end to end: a branch with a real commit fetched from a remote,
then merged `--no-ff` into main, tree clean and backdated 600 minutes → `branchHasOwnCommits`
returned `false` and `pruneWorktree` returned `kept`. That tree is now never collectable, however
long it sits, which is 013's purpose quietly lost for exactly the trees a human made by hand to
resume pushed work. The direction is the safe one and the spec's Risk section already accepts "a
tree that survives" as the preferred failure, but the function's name and its docstring question
("Has anything ever been committed on this branch") promise something stronger than the
implementation delivers, and `ensureWorktree`'s own adoption path (`worktree add <dir> <branch>`
for an existing branch, `scripts/runner.ts:137`) adds no reflog entry of its own, so whatever
created the branch decides the answer forever.

**4. minor — `test/runner.test.ts:210`: "cleanup keeps a worktree whose branch is not merged" no
longer reaches the merge check it is named for.**
The tree is created seconds before the assertion, so `pruneWorktree` now returns at the grace
period (`scripts/runner.ts:226`) and `git branch --no-merged` is never run. The test passes, and
its message still reads "unmerged work must survive", but it would now pass just as well if the
`--no-merged` check were deleted. The behaviour itself is fine — I confirmed old-and-unmerged
still returns `kept`, and `:269-275` does exercise the path after its added `backdate` — so this
is coverage that silently moved, not a behaviour regression. Worth noting because the other
merged-path tests in the same file did get `backdate` calls added for exactly this reason
(`:235`, `:272`, `:277`), and this one was left as the odd case out.

**5. minor — `scripts/runner.ts:163-169` and `test/runner.test.ts:507`: the comment and the test
name claim mtime answers "when did anything last happen here"; it does not.**
A directory's mtime changes only when a top-level entry is created, removed or renamed. Verified
twice: appending to an existing top-level file and creating a file in a subdirectory both left
the backdated mtime untouched, and in a real worktree backdated three hours, editing `src/a.txt`,
`git add`, `git commit` and `git status` left it reading 180 minutes old. So the comment's
example — "a tree created months ago but written to a minute ago should be kept, and mtime says
so" — is false for the ordinary way anyone works in a checkout. What the guard actually provides
is a creation grace, which is enough for criterion 2 and for the bug report, but not the in-use
protection the comment advertises: a tree somebody has been editing for three hours, whose branch
has just been merged, is collectable immediately with no grace at all. The test at `:507` asserts
only that `utimesSync` on the directory itself is read back, so it never tests the property its
name states. Since the Log presents this as a deliberate improvement on the planned birthtime,
the next person to reason about this path will take the comment at its word.

Nothing blocking. The feature does what the spec set out to do in the configuration it actually
runs in, the fast-forward trap that broke the first attempt is now pinned by a test
(`test/runner.test.ts:489`), and the two pre-existing merged-collection tests still prove 013
survives.

---

## review-security

Checks: `npm test` 159/159 pass, `npm run typecheck` clean (with
`/home/jesper/code/repos/swfactory/.devenv/profile/bin` on PATH).

### 1. blocking — `FACTORY_WORKTREE_GRACE_MINUTES` is unvalidated, and a malformed value silently removes one of the two guards

`scripts/runner.ts:161`

```ts
const WORKTREE_GRACE_MINUTES = Number(process.env.FACTORY_WORKTREE_GRACE_MINUTES ?? 30);
```

`??` catches only `undefined`/`null`, and nothing downstream checks the result.
`worktreeAge(dir) < NaN` is `false`, so a garbage value does not fail closed — it turns the guard
off completely and silently. Proven against the real `pruneWorktree` with a brand-new,
never-committed-to worktree:

| env value | parsed | result |
| --- | --- | --- |
| unset | 30 | kept |
| `"30"` | 30 | kept |
| `""` (set but empty) | 0 | **removed** |
| `"30m"` | NaN | **removed** |
| `"0"` | 0 | **removed** |
| `"-1"` | -1 | **removed** |

`""` and `"30m"` are the plausible accidents: an `Environment=FACTORY_WORKTREE_GRACE_MINUTES=`
line in a systemd unit, or someone writing the value the way every other tool spells a duration.
Neither produces an error, a log line, or any other signal — the only symptom is the original bug
coming back.

Two things make this blocking rather than a nit. First, the spec's own argument for the design is
*"Both guards, not one… a mistake in either still leaves the other, which is the lesson 015 paid
for twice"* — and this is a one-token typo that removes a guard on the only code in the factory
that deletes a directory outside the repository. Second, the project already has the fix pattern
for exactly this class of value, on exactly this kind of destructive input: `src/server.ts:215`
does `if (!Number.isFinite(hours) || hours < MIN_IDLE_HOURS)` before an answer that
*"authorises destroying a process"*, and `projects/swfactory/reviews/015-round-2.md:208` carries
`FACTORY_SESSION_IDLE_HOURS=""` as an unfixed finding of the same shape. Unlike that one, this
variable has no endpoint behind it to 400 and fail closed — there is nothing downstream at all.

Fix is one line: clamp to a finite positive number and fall back to 30, e.g.
`const g = Number(process.env.FACTORY_WORKTREE_GRACE_MINUTES ?? 30); const WORKTREE_GRACE_MINUTES
= Number.isFinite(g) && g > 0 ? g : 30;` — ideally with a `console.error` when the value was
rejected, since a silently-ignored setting is its own trap. Cost is trivially below the risk.

### 2. minor — the reflog guard is inert whenever the reflog is absent or expired, which is what makes finding 1 bite

`scripts/runner.ts:191-200` (`branchHasOwnCommits`)

Both failure paths return `true` ("has commits"), which does not keep the tree — it falls
straight through to the pre-change `--no-merged` check, i.e. to the exact behaviour this feature
exists to fix. Two reachable ways to get there, both verified against real git:

- `core.logAllRefUpdates=false` → `git reflog show` returns nothing, `lines.length === 0`, guard
  inert. This is the config used in the probe above.
- **Reflog expiry.** `git reflog expire --expire=now refs/heads/feature/new` leaves `lines: 0` —
  the `branch: Created from main` entry is gone and the reflog is empty, not merely trimmed. The
  default `gc.reflogExpire` is 90 days and `gc --auto` runs it unattended, so a never-used
  worktree older than ~90 days loses this guard by the passage of time alone. That directly
  contradicts acceptance criterion 1, *"A worktree on a branch with no commits of its own is not
  collected, **at any age**"* — it is true for 90 days, not at any age.

On its own the harm is small (a clean, untouched, 90-day-old empty tree is collected, and the
grace period still covers the reported bug), which is why this is minor rather than blocking. It
matters because it is the other half of finding 1's chain: with the grace guard off by typo *and*
the reflog guard inert, the fresh worktree is deleted again with both of the spec's "two
independent guards" down. Worth at least recording in the spec's Risk section as the known
boundary of the reflog approach, next to the fast-forward risk already recorded there.

### 3. minor — `git reflog show` is passed an ambiguous shorthand refname

`scripts/runner.ts:194`

```ts
log = git(repoPath, ["reflog", "show", branch, "--format=%gs"]);
```

`branch` comes from `rev-parse --abbrev-ref HEAD`, so it is a bare branch name, and git resolves
bare names through the full disambiguation order — `refs/<name>` wins over `refs/heads/<name>`.
Verified: in a repo with a branch named `stash` and a stash entry,

```
$ git reflog show stash --format=%gs
warning: refname 'stash' is ambiguous.
On main: wip
$ git reflog show refs/heads/stash --format=%gs
branch: Created from main
```

The first reads the *stash* reflog, whose lines never match `/^branch: Created from /`, so the
guard returns "has commits" for a branch that has none. The trigger is contrived —
`pruneWorktree` runs against any directory under the worktree root, so it needs a hand-made
worktree on a branch named `stash` (the generated names are `feature/<safe(feature)>`, which
cannot collide this way). I checked the more plausible collision, a tag and a branch of the same
name, and git still picks the branch's reflog there, so that one is harmless. Reporting it only
because the fix is ten characters and strictly correct: pass `refs/heads/${branch}`.

### 4. minor — `worktreeAge` measures less than its comment claims

`scripts/runner.ts:163-176`

The comment says mtime *"answers the question actually being asked: when did anything last happen
here."* A directory's mtime changes when entries are added, removed or renamed in **that**
directory — not when a nested file is edited. A session editing `src/foo.ts` for an hour leaves
the worktree root's mtime untouched, so the tree ages out of the grace period while it is in
active use. The grace period is therefore "time since the top level changed", not "time since
anything happened".

Low harm and not a regression: reaching the removal still requires `status --porcelain` to be
empty and the branch to be merged, so nothing uncommitted is at stake, and the pre-change code
had no clock at all. But the comment overstates the guard, and the overstatement is load-bearing
for finding 1 — it reads as though mtime makes the grace period robust on its own. Either soften
the comment or stat the `.git` file / `index` instead, which git rewrites on every operation.

### Checked and clean

- **No path traversal and no escape from the worktree root.** `sweepWorktrees`
  (`scripts/runner.ts:576-589`) takes single names from `readdirSync`, so no `..` component can
  appear; and `pruneWorktree` acts only on a path that appears verbatim in
  `git worktree list --porcelain`. Verified that git prints resolved real paths there, so a
  symlink placed under the root (or a symlinked root) never matches the computed `dir` and the
  tree is kept — fail-closed, unchanged by this diff.
- **No argument injection via the branch name.** Verified git refuses to create a branch
  beginning with `-` (`fatal: '-x' is not a valid branch name`); `branch` is git's own
  `rev-parse` output, not dashboard input; and `worktreeFor`'s `safe()` strips everything outside
  `[\w.-]` from generated names.
- **`git worktree remove` is strictly harder to reach than before this change.** Both new guards
  can only return `"kept"`, neither widens an existing condition, and `--force` is still never
  passed; `worktreeAge`'s `catch` returns `0` (treat as new, keep).
- **No secrets, no new outbound data, no new routes or handlers.** Nothing new is written to a
  tracked file or logged; the new env var is not a credential; `test/runner.test.ts` adds only
  `utimesSync` backdating in `mkdtempSync` directories.
- **No reviewer-directed text in the diff.** The comments are long and self-critical about the
  plan being wrong twice, but they argue about git's behaviour, not about what I should conclude —
  no claims of prior approval or "do not flag".

---

## review-ux

Reviewed. Tests and typecheck are clean on this worktree: **159 tests pass, `tsc --noEmit`
silent**.

**Not applicable:** there is no UI surface in this diff — no phone/desktop width check, no
light/dark check, no `npm run shoot` run. `grep -rni worktree src public` returns nothing: the
dashboard does not know worktrees exist. The only user-facing surface is the systemd journal.

### It solves the stated problem

I verified the Why by hand rather than trusting the Log, running the exact command from the bug
report (`git worktree add -b feature/016-x <dir> main`) against a real repo and driving
`pruneWorktree` over it:

```
reflog of fresh branch: "branch: Created from main"
no-merged says: ""          (empty — this is what the old code deleted on)
hasOwnCommits: false
1) fresh by-hand tree       -> kept (alive)
2) same tree, 7 days old    -> kept (alive)
3) committed, unmerged, 7d  -> kept (alive)
4) merged, 0 min old        -> kept (alive)
5) merged, 7d old           -> removed (GONE)
```

That is exactly the promised behaviour, and 5) proves 013's purpose survives. Someone with the
reported problem is now better off: the directory lives, and the reflog guard means it lives
*without* depending on the clock, so the 30-minute number being a guess doesn't matter for the
reported case. Good, and the right call to put the reflog check ahead of the grace period rather
than relying on the timer.

### Findings

**minor — the grace clock does not measure what the code says it measures.** `scripts/runner.ts`,
the comment above `worktreeAge`: "the question actually being asked: when did anything last
happen here. A tree created months ago but written to a minute ago should be kept, and mtime says
so while a birth time does not." It does not say so. `statSync(dir).mtimeMs` is the mtime of the
*worktree root*, which only moves when an entry is added, removed or renamed directly in that
directory — not when a file inside it is edited. Verified:

```
age before edit: 10080 min; after editing src/a.txt: 10080 min
```

So the grace period is in practice "30 minutes from when the tree was created", not "30 minutes
since anyone touched it". It still covers the case the spec asked it to cover (just-made tree,
person about to type), so the behaviour is defensible — but the comment is a claim the code does
not know, and the next person to reason about this guard will reason from the comment. Either
narrow the comment to "when a top-level entry last changed" or stat something that actually
moves.

**minor — with reflogs off, the original bug comes back, just 30 minutes later instead of 20
seconds.** `branchHasOwnCommits` returns `true` when there is no reflog to read ("defer to the
checks below rather than keeping the tree for ever"), which is a deliberate and reasonable call —
but it means the first acceptance criterion, "A worktree on a branch with no commits of its own
is not collected, **at any age**", does not hold in that configuration. Verified with
`core.logAllRefUpdates=false`:

```
reflog disabled: hasOwnCommits: true
6) fresh tree, reflogs off, 0 min -> kept (alive)
7) fresh tree, reflogs off, 7d    -> removed (GONE, the old bug)
```

Reflogs are on by default in non-bare repos, and the same path is reached when a long-untouched
branch's reflog entry expires (`gc.reflogExpireUnreachable`, 30 days), where collecting an empty
tree is arguably what you want. So the impact is small and the direction is the mild one. What
makes it worth saying is the spec's own argument for two guards — "a mistake in either still
leaves the other" — because in this configuration there is only one guard left, and nothing
anywhere says so.

**minor — a person still cannot tell why a directory disappeared.** `scripts/runner.ts:584` is
the whole of the feedback: `console.log(`[runner] removed worktree ${dir}`)`. No reason, no age,
no branch. And a *kept* tree logs nothing at all, so the grace period and the reflog guard are
entirely unobservable — there is no way to confirm the fix is working on a live runner except by
watching a directory not vanish. The feature exists because a directory vanished inexplicably
mid-task and cost a detour; the vanishing is now rarer but just as mute. One line —
`removed worktree <dir> (feature/001-a merged into main, clean, 37m since last change)` — would
have turned the original incident from a mystery into a diagnosis, and is the single cheapest
thing in this review. The spec's Plan says "Nothing else in the runner... is touched", so this is
outside what was planned rather than a breach of it; I'm raising it because the mystery, not the
deletion, was the reported pain.

**minor — `FACTORY_WORKTREE_GRACE_MINUTES` is new, undocumented, and fails silently.**
`scripts/runner.ts:161`: `Number(process.env.FACTORY_WORKTREE_GRACE_MINUTES ?? 30)`. It appears
in neither `README.md`, `.env.example`, nor `contrib/factory-runner.service`, so the only way to
discover the knob is to read the runner. Worse, a plausible typo in the unit file — `30m`, or an
empty value — yields `NaN` or `0`, and `worktreeAge(dir) < NaN` is `false`, so the grace guard is
skipped entirely with no warning and no log line. This matches the existing unvalidated
`Number(...)` pattern for `FACTORY_POLL_SECONDS` and `FACTORY_SESSION_IDLE_HOURS`, so it is
consistent with the codebase — but those fail loudly and visibly, whereas this one quietly
removes one of the two guards the spec insisted on for the only code in the factory that deletes
a directory outside the repo.

**minor — the tree can still be removed under a live shell, and the spec scoped that out.**
Thirty minutes after a tree was made, if its branch has commits, they are merged, and
`git status --porcelain` is empty, `git worktree remove` runs regardless of whether anyone is
sitting in that directory. Someone who gets interrupted, comes back after an hour and types into
the tree finds their cwd is a ghost: `ls` and `git status` fail with errors that name nothing
about the sweep. The 30-minute window narrows this but does not change the failure mode. Two
notes in fairness: as soon as he actually *edits* something the dirty check protects him, so this
bites the read-only or just-committed visitor; and the runner already collects tmux session cwds
(`idleCandidates`, `session_path`), so it has the information to notice someone is in there.
"Making the runner aware of worktrees a human made" is explicitly out of scope in the spec, so I
am not asking for it here — raising it because the "comes back after 30 minutes" case is the one
the grace period is named for, and it is the case the grace period does least for.

### Nothing to report on

- **Dead ends:** none. Every path in `pruneWorktree` fails toward keeping the tree, including the
  `catch` in `worktreeAge` returning 0.
- **Noise:** none added. This feature costs the user nothing to read or decide about, which is
  the right shape for a fix like this.
- **Tests:** against real `git init` repos as the spec required, including the fast-forward case
  that broke the first attempt. `backdate()` is honest about why it exists.
