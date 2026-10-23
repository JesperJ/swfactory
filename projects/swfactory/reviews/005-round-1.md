# 005 — Start work from the dashboard — review round 1

Date: 2026-10-23
Branch: `feature/005-start-session` (PR #3)
Reviewers: code, security, UX, run in parallel.

Note: `.claude/agents/` still was not registered, so the reviewers ran as general-purpose agents
each told to read its own definition file. That is now the documented mechanism — see
`fix/review-agent-loading`.

**Counts** — code: 2 blocking. Security: 0. UX: 3 blocking, 1 minor. Code's second finding and
UX's third are the same defect seen from two directions.

---

## Code review

**Checks run:** 42/42 tests pass, `tsc --noEmit` clean.

Criteria: 5 met, 2 not met, 3 not verifiable from the diff.

### blocking 1 — the hero's "Review it" button queues a build
`public/app.js:156`, against `.claude/commands/factory.md` and `src/next.ts:130`.

> `KIND_COMMAND = { approve: "build", ... }`. But `/factory next`'s own dispatch table says
> `approve` → `review`, not `build`. Tapping "Review it" on a reviewing-status feature queues
> and launches `/factory build <project>/<feature>` instead of a review.
>
> The started session isn't silently destructive — `build` step 1 guards "status must be
> `planned` or `building`, else stop" — but it does the wrong thing: it dead-ends immediately
> instead of reviewing, consumes the job/tmux slot, and (per `src/next.ts:93`,
> `if (live && live.status === "working") continue;`) makes the real "needs review"
> recommendation disappear from Next until that dead session ends.
>
> This is a logic bug in the diff, not just "unverified live", and it is untested — no test
> covers `KIND_COMMAND`/`startControl`.

### blocking 2 — no way to start work outside the top of Next
`public/app.js:179-210`, `:256-263`, `:340-387`.

> The Plan's task "Buttons on the Next hero, Next rows **and the feature sheet**" is checked,
> but there is no start control anywhere in the feature sheet (`syncSheet`) or in
> Projects/`featureRow` — no `startControl`/`data-start` call exists outside `renderNext`.
> Worse, `renderNext` itself only ever shows a button on the hero plus `rest.slice(0, 4)` — at
> most 5 non-blocked items total. Any actionable feature beyond the top 5, and every feature
> reached via the Projects tab, has no way to start work at all.

Everything else checked out: the CAS claim, the dedup, terminal vs non-terminal status handling,
`requireBearer`, and the `/api/*` carve-out which *"correctly excludes bare `POST /api/jobs`
since it lacks the trailing slash."*

---

## Security review

**No findings, blocking or minor.** On the feature with the most real risk in the project.

The reviewer refused to take the diff's own comment at face value:

> I empirically verified tmux's own behavior (not just read the comment claiming it): built a
> probe script that dumps its received `argv`, launched it via
> `tmux new-session -d -c /tmp fakecmd.sh "arg one; touch /tmp/pwned_marker"`, and confirmed
> tmux passes trailing argv elements through to `execve` untouched — the probe received exactly
> one argument containing the literal string, and the marker file was never created.

Traced and cleared: nothing a job carries reaches a shell; the two tokens are genuinely separate
and both timing-safe, with `required()` refusing to boot without them; `findCheckout` matches on
remote identity and fails closed on zero or multiple matches; slugs are validated against real
loaded projects before a job exists, and end up as one opaque argv string.

On the systemd unit, a judgement rather than a complaint:

> It skips hardening directives like `ProtectSystem`/`NoNewPrivileges`, but those would conflict
> with the runner's actual job (tmux, git, `~/.claude`), so omitting them is a reasonable
> cost/benefit call, not a defect.

Secrets: `.env` untracked, no secret-shaped values in tracked files.

---

## UX review

Ran the UI check, viewed all four screenshots, then wrote a Playwright probe against the live
instance to test two things that are statically visible but behaviourally ambiguous.

> **Does it solve the stated problem?** Partially, and the part it doesn't solve is exactly the
> part the user said matters most. When a job is queued or running, this genuinely closes the
> gap... When a job **fails** — the state the spec calls out as the whole reason the tmux and
> visibility design was chosen — the dashboard hands the decision right back, worse than
> before: there's no terminal, and now there's also no button.

### blocking 1 — a failed job is a dead end for 24 hours, though a retry would work
`public/app.js` `startControl`, against `src/db.ts` `UNFINISHED`.

> `startControl()` treats any job where `status !== "done"` as blocking the action button. But
> the store's duplicate-guard deliberately excludes `failed` — a fresh `POST /api/jobs` for the
> same feature would succeed immediately. `listJobs(hours = 24)` keeps the failed job, and thus
> the dead pill, in `/api/state` for a full day. So for up to 24h after a failure, the one thing
> this feature exists to let you do from a phone is unavailable, and the only alternative is the
> terminal the feature was built to eliminate.

### blocking 2 — the failure reason is invisible on a phone
`public/app.js`, the `title` attribute on the pill.

> The spec's own acceptance criterion: "Jobs are visible... each with its reason." The reason is
> rendered only as an HTML `title` attribute. Title attributes don't appear on touch — confirmed
> live: tapping the pill on a mobile-emulated touch context changes nothing in the DOM, and the
> real error text appears nowhere in the page's visible text. On desktop, hovering shows it. On
> the platform this feature says matters most, the reason — which is genuinely good, specific,
> honest text — is unreachable.

### blocking 3 — the button only exists in the Next tab
Same defect as code review's blocking 2, seen from the user's side.

> Someone who navigates by project rather than by the Next queue — which is a normal way to use
> this dashboard — has no action button at all. Worse, the sheet for a feature with a failed job
> shows no trace that a job was ever attempted: status still reads plain "idea", same as if
> nothing had happened.

### minor 4 — row buttons are below the app's own touch baseline
`.rowaction .btn { min-height: 36px }`, against a 40px base `.btn` and a ~44px guideline.

### good, said plainly
> A tap turns into a disabled "Starting…" state immediately, then a live pill replaces the
> button in place, which both confirms the tap landed and structurally prevents the double-tap
> the acceptance criteria call out. The backend design is honest and matches the stated risk
> model.

**Net:** *"the feature makes the common case better and the worst case — the one the user asked
me to weigh most — worse than doing nothing, because it now actively looks like you have no
option when in fact a retry would work; you just can't reach it from where you're standing."*

---

## Side effect of this round
The UX reviewer tapped real buttons, so two `build` jobs for 011 and 005 are sitting `queued`.
Harmless — no runner is installed — but worth knowing that a UX review of this feature now
writes to live state.
