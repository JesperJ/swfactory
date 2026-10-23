---
title: Self-host instead of Fly.io
date: 2026-10-23
status: accepted
---

# Self-host instead of Fly.io

> The self-hosting half of this decision is in force. The Cloudflare Tunnel half was not
> adopted — see `2026-10-23-defer-public-access.md`. The tunnel reasoning below is kept
> because it still describes the shape of whatever publishes this later.

## Context
The original plan was Fly.io. Two things changed it:

- There is an always-on home machine already running Docker, so there is no reason to pay for
  hosting or to put the data on someone else's machine.
- Sessions started from the Claude app or the web run in Anthropic's cloud. Their hooks can
  only report to a publicly reachable URL. A LAN address does not work, and neither does
  Tailscale, because those containers are not on the tailnet. So "self-hosted" is not enough
  on its own; something has to make the dashboard reachable from the public internet.

## Decision
Run the dashboard in Docker on the home machine and publish it through a named Cloudflare Tunnel.

`cloudflared` runs as its own container on a dedicated Docker network that contains only the
factory container. Ingress publishes exactly one hostname to the factory, and everything else
gets a 404.

The isolation is the point. Run as a plain daemon on the host, cloudflared could route to
anything that host can reach: the other container stacks on it, other local ports, and every
service on the home LAN. Ingress rules alone are a policy promise. A dedicated Docker network
is a boundary that holds even if the tunnel config or the Cloudflare account is compromised.

Not routed through the reverse proxy already on that host: it has no Let's Encrypt resolver and
serves built-in self-signed certs, which would mean certificate warnings on mobile and failed
TLS verification from cloud session hooks.

## Consequences
Better:
- No hosting cost; session data and specs stay on hardware we own.
- No inbound ports, no port forwarding, no firewall changes — cloudflared dials out.
- The blast radius of a tunnel compromise is one container, not the whole LAN.

Worse:
- The host has to be awake, or the dashboard is down and hook reports are lost.
- Cloudflare terminates TLS and can see plaintext, including the prompt text and Claude's
  last message that the hook carries. Accepted for this content; it would not be for secrets.
- A public URL needs real access control. The dashboard password alone is thin, so Cloudflare
  Access is on the table.
- The image bakes `projects/` in at build time, so specs need `SPECS_GIT_URL` or a bind mount
  to update without a rebuild. Fly would have forced that work; self-hosting lets us defer it.

## Revisit if
The host stops being reliably on, or the dashboard starts carrying content we would not want
Cloudflare to see. Then a small VPS we own becomes the better trade.
