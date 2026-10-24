---
title: Factory commands in every repo
status: specced
priority: P2
summary: One installer puts /factory and its reviewers in ~/.claude, so the line runs from any project repo.
---

# Factory commands in every repo

## Why
The line lives in this repo. `/factory` is `.claude/commands/factory.md` and the three
reviewers are `.claude/agents/review-*.md`, so the whole workflow only exists while a session's
working directory is the factory checkout. But the work happens in the project repos — which is
exactly where `/factory plan` and `/factory build` are wanted. Today that means leaving the
project to drive the factory, or running the build from a repo that isn't the one being built.

Two smaller holes come from the same root:

- `$FACTORY_HOME` is named in `CLAUDE.md` and in the command itself as the way to find the
  specs, and is set nowhere. Only the sibling-checkout fallback actually works, so the commands
  work from `../my-project` and nowhere else.
- `/factory review` tells each reviewer to read `.claude/agents/review-<x>.md`. That path is
  relative to the session's repo, so from a project repo it resolves to nothing and the review
  silently does not happen — the same failure 011 already fixed once, in a different disguise.

## What
`npm run install-commands`, shaped like `install-hooks` beside it.

```sh
npm run install-commands -- --user          # every session on this machine
npm run install-commands -- ../my-project   # one repo, committed, for web and mobile
npm run install-commands -- --check         # is what's installed still what's in the repo?
```

`--user` copies `.claude/commands/factory.md` and the three `.claude/agents/review-*.md` into
`~/.claude/`, and records this checkout as `FACTORY_HOME` in `~/.claude/settings.json` under
`env`, merging into the file rather than replacing it — exactly how `install-hooks` already
handles `FACTORY_URL` and `FACTORY_HOOK_TOKEN`. After that, `/factory` works in any repo on the
machine: it finds the specs through `$FACTORY_HOME/projects` and the reviewer definitions
through `$FACTORY_HOME/.claude/agents/`.

A repo-path target writes the same files into that repo's `.claude/` so Claude Code on the web
and mobile — which never read your `~/.claude` — get the commands too. `FACTORY_HOME` is a
machine-local absolute path and is meaningless committed, so repo mode skips it and prints what
to set in the cloud environment instead.

`--check` prints each installed file that differs from the repo's, because a copy goes stale
the moment a command is edited and nothing else would ever say so.

## Acceptance criteria
- [ ] `npm run install-commands -- --user` installs `factory.md` into `~/.claude/commands/` and
      the three reviewers into `~/.claude/agents/`, and `/factory status` then runs from a repo
      that is not the factory
- [ ] It writes `FACTORY_HOME` into `~/.claude/settings.json` `env`, and `/factory` finds the
      specs with no sibling checkout present
- [ ] `/factory review` resolves its reviewer definitions from outside the factory repo
- [ ] Installing twice leaves the same result, and leaves unrelated commands, agents and
      settings keys untouched — proven by a unit test on the merge function, as `mergeHooks` is
      shaped to allow
- [ ] `npm run install-commands -- <repo path>` installs into that repo's `.claude/` and does
      not write `FACTORY_HOME` or any token there
- [ ] Re-running after editing a command in this repo updates the installed copy, and
      `--check` names every installed file that has drifted from the repo
- [ ] `README.md` documents it beside `install-hooks`, and `npm test` and `npm run typecheck`
      pass

## Out of scope
- Installing the reporting hook. That is `install-hooks`, already done, and keeping them
  separate means a hook change cannot break the commands.
- A published npm package or a global `factory` CLI. The factory checkout is on disk anyway.
- Making `/factory` work without the factory checkout present. The specs are the product; a
  command that cannot reach them has nothing to do.
- Syncing the other direction — editing `~/.claude/commands/factory.md` and pushing it back.

## Open questions
- Assumed a copy, not a symlink, so a moved or broken checkout cannot break every session on
  the machine. `--check` is what pays for that choice; a symlink would auto-update instead and
  is a one-line switch if the drift turns out to be the bigger annoyance.
- Assumed a verbatim copy rather than a thin shim that reads `$FACTORY_HOME`'s copy at run
  time. A shim can never be stale, but it adds an indirection the model has to obey and dies
  with the checkout. Worth revisiting if `--check` starts reporting drift every week.
- Assumed `FACTORY_HOME` belongs in `~/.claude/settings.json`, not in `.zshrc`: sessions started
  by the dashboard runner and by the IDE do not read a login shell's profile.
- Assumed a second script rather than extending `install-hooks`, and no combined `npm run
  install` wrapper until there is a third thing to install.
- Kept at P2. It only pays off once a second project has its own repo; the factory is still
  building itself.
