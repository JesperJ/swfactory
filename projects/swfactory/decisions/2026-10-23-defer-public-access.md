---
title: Defer public access; run LAN-only for now
date: 2026-10-23
status: accepted
---

# Defer public access; run LAN-only for now

## Context
The dashboard runs in Docker at home and is reachable from mobile on the LAN. Two things are
still missing: checking it away from home, and letting sessions started from the Claude app
report in, since those run in Anthropic's cloud and can only reach a public URL.

Publishing it needs a public HTTPS endpoint. Three routes were examined.

**Cloudflare Tunnel** was the original plan, but it needs a domain whose DNS Cloudflare
controls, and there isn't one. A tunnel removes the dynamic-IP problem — it creates a CNAME to
`<tunnel-uuid>.cfargotunnel.com`, so the home IP is never in DNS and no dynamic DNS is needed —
but it does not remove the need for a name to attach to. A domain at Cloudflare Registrar costs
about $10/year at cost, with the zone active immediately. Cloudflare Access would then provide
real authentication in front of the dashboard. The cost is that Cloudflare terminates TLS and
can therefore read the prompt text and assistant messages the hook carries.

**Tailscale Funnel** needs no domain and is free on the personal plan. It publishes a node at
`<machine>.<tailnet>.ts.net` with an automatically provisioned certificate, and it is genuinely
public, so cloud sessions could reach it. TLS terminates on our own node rather than on
Tailscale's infrastructure, so the relay carries ciphertext only — better than Cloudflare on
exactly the privacy point the self-hosting decision flagged. Against it: the hostname is not
ours to choose, it is limited to ports 443, 8443 and 10000, bandwidth is capped and not
configurable, and there is no free authentication layer, so the dashboard password would be the
only gate on a public URL.

**Staying on the LAN** keeps everything as it is.

## Decision
Stay on the LAN. Do not publish the dashboard yet.

The part that already works — reading the dashboard from a phone at home, and sessions on this
machine reporting in — covers most of the original need. The remainder buys access away from
home and cloud-session reporting, at the price of either a recurring domain cost and handing
Cloudflare plaintext, or a public URL guarded by nothing but a four-word password.

Neither trade is worth making before the thing has proven itself in daily use.

## Consequences
- Sessions started from the Claude app or the web do not appear on the dashboard. Only sessions
  on this machine report. The inbox is therefore an incomplete picture, and that is expected.
- No cost, no third party in the path, no public attack surface.
- Nothing is wasted if this is revisited: the container architecture is unchanged, and
  publishing it later means adding one sidecar container on a dedicated network.

## Revisit if
The dashboard earns its keep on the LAN and the missing cloud sessions start to matter, or
checking it away from home becomes a real need rather than a nice idea. Tailscale Funnel is the
cheaper first experiment; a domain plus Cloudflare Access is the better end state if this
becomes something relied on.
