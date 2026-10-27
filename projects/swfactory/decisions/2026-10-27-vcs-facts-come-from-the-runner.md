# Branch and merge state reach the dashboard through the runner, not git

Date: 2026-10-27
Feature: 017

## The decision
The dashboard does not run git. Facts about branches and merged pull requests are reported to
it by the runner, which already runs on the host with the real repository and already holds a
token. The dashboard stores what it is told and renders it.

## Why it was forced
017's spec assumed the opposite — "branch and merge state come from the local repository, so the
board keeps working with no network and no token". Planning it found the container cannot do
that:

```
$ docker exec factory sh -c 'command -v git; ls -d /app/.git'
/usr/bin/git
no /app/.git
$ docker inspect factory --format '{{json .HostConfig.Binds}}'
["swfactory-data:/data","/home/jesper/code/repos/swfactory/projects:/app/projects:ro"]
```

The git binary is present and there is no repository for it to read. Only `projects/` is
mounted, read-only. 014 recorded the same constraint from the other side when it chose to hash
file contents rather than use a git SHA: *"a git SHA is unavailable in the container, which does
not ship `.git`."*

## What was rejected
- **Mounting `.git` into the container.** It would work and it widens what a web-reachable
  process can read to the whole history of a public repo, including anything ever committed by
  mistake. The dashboard is on a LAN behind a password; the repository is not its business.
- **Calling the GitHub API.** Needs a token in the dashboard, works only online, and makes the
  board's correctness depend on a third party. The spec rejected this already and that part of
  the spec stands.
- **Deriving merged state from the feature's status.** `done` and "merged" are different facts
  and this evening produced several features that were one without the other. Inferring one from
  the other would make the board confidently wrong.

## Consequences
- The PR **link** needs none of this: `build` already writes it into the spec's Log, which the
  dashboard reads. Links ship without the runner.
- Merge state is only as fresh as the last runner tick, and absent entirely when no runner is
  running. The row must therefore treat "unknown" as a real state and say nothing rather than
  guess.
- The runner gains a reporting responsibility it did not have, in the direction it already has a
  token for.
