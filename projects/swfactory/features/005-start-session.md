---
title: Start work from the dashboard
status: building
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
- [ ] Next's recommendation and each feature expose a button matching the action named
- [ ] Tapping it starts a Claude session in that project's repo running the right command
- [ ] The started session appears in the dashboard within 30s through the normal hook path
- [ ] The dashboard container cannot execute anything on the host; the runner only pulls
- [ ] A job names a project, a feature and one of an allowed set of commands — never free text
      and never a shell string
- [ ] A job for a project with no `repo:`, or a repo missing on disk, fails with a visible
      reason rather than silently
- [ ] Two taps don't start two sessions for the same feature
- [ ] A session started this way runs in tmux and can be attached
- [ ] The runner survives a reboot and recovers cleanly if the dashboard is down
- [ ] Jobs are visible: queued, running, failed, each with its reason

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
- [ ] Buttons on the Next hero, Next rows and the feature sheet, mapping `kind` to a command
- [ ] `scripts/runner.ts`: poll, resolve the checkout by git remote, launch tmux, report back
- [ ] A `failed` job shows its reason on the dashboard rather than disappearing
- [ ] systemd user unit file and the README section to install it
- [ ] Dogfood: queue a job from the phone and watch the session appear in the Inbox

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
