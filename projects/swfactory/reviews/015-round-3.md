# 015 — Finished sessions stop crowding Next — review round 3

Date: 2026-10-26
Reviewed against `git diff 7c3d23d...feature/015-rework-identity`, merged as PR #16 and deployed.
Reviewers: code, security, UX, run in parallel, each given both previous round files.

**Counts** — code: 2 blocking, 9 minor. Security: 1 blocking, 5 minor. UX: 0 blocking, 6 minor.

Both blocking reviewers reached the same conclusion independently, and it is the same conclusion
as round 1 and round 2: **the kill is still gated on a field the reporter supplies.**

| Finding | Status |
| --- | --- |
| R1 B1 — kill target is a name, not an identity | **open, third round** — accidental half closed, deliberate half open |
| R1 B2 — dismissed rows, dashboard-only age check | closed, re-confirmed |
| R1 B3 — `needs_you` 48h cutoff | closed, and round 2's one-layer-down version closed too |
| R2 B1 — `busy` is dead code | closed by removal — but the claim made for the removal is false |
| R2 B2 — identity check one-directional | **open** — replaced, not fixed |

---

## blocking — `cwd` arrives in the same POST as `branch`

`src/hooks.ts:46`, `src/db.ts:138-146`, `scripts/runner.ts:418`.

Security put it flattest:

> The question that decides the round has a flat answer: **yes, and from the request body, with
> no validation of any kind.**
>
> ```
> src/hooks.ts:46   cwd: typeof payload.cwd === "string" ? payload.cwd : null,
> src/db.ts:144     cwd: pick(u.cwd, existing?.cwd),
> src/db.ts:146     branch: pick(u.branch, existing?.branch),
> ```
>
> `cwd` is merged unconditionally, by the same `pick` and on the adjacent line to `branch`.
> `src/db.ts:138` still derives `changed` from the status alone and `:142` still moves
> `status_since` only when `changed`. The field the kill is now bound to is a sibling of the
> field the kill was bound to before, arriving in the same request, under the same no-op status.

Reproduced by both reviewers, read-only, against the live 006 session. Security's run:

```
A. untouched stale row (branch=main, cwd=/home/jesper/some/unrelated/dir)
  attached: no kill target at all
  detached: no kill target at all

B. ONE POST: header X-Factory-Branch + body cwd
  statusChanged=false  status_since=2026-10-25T20:49:50Z (unchanged)
  branch=feature/006-push-notifications  cwd=/home/jesper/code/repos/swfactory
  attached: path=PASS created=PASS attached=true  => KILL=false
  detached: path=PASS created=PASS attached=false => KILL=true
```

Three things make it cheaper than round 2's version, not dearer:

> - **The path needs no tmux read.** `worktreeFor` puts every runner-started session in
>   `~/.cache/factory/worktrees/<project>-<feature-slug>`, derivable from a spec filename in this
>   public repo. tmux also gives it away directly to any process of the user.
> - **Nothing validates it.** I posted `/does/not/exist`, `../../etc`, `not-even-absolute` and
>   `/path/./x/..` — all stored verbatim, and `samePath` happily resolves the `./x/..` form to a
>   match. The field is never checked against the filesystem, against `REPO_ROOT`, or against
>   `WORKTREE_ROOT`.
> - **No knowledge of row state is needed.** 33 session ids are still sitting in
>   `~/.claude/projects/*/*.jsonl`. POST all of them with one `Stop` each: an id whose row is in
>   any other status gets `changed = true` and loses its clock, so the mechanism self-selects
>   exactly the rows that were already `your_turn` and already past the threshold.

And on the claim made in the spec:

> The spec's Log says the bind is "an identity the reporter does not control" and that the re-run
> of round 2's reproduction **refuses**. It refuses the attacker who rewrites `branch` and then
> declines to rewrite `cwd` in the same request. The round 2 rework task is ticked on that basis
> and the load-bearing half of its sentence is false.

**What both propose instead.** Security:

