---
title: Live dashboard
status: building
priority: P1
summary: One page showing projects, features and Claude sessions, great on phone and desktop.
---

# Live dashboard

## Why
I lose track of which projects are moving, what's next, and which Claude sessions are waiting
on me, especially away from my desk.

## What
A password-protected web app with three views: an **Inbox** of sessions that need me, **Projects**
with feature progress, and **Sessions**. It updates live. Tapping a feature opens its spec.

## Acceptance criteria
- [x] Inbox lists sessions that need input or finished their turn, most urgent first
- [x] Projects view shows each project's features by status with a progress bar
- [x] Tapping a feature shows its rendered spec and linked sessions
- [x] Updates appear without reloading (server-sent events)
- [x] Works at 375px wide (bottom tabs, bottom sheet) and on desktop (sidebar, side drawer)
- [x] Light and dark mode
- [ ] Installed to the phone's home screen, it opens full screen

## Plan
Node + Hono server, SQLite (node:sqlite) for sessions, specs read from markdown on each request.
Plain ES module frontend, no build step.

## Tasks
- [x] Spec loader and session store
- [x] API + SSE
- [x] Mobile and desktop UI
- [ ] Verify home-screen install on iOS and Android

## Log
- 2026-10-23 First version.
- 2026-10-23 Added `npm run shoot`: screenshots phone and desktop widths using the system
  Chromium and fails on console errors, horizontal overflow or a wrapped tab bar. UI changes
  are now self-verifiable instead of needing a phone check. Also fixed a dead end where the
  top recommendation offered no action when it was an unlinked session.
