---
name: Software Factory
status: active
repo: https://github.com/JesperJ/swfactory
summary: Spec-driven way to build software with Claude, with one live view of every project, feature and session.
---

# Software Factory

## Vision
Building software with Claude should be structured, not vibe coding: every feature starts as a
spec with acceptance criteria, gets a plan, and is built against it. One page, on phone or
desktop, shows every project, what's done, what's next, and which Claude sessions need me.

## Users
Me, running several projects at once, often from my phone, with Claude sessions running locally
and in the cloud.

## Constraints
- Specs are plain markdown in git, readable in Obsidian.
- Self-hosted dashboard, reachable from mobile, protected by a password.
- Reporting from sessions must be automatic (hooks), not something Claude has to remember.

## Out of scope
- Multi-user / team permissions.
- Replacing GitHub issues or PRs for code review.