> An identity the reporter does not control has to come from something the *runner* wrote: the
> job table, which `reconcile` already holds in hand, or the tmux name and path recorded at
> `start()`. The cheapest alternative, if that is too much: move `status_since` when `branch`,
> `cwd` or `repo` change and not only when the status does — one line in `upsert`, and it
> restores the 8-hour wait so a retarget costs 8 hours per attempt instead of nothing.

## blocking (code) — the `busy` case is not covered, and three places say it is

`scripts/runner.ts:355-360`, the spec's round 1 task 1, and the spec Log.

> The comment where `busy` was: *"The case it was meant to catch is covered properly now, by
> matching where the session actually lives."* … Both are false, and for the same reason: a
> second Claude session started inside an existing factory tmux session has the **same
> directory** as the first. `samePath` compares directories, so it cannot tell two sessions in
> one tmux session apart — that is precisely the discrimination `busy` was reaching for.

The reachable sequence, with no attacker at all:

> a build session finishes and goes `your_turn`; you attach, open a second window in that same
> tmux session (`tmux new-window`, which inherits the session path) and start another `claude`
> there; you detach. Row A ages past 8h in the worktree; row B is live in the same worktree.
> `idleCandidates` returns A, the name resolves to that tmux session, `samePath` passes (same
> dir), `created` passes, `attached` is 0 — and `kill-session` takes the whole session down, live
> window included. Then `reconcile` reports the job **done** on the following tick.

> It is **not a regression** — `busy` was dead, so this was never defended. The defect is that
> the hole is now documented as closed.

And the bookkeeping:

> round 1 rework task 1 went from `[~]` to `[x]`, including its second clause — *"and skip a name
> another live row claims with a status other than `your_turn`"* — which was **removed**, not
> implemented. The round 2 file asked specifically that a ticked task not describe something that
> is not there; it now does again, in the opposite direction.

## The pattern, named

Security, and it is worth more than any single finding:

> `test/runner.test.ts`: `samePath("/home/jesper/.cache/factory/worktrees/swfactory-006",
> "/home/me/elsewhere")` under the comment *"The retarget: the attacker's row claims a feature
> branch, but reports its own cwd."* Nothing makes the row report its own cwd — that is the whole
> of blocking 1. **This is the third consecutive round with a passing test whose premise the real
> path does not have**: round 1's `needs_you` comment, round 2's `busy` input, now this. Worth
> naming as a pattern rather than three incidents.

---

## Selected minors

### `samePath` does path arithmetic, not identity (code minor 1)
> `resolve(b)` with a relative `b` joins it to `process.cwd()`, which for the deployed unit is
> `WorkingDirectory=%h/code/repos/swfactory`. Measured:
> ```
> samePath("/home/jesper/code/repos/swfactory", ".") = true
> ```
> So a reporter that sends `cwd: "."` matches the shared checkout without knowing or looking up
> any path.

### The path is a shared constant for three of the four commands (code minor 2)
> `worktreeFor` sends every non-build job of a project — `spec`, `plan`, `review` — to one
> directory, `<project>-base`. For all of those sessions `#{session_path}` is the same per-project
> constant, so the bind distinguishes "in the base worktree" from "somewhere else" and nothing
> finer.

### The log dedup defeats itself when it matters most (both)
Production confirms the fix works — **2 lines in ~42 ticks, against 53,623 before** — but:

> `lastSkip` is keyed on the tmux **name**, while the reason string it compares embeds the
> session id and `status_since`. Several rows resolving to one name therefore overwrite each
> other's entry every tick and all of them log every tick. Measured, 3 rows on one name over 3
> ticks: **9 lines, where the dedupe intends 1.** Round 1's own dry run recorded three rows
> resolving to one name, so this is the production shape, not a contrivance.

