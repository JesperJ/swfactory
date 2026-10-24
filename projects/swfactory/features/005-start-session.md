---
title: Start work from the dashboard
status: done
priority: P1
summary: Tap Build on a feature and a real Claude session starts in that repo, via a host-side runner.
---

# Start work from the dashboard

## Why
The dashboard observes. It shows what needs doing and then asks me to go and do it somewhere
else — open a terminal, find the repo, remember the command. That gap is why this is a monitor
rather than a factory, and it is worst from a phone, where there is no terminal at all.

The Next view already names the single most useful action. It should be able to take it.

## What
Every actionable item in Next and on a feature gets a button that does the thing it names:
**Build**, **Plan**, **Spec**. Tapping it starts a real Claude session in that project's repo,
running the matching factory command. Within seconds the existing hooks report it, so it
appears as a working session with no extra plumbing.

The dashboard runs in a container and must not be able to execute anything on the host. So it
does not start sessions — it *queues* them, and a small host-side runner does the work:

```
Dashboard (container)                 Runner (host, systemd --user)
  POST /api/jobs   ── queued ──▶  GET /api/jobs/next   (polls, runner token)
                                       │ claim
                                       ▼
                                  tmux new-session -d -c <repo>
                                    claude "/build swfactory/008"
                                       │
  hooks report the session ◀───────────┘  (nothing special; the normal hook path)
```

The container gains no host access. The runner pulls; nothing pushes into it.

### Why tmux rather than headless
A build will eventually hit a permission prompt or a question. Headless, that session is stuck
and invisible — it would show as `needs_you` with no way to answer, which is worse than not
starting it. Inside tmux it can be attached from any terminal, and it gives 009 an obvious
answer for "open this session".

## Acceptance criteria
- [x] Next's recommendation and each feature expose a button matching the action named
- [x] Tapping it starts a Claude session in that project's repo running the right command
- [x] The started session appears in the dashboard within 30s through the normal hook path
- [x] The dashboard container cannot execute anything on the host; the runner only pulls
- [x] A job names a project, a feature and one of an allowed set of commands — never free text
      and never a shell string
- [x] A job for a project with no `repo:`, or a repo missing on disk, fails with a visible
      reason rather than silently
- [x] Two taps don't start two sessions for the same feature
- [x] A session started this way runs in tmux and can be attached
- [x] The runner recovers cleanly if the dashboard is down; reboot survival is configured but
      needs `loginctl enable-linger` to hold without a login — see the Log
- [x] Jobs are visible: queued, running, failed, each with its reason

## Out of scope
- Replying into a running session from the dashboard (separate, and harder).
- Auto-merging or auto-pushing. A started session works on a branch and stops for review.
- Running jobs for repos not checked out on this machine.

## Open questions
- Assumed the allowed commands are `/factory plan`, `/factory build` and `/factory spec` only.
  `build` is the one with teeth; the others are cheap and safe.
- Assumed the runner is a systemd user service owned by the same user as the repos, since it
  needs their git credentials and `~/.claude`.
- Assumed jobs are claimed by a single runner. Multiple machines would need the job to name a
  host, which is easy to add later but pointless now.
- **A started session inherits whatever state the checkout is in** — possibly a dirty tree on
  an unrelated branch, possibly the branch another session is working on. The runner does not
  check, and `build` would then commit onto it. Not hit yet because nothing has been started
  into a live checkout; the honest fix is probably a worktree per job rather than the shared
  checkout. This is why the launch path was tested against a throwaway repo rather than this one.
- Permission mode for a started session is undecided. Fully interactive means it waits for a
  human in tmux; a narrow allowlist means it gets further alone. Start interactive, since a
  stuck visible session is better than a surprising one.

## Plan
Four parts. The queue and the runner are independent of each other — the queue can be built and
tested without a runner existing, which keeps the risky half small and late.

**1. The job store.** A `jobs` table alongside `sessions` in `src/db.ts`: `id`, `project`,
`feature`, `command` (enum), `status` (`queued`/`claimed`/`running`/`failed`/`done`), `error`,
`created_at`, `claimed_at`, `finished_at`, `session_id`. Methods `enqueue`, `claimNext`,
`finish`, `list`. `enqueue` refuses when an unfinished job already exists for the same project
and feature — that is the "two taps don't start two sessions" criterion, enforced in the store
rather than the UI, because the UI is the thing that will be tapped twice.

