---
title: Clickable links for local sessions
status: idea
priority: P3
blocked: no inbound API for a running local session is known
summary: Open a local Claude session from the dashboard, the way cloud sessions already can.
---

# Clickable links for local sessions

## Why
Cloud sessions carry a claude.ai URL, so the dashboard can offer "Open session". Sessions on
this machine cannot, so the most useful button is missing exactly where most work happens.

## What
A session running locally should be openable from the dashboard — focusing its terminal,
attaching to its tmux window, or deep-linking through Remote Control.

## Open questions
- Does Claude Code expose a Remote Control URL to hooks for local sessions? If it does, the
  hook can send it and this is nearly free.
- Failing that, is launching sessions inside tmux (see 005) enough? Then "open" becomes
  "attach to this tmux window", which works from any terminal.

## Out of scope
- Replying to a session from the dashboard. That is 011's problem, not this one.
