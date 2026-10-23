---
title: Deploy so it's reachable from mobile
status: planned
priority: P1
summary: Run the dashboard on Fly.io with a persistent volume and specs pulled from GitHub.
---

# Deploy so it's reachable from mobile

## Why
The point is checking in from my phone.

## Acceptance criteria
- [ ] Dashboard reachable over HTTPS from my phone
- [ ] Session data survives redeploys
- [ ] Spec changes pushed to GitHub show up within a minute

## Plan
Dockerfile + fly.toml in the repo. Volume at /data for SQLite and the specs checkout.
`SPECS_GIT_URL` with a read-only GitHub token; the server pulls every 60s.

## Tasks
- [ ] `fly launch` with the included fly.toml
- [ ] Set secrets: FACTORY_PASSWORD, FACTORY_HOOK_TOKEN, SPECS_GIT_URL
- [ ] Install hooks with the deployed URL and confirm a session appears
