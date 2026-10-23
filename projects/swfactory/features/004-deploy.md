---
title: Deploy so it's reachable from mobile
status: building
priority: P1
summary: Self-hosted in Docker on D002, published through a containerised Cloudflare Tunnel.
---

# Deploy so it's reachable from mobile

## Why
The point is checking in from my phone, and cloud sessions can only report to a publicly
reachable URL.

## What
The dashboard runs in Docker on D002 and is published through a named Cloudflare Tunnel.
`cloudflared` runs in its own container on a dedicated Docker network holding only the factory,
so the tunnel cannot route to the LAN or to the other stacks on this host.

See `decisions/2026-10-23-self-host-instead-of-fly.md` for why this replaced Fly.io.

## Acceptance criteria
- [x] Dashboard reachable from my phone on the LAN
- [ ] Dashboard reachable over HTTPS from outside the LAN
- [ ] `cloudflared` runs in its own container and cannot reach the LAN or other stacks on D002
- [ ] Only the dashboard hostname is published; every other hostname gets a 404
- [ ] Session data survives a container restart and a host reboot
- [ ] Sessions started from the Claude app report in and appear in the inbox
- [ ] Spec changes on `main` show up without rebuilding the image
- [ ] Access to the public URL is protected beyond the dashboard password, or that is a
      deliberate, recorded choice

## Out of scope
- Routing through the existing Traefik on this host (self-signed certs; see the decision record).
- Making the dashboard survive D002 being asleep.

## Open questions
- Which hostname, on which Cloudflare-managed domain?
- Cloudflare Access, or is the password enough for a URL nobody is told?

## Plan
Compose two containers on a dedicated network:

- `factory` — the existing image, no published host port once the tunnel is up.
- `cloudflared` — official image, runs a named tunnel, ingress maps one hostname to
  `http://factory:8080` with a `http_status:404` catch-all.

Only `cloudflared` joins any outward-facing network; the factory keeps the LAN port only until
the tunnel is verified. Specs move off the baked-in image copy to either `SPECS_GIT_URL` with a
read-only GitHub token or a read-only bind mount of this repo.

## Tasks
- [x] Build the image and run it on D002 with a persistent volume
- [x] Install reporting hooks on D002 and verify a session appears
- [ ] Create the named tunnel and its DNS record (needs a Cloudflare login)
- [ ] Write `compose.yml`: factory + cloudflared on a dedicated network
- [ ] Ingress: one hostname to the factory, catch-all 404
- [ ] Verify from outside the LAN that the hostname serves the dashboard over HTTPS
- [ ] Verify cloudflared cannot reach 192.168.1.240, 10.42.0.10 or the Traefik stack
- [ ] Repoint `FACTORY_URL` at the hostname and re-run `install-hooks`
- [ ] Set `FACTORY_URL` and `FACTORY_HOOK_TOKEN` in the cloud environment on claude.ai, and
      confirm a cloud session lands in the inbox
- [ ] Switch specs to `SPECS_GIT_URL` or a bind mount so they update without a rebuild
- [ ] Decide on Cloudflare Access and record the answer
- [ ] Verify persistence: restart the container, reboot the host, data intact

## Log
- 2026-10-23 Running on D002 in Docker on port 8088 with the `swfactory-data` volume.
  Image build verified, LAN access confirmed from mobile. Hooks installed globally and verified
  end to end (project matched by git remote, status transitions correct). Chose self-hosting
  over Fly; tunnel still to do.