**2. The API.** Three routes in `src/server.ts`:
`POST /api/jobs` (UI auth) takes `{project, feature, command}` and validates `command` against
a hardcoded list — `plan`, `build`, `spec`. Anything else is a 400. The job never carries a
shell string, a path, or free text; the runner reconstructs the command from the enum.
`GET /api/jobs/next` and `POST /api/jobs/:id/status` take a **third** bearer token,
`FACTORY_RUNNER_TOKEN`, separate from the hook token. A leaked hook token must not be able to
make the host run anything. `requireHookToken` in `src/auth.ts` generalises to
`requireBearer(token)`; the two uses then differ only in which secret they check.

**3. The buttons.** `renderNext`'s hero and rows, and the feature sheet, gain a button whose
label is the item's existing `action` and whose payload is the item's `kind` mapped to a
command — the same mapping `/factory next` uses, so the dashboard and the command agree. A
queued job shows as a pill on the item until a session reports, at which point the normal
session machinery takes over and the pill is replaced by the live status.

**4. The runner.** `scripts/runner.ts`, run as a systemd user service, polling
`GET /api/jobs/next` every 10s. For each job:
- resolve the checkout by scanning `FACTORY_REPO_ROOT` (default `~/code/repos`) for a repo whose
  `git remote get-url origin` normalises — with the existing `normalizeRepo` — to the project's
  `repo:`. Matching on identity rather than on a name means a wrong or renamed directory fails
  closed instead of running in the wrong place.
- `tmux new-session -d -s factory-<project>-<NNN> -c <path> claude "/factory <command> <id>"`
- report `running`, then `failed` with a reason if tmux or the path resolution fails.

A missing repo, an ambiguous match, or an unknown project is a `failed` job with its reason
shown on the dashboard — never a silent no-op.

Trade-off taken: the runner polls rather than holding a connection. Polling is duller and
recovers from the dashboard being down or restarted without any reconnect logic, which matters
more here than the few seconds of latency it costs.

## Tasks
- [x] `jobs` table and store methods in `src/db.ts`, with the duplicate-job guard, plus tests
- [x] Generalise `requireHookToken` to `requireBearer` in `src/auth.ts`; add `FACTORY_RUNNER_TOKEN`
- [x] `POST /api/jobs` with the command enum validated server-side, plus a test for rejection
- [x] `GET /api/jobs/next` and `POST /api/jobs/:id/status` behind the runner token, plus tests
- [x] Expose queued jobs in `/api/state` so the UI can show them
- [x] Buttons on the Next hero, Next rows and the feature sheet, mapping `kind` to a command
- [x] `scripts/runner.ts`: poll, resolve the checkout by git remote, launch tmux, report back
- [x] A `failed` job shows its reason on the dashboard rather than disappearing
- [x] systemd user unit file and the README section to install it
- [x] Dogfood: queue a job end to end and watch a real session do the work
- [x] Round 2: the runner reconciles running jobs against tmux and reports `done` when a session exits
- [x] Round 2: an unfinished job older than a few hours stops blocking new work, so a dead runner cannot wedge a feature
- [x] Round 2: the UI offers the action again for a stale job instead of a permanent pill
- [x] Round 1: `KIND_COMMAND.approve` queues a build for a feature at `reviewing`; it must map to `review`
- [x] Round 1: allow `review` as a job command, or the hero button for a reviewing feature cannot work
- [x] Round 1: a failed job blocks retry for 24h although the store would accept one
- [x] Round 1: the failure reason lives only in a `title` attribute, invisible on touch
- [x] Round 1: no start control outside the Next hero and its first four rows — add to the feature sheet and the project feature rows
- [x] Round 1 (minor): row buttons are 36px, below the 40px base and the 44px touch guideline
- [x] Round 1: cover `KIND_COMMAND` and `startControl` with tests — neither is tested

## Risks
- This is the first thing in the factory that *executes* rather than describes. The allowed-set
  design matters more than the convenience: a job must never be able to express "run this
  shell command". That is why jobs carry a project, a feature and an enum.
- A runner holding the user's credentials is a meaningful escalation from a read-only
  dashboard. It must refuse jobs for projects it doesn't recognise.

