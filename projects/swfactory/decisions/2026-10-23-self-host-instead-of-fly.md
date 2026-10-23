---
title: Self-host on D002 behind a Cloudflare Tunnel instead of Fly.io
date: 2026-10-23
status: accepted
---

# Self-host on D002 behind a Cloudflare Tunnel instead of Fly.io

## Context
The original plan was Fly.io. Two things changed it:

- D002 is an always-on desktop already running Docker, so there is no reason to pay for
  hosting or to put the data on someone else's machine.
- Sessions started from the Claude app or the web run in Anthropic's cloud. Their hooks can
  only report to a publicly reachable URL. A LAN address does not work, and neither does
  Tailscale, because those containers are not on the tailnet. So "self-hosted" is not enough
  on its own; something has to make the dashboard reachable from the public internet.

## Decision
Run the dashboard in Docker on D002 and publish it through a named Cloudflare Tunnel.

`cloudflared` runs as its own container on a dedicated Docker network that contains only the
factory container. Ingress publishes exactly one hostname to the factory, and everything else
gets a 404.

The isolation is the point. Run as a plain daemon on the host, cloudflared could route to
anything D002 can reach: the Traefik stack, other localhost ports, 192.168.1.240, 10.42.0.10.
Ingress rules alone are a policy promise. A dedicated Docker network is a boundary that holds
even if the tunnel config or the Cloudflare account is compromised.

Not routed through the existing Traefik on this host: it has no Let's Encrypt resolver and
serves built-in self-signed certs, which would mean certificate warnings on mobile and failed
TLS verification from cloud session hooks.

## Consequences
Better:
- No hosting cost; session data and specs stay on hardware we own.
- No inbound ports, no port forwarding, no firewall changes — cloudflared dials out.
- The blast radius of a tunnel compromise is one container, not the LAN.

Worse:
- D002 has to be awake, or the dashboard is down and hook reports are lost.
- Cloudflare terminates TLS and can see plaintext, including the prompt text and Claude's
  last message that the hook carries. Accepted for this content; it would not be for secrets.
- A public URL needs real access control. The dashboard password alone is thin, so Cloudflare
  Access is on the table.
- The image bakes `projects/` in at build time, so specs need `SPECS_GIT_URL` or a bind mount
  to update without a rebuild. Fly would have forced that work; self-hosting lets us defer it.

## Revisit if
D002 stops being reliably on, or the dashboard starts carrying content we would not want
Cloudflare to see. Then a small VPS we own becomes the better trade.