### `OR status = 'needs_you'` removes the last bound on planted rows (both)
> There is **no `DELETE FROM sessions` anywhere in `src/db.ts`**. A POST with a fresh random
> `session_id` and `hook_event_name: "Notification"` plants a permanent `needs_you` row carrying
> a 600-char attacker-chosen `message`, which now stays in `/api/state`, in Next and in the Inbox
> badge forever where the 14-day gate used to retire it. Escaping is clean … so this is unbounded
> pollution and payload growth, not a disclosure, and the UX reason for the change is sound.

### `tmuxSession` is still untested, and the split makes a silent swap possible (code minor 6)
> The parser's tests assert against hand-written strings, so reordering the three format fields
> leaves all 151 tests green while the runner silently reads `attached` out of the `created`
> column — on the path that ends processes.

---

## UX — 0 blocking, and the structural observation of the round

Round 2's minor 1 is confirmed fixed at the layer that was actually wrong:

> Blocked rows at 20, 25, 45 and 60 days, then at 18/25/31/44/58/73/96/120/155/190/240/300/**400**
> days: every one reaches the client and ranks in Next, at 390×844 and 1366×768, light and dark,
> Ranked and Priority. Sixteen configurations across two boards, no exceptions.

And it checked the thing that would have been a real regression:

> an ancient blocked row does not mask its feature from Next. `liveByFeature` only suppresses on
> `working`, and 004, 007, 010 and 011 all still render their own feature rows alongside their
> blocked sessions.

The observation worth keeping:

> **"A blocked session never leaves Next" is right.** But the fix exposes something the spec has
> never said: `needs_you` is now the only row class in the system with **no automatic retirement
> path at all**. `your_turn` leaves Next at 2h and is ended by the runner at 8h. `ended` ages out
> of `list()` at 14 days. `working` goes "No signal" via `isStale`. `needs_you` is ended by
> nothing — correctly, it is waiting on a person — and as of this diff it ages out of nothing
> either. Every exit is a human tap.

> **The dead-host case is not hypothetical, it is monthly.** `last reboot` on this host: Sep 13,
> Jul 27, Jun 26, May 22, May 9. Any session sitting at a permission prompt when the machine goes
> down leaves a `needs_you` row with no `SessionEnd`.

On whether its carried-over minors have become blocking, it declined to inflate them and said why:

> Round 1's blocking fired at 49 hours: a weekend, something that had already happened. This
> fires at roughly a year of accumulation, on a board that today has zero blocked rows. I will not
> call a projection blocking. But they are the last thing between this feature and its own Why,
> and **one change retires most of them: put the age in the Next session row.**

Its measurements on a year-old board: four blocked rows on one feature render as **four
byte-identical lines**; 7 of 13 Answer rows are literal duplicates; at 390px Ranked the page is
**3881px against an 844px viewport** and the first actionable row is **3.0 screens down** — 015's
own Why sentence, restored for one row class. The Inbox renders **"Dec 30"** and **"Sep 21"** for
2025 rows with the year only in a hover, which a phone does not have. And Dismiss — now the only
exit — is still unreachable by keyboard, from one missing clause that already exists nine lines
up in the same file:

> the click handler at `:658` already has the guard this one lacks (`&& !e.target.closest(".c-action")`).

---

## Disposition

**Escalated, not reworked.** Three rounds, and the blocking finding is the same one each time,
which the factory's own rule says is a decision for the user rather than another automatic pass.

The question is not how to patch `samePath`. It is what the kill should be gated on, and there
are two answers with different costs:

1. **The job table** — `reconcile` already holds `running`, and the runner itself chose both the
   tmux name and the directory, so nothing arriving in a hook can forge it. This is the real fix
   and it changes the shape of the feature.
2. **One line in `upsert`** — move `status_since` when `branch`, `cwd` or `repo` change, not only
   when the status does. A retarget then costs 8 hours per attempt instead of nothing. This
   closes the attack today without touching the destructive path that has now failed three
   reviews.

Everything else is in hand: five of the six prior blocking findings are closed and were
re-verified rather than trusted, the Next side is confirmed working by three browsers' worth of
measurement, and production says the log fix and the end-to-end kill both do what they claim.