## Log
- 2026-10-23 Planned. Four parts: job store, API, buttons, runner — the queue is independent of
  the runner, so the risky half stays small and late. The runner polls and claims; nothing ever
  reaches into the host, and a job carries a project, a feature and an enum rather than anything
  resembling a command. Recorded as `decisions/2026-10-23-runner-pulls-never-pushed-to.md`.
  A third token, `FACTORY_RUNNER_TOKEN`, keeps the comparatively exposed hook token from being
  able to make the host run anything. 10 tasks.
- 2026-10-23 Build started on `feature/005-start-session`.
- 2026-10-23 Built. Job store, API with the runner token split out, buttons, runner and systemd
  unit. 42 tests.
  Verified live, not just by test: a job queued through the API, a second tap returning the same
  job rather than a new one, a forbidden command rejected with 400, the checkout resolved by git
  remote across ~40 real repos, and a tmux session launched in the right directory running
  exactly `/factory build demo/001-a`. The launch was exercised against a throwaway repo with a
  stubbed `claude`, deliberately — see the open question below.
  Caught while looking at the result: the `/api/*` middleware would have locked the runner out
  of its own endpoints, and the row action rendered between cards so a `Failed` pill read as
  belonging to the wrong row. Both fixed.
- 2026-10-23 PR #3. Three criteria stay unticked — a session started into a live checkout, the
  30s hook round trip, and the runner surviving a reboot — because none has been exercised, and
  the first is held back by the checkout-state question above rather than by missing code.
- 2026-10-23 Round 1 → rework. Five blocking findings in `reviews/005-round-1.md`, all clear
  and local. Security found nothing, having verified the tmux argv claim empirically rather
  than reading the comment that asserts it.
  Two criteria were ticked falsely and are now un-ticked: "each feature exposes a button" —
  true only in the Next tab, and only for its top five items — and "jobs are visible with their
  reason" — the reason is in a `title` attribute, which does not exist on touch. Third round
  running where ticking happened in the place the thing was built rather than everywhere the
  criterion claims.
  The worst finding is not a crash: tapping "Review it" on the hero queues a *build*, because
  `KIND_COMMAND` disagrees with the dispatch table in `factory.md`. It dead-ends on `build`'s
  own status guard, so nothing is damaged — but it burns the job and hides the real
  recommendation until the dead session ends.
- 2026-10-23 Round 1 fixes built. The kind-to-command mapping now exists once, in `src/next.ts`,
  and every feature carries its own `next` through `/api/state` — so the UI is told what a tap
  means rather than deriving it. That is the actual fix for "Review it queues a build": the two
  copies that disagreed are now one. `review` joins the allowed job commands, since the hero
  button for a reviewing feature could not otherwise work.
  A failed job now states its reason in visible text and offers a retry, which the store always
  allowed. Start controls exist on the Next hero, Next rows, project feature rows and the
  feature sheet. Row buttons are 44px.
  Four tests cover the mapping, including one asserting that every command a feature can queue
  is one the API would accept — the class of bug round 1 found.
  46 tests, typecheck clean, shoot clean. Also cancelled jobs 2 and 3, queued by the UX reviewer
  through the old mapping.
- 2026-10-23 Round 2 → escalate. Round 1's five findings are all verified fixed, independently
  by two reviewers, one of which tapped the real controls on a phone. Security cleared the
  rework and recorded a judgement about what `review` in the job enum unlocks.
  Code found a new blocking defect that both earlier rounds missed and that this round did not
  introduce: **nothing ever reports a job as `done`**. The runner reports `running` or `failed`
  and stops there; `/api/hooks` never looks at the jobs table. So a job that starts and finishes
  normally stays `running` forever, the duplicate guard blocks every future tap for that
  feature, and the "Started" pill never clears. It is the ordinary success path, and it inverts
  the criterion it was built for: "two taps don't start two sessions" became "no tap ever starts
  one again".
  Escalated rather than reworked because the fix is a design choice, not a correction: three
  mechanisms could tell a job it has finished and they have different costs. See below.
- 2026-10-23 Escalation answered: both mechanisms, 1 and 3. The runner reconciles against tmux
  so a finished session closes its job; the guard gains a time bound so a dead runner cannot
  wedge a feature permanently. Neither protects against the other's failure, which is why both.
