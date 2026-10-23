---
title: Sessions report to the dashboard
status: done
priority: P1
summary: Claude Code hooks send session status (working, your turn, needs you) with a link back.
---

# Sessions report to the dashboard

## Why
The dashboard is only useful if it knows about every session without me or Claude doing anything.

## What
A hook script, installed per machine or per repo, posts each session event to the dashboard.
The dashboard links the session to a project (git remote) and feature (branch name).

## Acceptance criteria
- [x] SessionStart, UserPromptSubmit, Notification, Stop and SessionEnd update the session status
- [x] Cloud sessions include a link to open them on claude.ai
- [x] Git credentials in the remote URL are never sent
- [x] Hooks never slow down or fail a session when the dashboard is unreachable
- [x] `npm run install-hooks` sets it up for a machine or a repo

## Log
- 2026-10-23 First version.
- 2026-10-23 Fixed notifications that never cleared. Claude Code repeats idle notifications
  while a session waits; each one was refreshing `updated_at` (so the inbox window never
  expired) and resetting `dismissed` to 0 (so dismissed cards came back). Sessions now carry
  `status_since`, set only when the status actually changes, and a repeated nudge no longer
  revives a dismissed card. Opening a session from the dashboard now clears it too.
- 2026-10-23 Done. Running in production: four real sessions reporting from this machine,
  matched to projects by git remote, with credentials stripped. The missing clickable link for
  local Remote Control sessions moved to 009 — it is a separate capability blocked upstream,
  not unfinished work here.
