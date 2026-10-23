---
title: Factory commands in every repo
status: idea
priority: P2
summary: Install the slash commands to ~/.claude so the workflow works from any project.
---

# Factory commands in every repo

## Why
The commands live in this repo's `.claude/commands`, so they only exist when working inside the
factory. But the work happens in the project repos — which is exactly where `/plan` and
`/build` are wanted. Today that means leaving the project to drive the factory.

## What
`npm run install-commands` copies the commands to `~/.claude/commands`, the same way
`install-hooks` already handles hooks. The commands already locate the specs folder via
`$FACTORY_HOME` or a sibling checkout, so they work once installed.

## Acceptance criteria
- [ ] `/new-feature`, `/plan`, `/build` and `/status` work from any repo
- [ ] Installing twice is idempotent and never clobbers unrelated commands
- [ ] An update to a command in this repo can be re-installed without manual copying
- [ ] The commands find the specs folder without being told where it is

## Open questions
- Assumed a copy, not a symlink, so a broken checkout cannot break every session. A symlink
  would auto-update instead; easy to switch.