- 2026-10-23 Round 2 fixes built. The runner now reconciles: each tick it asks the dashboard
  which jobs it believes are running and checks whether their tmux sessions still exist,
  reporting `done` for any that have gone. The state lives on the dashboard rather than in the
  runner process, so a runner restart loses nothing.
  Verified against a real tmux session rather than a mock: with the session alive the job stayed
  `running`; killed, the next pass reported it done and the running list emptied.
  The backstop is `STALE_JOB_HOURS = 6`. An unfinished job older than that stops blocking new
  work, and `listJobs` marks exactly those jobs `stale` so the UI offers the action again
  instead of a pill that never clears — one rule, applied in both places, with a test asserting
  the two agree.
  Also replaced the error text on the two cancelled jobs: I had written code-review jargon about
  a "superseded kind-to-command mapping" into a field the dashboard shows verbatim.
  51 tests, typecheck clean, shoot clean.
- 2026-10-23 Dogfooded with the runner installed as a systemd user service. **It works end to
  end**: job 6 was queued through the API, claimed within 10s, launched `/factory spec
  swfactory/006` in a tmux session in the right checkout, and that session wrote the spec and
  committed it — `3c95445`, 78 lines. The session then ended and the reconciler closed the job.
  Two real defects found, both fixed:
  - The runner's tmux sessions were invisible. A systemd user unit gets no `TMUX_TMPDIR`, so
    tmux used `/tmp/tmux-1000` while the shell uses `/run/user/1000` — two servers. `tmux ls`
    showed nothing and the spec's "attachable from any terminal" promise quietly failed. The
    unit now sets `TMUX_TMPDIR=%t`. This cost about twenty minutes of misdiagnosis: every symptom
    looked like the session had died instantly.
  - `reconcile` swallowed its errors with a bare `catch { return; }`, so a dashboard it could not
    reach meant jobs silently stayed `running` forever — the exact failure the function exists to
    prevent. It logs now.
  Left open deliberately: the session ran on `main` in the live checkout and committed there.
  Nothing was lost — the "commits are narrow" rule held and unrelated uncommitted work was not
  swept up — but it confirms the worktree question below is real rather than theoretical.
- 2026-10-24 Both remaining criteria measured rather than assumed, and the measuring found two
  defects first.
  **Session visible in 8s**, linked to its feature — well inside the 30s the criterion asks for.
  **Recovery verified:** stopped the dashboard container; the runner stayed up, logged
  `reconcile failed: fetch failed` and `poll failed: fetch failed` each tick rather than dying,
  and claimed a new job 8s after the dashboard came back.
  **Reboot survival is configured but conditional**, and the criterion is ticked with that
  stated rather than glossed: the unit is `enabled` with `Restart=always`, but
  `loginctl show-user --property=Linger` is `no`, so the user manager — and the runner with it —
  starts at login, not at boot. On a desktop that logs in, it survives a reboot. Headless or
  before login, it does not. `loginctl enable-linger jesper` makes it unconditional.
  Two defects found by testing, both of my own making, both fixed here:
  - Every `spec`, `plan` and `review` job failed outright. 013's rework sent them to the default
    branch, and git allows a branch in one worktree only — the human's checkout has it. Three of
    the four commands, broken by a fix. They now get a detached tree at the base commit; specs
    are committed in `$FACTORY_HOME` regardless, so the tree is only somewhere to stand.
  - That fix then broke session linking: a detached tree has no branch, so the hook reported
    none and every non-build session appeared unlinked. The runner now passes `FACTORY_FEATURE`
    through `tmux -e`, which the hook has always read. The runner knows the feature; it should
    say so rather than leave the dashboard to infer it from a branch name.
  126 tests, typecheck clean.
- 2026-10-24 **Passed.** All 10 criteria met, the last two measured rather than asserted — a
  session visible and linked in 8s against a 30s bar, and the runner surviving the dashboard
  being stopped and reclaiming 8s after it returned. Reboot survival is ticked with its
  condition stated: `Linger=no` means the runner starts at login, not at boot.
  Two review rounds (`reviews/005-round-1.md`, `-2.md`): round 1 returned 5 blocking, round 2
  returned 1 — the job lifecycle never closing — which was escalated and answered with both
  mechanisms, tmux reconciliation and a time-bound guard.
  Worth recording for whoever reads this later: going to *verify* the last two criteria is what
  found that every `spec`, `plan` and `review` job had been failing since 013 landed, and then
  that the fix for it broke session linking. Neither was visible from the tests, which passed
  throughout. The criteria were not paperwork; they were the only thing pointed at the path
  nobody was exercising.
