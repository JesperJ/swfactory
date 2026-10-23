---
title: Start work from the dashboard
status: specced
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
- Assumed the allowed commands are `/plan`, `/build` and `/new-feature` only. `/build` is the
  one with teeth; the others are cheap and safe.
- Assumed the runner is a systemd user service owned by the same user as the repos, since it
  needs their git credentials and `~/.claude`.
- Assumed jobs are claimed by a single runner. Multiple machines would need the job to name a
  host, which is easy to add later but pointless now.
- Permission mode for a started session is undecided. Fully interactive means it waits for a
  human in tmux; a narrow allowlist means it gets further alone. Start interactive, since a
  stuck visible session is better than a surprising one.

## Risks
- This is the first thing in the factory that *executes* rather than describes. The allowed-set
  design matters more than the convenience: a job must never be able to express "run this
  shell command". That is why jobs carry a project, a feature and an enum.
- A runner holding the user's credentials is a meaningful escalation from a read-only
  dashboard. It must refuse jobs for projects it doesn't recognise.
