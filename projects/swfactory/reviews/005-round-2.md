# 005 — Start work from the dashboard — review round 2

Date: 2026-10-23
Branch: `feature/005-start-session` (PR #3), rework commit `1f722fa`
Reviewers: code, security, UX, run in parallel, each given round 1's findings.

**Counts** — code: 1 blocking (new), 1 minor. Security: 0 blocking, 1 judged finding.
UX: 0 blocking, 1 minor.

**Round 1's five findings: all genuinely fixed**, confirmed independently by code and UX —
by reading the structure in one case and by tapping real controls on a touch-emulated phone in
the other.

---

## Code review

**Checks run:** 46/46 tests pass, `tsc --noEmit` clean.

### Round 1 verification

> All five are genuinely fixed, not edited around.

On the mapping specifically:

> The mapping now lives once, in `src/next.ts:24-32`, and `featureEntry` is now a thin wrapper
> that delegates entirely to the new exported `featureAction` — it copies
> `kind`/`action`/`command`/`reason`/`score` straight from it. There is no second switch
> statement left to disagree with it, so **`featureAction` and `featureEntry` cannot diverge**
> — that's enforced by construction, not convention.

### blocking 1 (new) — a job that starts successfully is stuck at `running` forever
`scripts/runner.ts` `tick`/`start`, `src/server.ts:144-153`, `src/db.ts` `enqueue`/`UNFINISHED`.

> Nothing in the diff ever reports a job as `done`. `runner.ts`'s `tick()` only calls
> `report(job.id, "running")` on success or `report(job.id, "failed", why)` on failure — there
> is no code path that posts `status: "done"`, and `/api/hooks` never looks at the `jobs` table
> at all, so a session ending normally never reconciles back to its job. `setJobStatus` and the
> API route support `"done"` and it's exercised in tests, but only by tests calling it directly;
> production code never reaches it.
>
> Consequence: once a job is `running`, `enqueue`'s duplicate guard has no time bound, so it
> blocks a new job for that exact project/feature **forever**, and `listJobs()` keeps returning
> it, so the "Started" pill never goes away either.
>
> Reproduction: tap "Build it" on a `planned` feature, let the tmux session run and finish
> normally, exit it. The live session drops out of `liveSessions()`, so the start control
> re-renders — but `jobFor` still finds the job at `running`, so the control shows a permanent
> "Started" pill instead of the next action, and `POST /api/jobs` keeps returning the stale job.
>
> This is a real "state that can't be recovered" defect, hit on the ordinary success path, not
> an edge case — and it undercuts the acceptance criterion "Two taps don't start two sessions",
> since the mechanism built for that now blocks *all* future taps, not just the duplicate one.
>
> This is not something round 2 introduced — `runner.ts` was untouched in this round's commit —
> but it is still open in the diff under review and nothing in round 1 or round 2 caught it.

### minor 2 — a checkbox still overclaims
> The spec ticks "cover `KIND_COMMAND` and `startControl` with tests". The round-2 tests cover
> the server-side mapping thoroughly, but `startControl` in `public/app.js` has no test anywhere
> — no DOM or browser test exists. Functionally harmless since the underlying mapping bug is
> covered, but worth noting given this spec's own history of false ticks.

---

## Security review

**No blocking findings.** One finding recorded as a judgement rather than a defect.

### judged, not blocking — what `review` in `JOB_COMMANDS` actually unlocks
> `/factory review <id>` spawns the reviewers, writes the findings, then **unconditionally runs
> `approve`** — and `approve`, for blocking findings in round 1 or 2, takes the Rework path:
> sets status to `building` and **runs `build`** — full write access, `git push`, `gh pr create`.
>
> So queuing `review` does not just add a read-only action. It makes reachable, from a single
> queued job, the same push+PR capability `build` already has — on a feature in `reviewing`
> status, which `build`'s own guard would otherwise refuse. The real widening isn't "shell
> access"... it's "which feature statuses that ceiling is reachable from."

Not blocking because the cascade is pre-existing `factory.md` behaviour rather than something
this diff invented, the ceiling is unchanged (no merge, never `main`), and the runner always
launches an attended, attachable tmux session where the operator's own permission settings still
gate writes.

> Worth recording for whoever revisits this: the comment at `src/db.ts:46-47` undersells what
> `review` actually unlocks. If the threat model ever tightens (e.g. a second user, or exposure
> beyond LAN), this is the first place to re-examine — specifically whether `approve`'s
> auto-chain into `build` should require a human in the loop before, not just during, the write.

The error-text path is cleared: runner-reported text is truncated server-side, then rendered
through `esc()` at its single render site, so a crafted failure string reaches the DOM as text.

---

## UX review

**All three round 1 blocking findings and the minor one genuinely fixed**, verified by tapping
real controls against the live instance rather than reading the diff. Retry works from the sheet
on touch; the reason is plain visible text in both the Next list and the sheet; controls exist in
all four claimed places; row buttons are 44px.

> Round 1's core complaint — "now there's also no button" — is no longer true anywhere I could
> find it.

Disclosed: tapping retry queued real work (job 4, `swfactory/010-commands-everywhere` `spec`).

### minor 1 (new) — a real failure and an administrative cancellation look identical
> Three "Failed." cards show at once. One is genuinely useful... The other two are
> administrative leftovers from round 1, and both carry the exact same internal,
> engineering-facing sentence: "cancelled: queued during round 1 review using the superseded
> kind-to-command mapping." That text means nothing to someone using the dashboard.
>
> ...it does expose a real gap: the system has no way to distinguish "the runner tried and hit a
> real problem" from "someone administratively voided this," and whatever string ends up in a
> job's `error` field is shown verbatim and un-curated. If a real operator ever cancels a stale
> job — plausible, since jobs can only be superseded by retrying, never explicitly cancelled —
> it will read exactly this way: an alarming red "Failed" indistinguishable from a genuine error.

Not called blocking: a normal user would not produce two identically-worded cancellations. The
wording was written by hand during this review's own cleanup.
