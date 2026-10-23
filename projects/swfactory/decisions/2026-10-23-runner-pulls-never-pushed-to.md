---
title: The runner pulls; nothing reaches into the host
date: 2026-10-23
status: accepted
---

# The runner pulls; nothing reaches into the host

## Context
The dashboard runs in a container and needs to cause a Claude session to start on the host.
The obvious ways to do that are all ways of giving a web app a foothold on the machine:
mounting the Docker socket, an SSH key, a webhook listening on the host, or simply running the
dashboard outside the container.

The dashboard is also the component most exposed to the outside: it has a login, it is the
thing that would be published if 004 is ever revisited, and it renders content from files.

## Decision
The dashboard never executes anything. It writes a row to a `jobs` table.

A separate runner process on the host polls `GET /api/jobs/next`, claims a job, and starts the
session. The direction of every connection is outward from the host. Nothing listens on the
host, the container holds no host credentials, and compromising the dashboard yields the
ability to enqueue a row — not to run a command.

What a job may express is deliberately narrow: a project, a feature, and one of three commands
from a fixed list. No shell string, no path, no free text. The runner reconstructs the command
from the enum, so the worst a malicious or malformed job can do is run a factory command
against a feature the attacker chose.

The runner authenticates with `FACTORY_RUNNER_TOKEN`, separate from the hook token. The hooks
run in every Claude session on this machine and their token is comparatively exposed; it must
not be able to make the host run anything.

Polling, not a held connection: it recovers from the dashboard restarting without reconnect
logic, at the cost of a few seconds' latency that nobody will notice.

## Consequences
Better:
- The container gains no host access, so publishing the dashboard later does not change what an
  attacker who gets in can do.
- The job schema is the security boundary and it is small enough to read in one sitting.
- Two separate tokens mean the blast radius of each is bounded.

Worse:
- A second process to install, run and keep alive, with its own failure modes.
- The runner holds the user's credentials and `~/.claude`, so it is the most privileged part of
  the system. It must refuse jobs for projects it cannot identify.
- Latency between tapping and the session appearing.

## Revisit if
The factory ever needs to run work on more than one machine. Then a job must name a host and
runners must claim only their own, which is a small change to the same design rather than a
different one.
