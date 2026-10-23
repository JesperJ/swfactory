---
title: Tell me what to work on next
status: building
priority: P1
summary: A ranked cross-project "next" view that names one thing to do, instead of a list to scan.
---

# Tell me what to work on next

## Why
Running several projects at once, the expensive failure isn't a missed detail — it's losing the
thread at the top level. Open the dashboard, see a grid of projects and statuses, and the work
of deciding what matters is still entirely yours. That decision is the tiring part, and it gets
paid again every time you look.

The current Projects view shows what exists. It doesn't say what to do.

## What
A **Next** view, the default landing view, that names a single recommended action across all
projects, with a handful of ranked alternatives beneath it. Each one is a thing you could start
now, not a status to interpret.

Ranking considers, roughly in order:

- decisions waiting on you (a session blocked, a spec with an open assumption to overturn)
- features `building` that have stalled — no Log entry in N days
- features `planned` and ready to build, by priority
- features `specced` awaiting a plan
- anything blocked, shown as blocked so it stops drawing attention

The view should fit on a phone screen without scrolling. One recommendation, three or four
alternatives, each one line.

## Acceptance criteria
- [x] Opening the dashboard shows one recommended next action, named, with the project it is in
- [x] Below it, at most 4 ranked alternatives, one line each
- [x] Stalled `building` features surface above fresh `planned` ones
- [x] Items blocked on someone else are labelled blocked and ranked last
- [ ] The whole view fits a phone screen without scrolling — not yet verified on a real phone
- [x] Each item links to the spec, and to a session if one is live
- [x] Ranking is explainable — a short reason per item, e.g. "no activity for 9 days"

## Out of scope
- Automatically starting work (that's 005).
- Any ML or scoring model. Simple, legible rules only.

## Open questions
- Assumed stalled means no Log entry for 7 days. Easy to change.
- Assumed this replaces Inbox as the default view, with Inbox staying for live session detail.

## Log
- 2026-10-23 Specced after the real complaint surfaced: the dashboard shows state but doesn't
  reduce decisions, so time is lost re-deciding what matters on every visit.
- 2026-10-23 Built. `src/next.ts` ranks across projects; `/api/state` serves it; Next is the
  default view. 9 ranking tests, typecheck clean. Added `blocked:` frontmatter and a parsed
  `lastLog` date so stalls are detectable. Not verified visually on a phone — no browser
  automation on this machine.
- 2026-10-23 Phone check: layout good, but the bottom bar wrapped to a second row once a
  fourth tab existed — it was hardcoded to 3 columns. Now one row at any tab count.
