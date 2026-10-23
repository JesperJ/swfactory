---
title: Notify through ntfy rather than Web Push
date: 2026-10-23
status: accepted
---

# Notify through ntfy rather than Web Push

## Context
The dashboard knows the moment a session blocks or a queued job fails, and says nothing. Web
Push is the obvious mechanism: it is the browser standard, it needs no third party, and the
payload never leaves infrastructure we control.

It also cannot work here. Web Push requires a service worker, and service workers require a
secure context. The dashboard is served over plain HTTP on the LAN, and the decision to defer
public access means there is no HTTPS origin to register one against. Web Push is therefore
blocked on a feature that was deliberately parked with no date.

## Decision
Send notifications as an outbound HTTPS POST to ntfy, with the phone subscribed to one topic.

The dashboard needs nothing it does not already have: no certificate, no inbound route, no
service worker, no origin at all. It works on the LAN today and keeps working unchanged if
public access never happens.

The sender sits behind a one-method interface. A Web Push sender can be added beside it the day
there is an HTTPS origin, without touching the rules that decide what is worth notifying about.

## What this costs
An ntfy topic is a bearer secret in URL form: anyone who learns it can subscribe to it, and
hosted ntfy.sh can read everything that passes through. So the notification body is deliberately
thin — project, feature, host, and a link. Never prompt text, never Claude's message, never a
filesystem path. Someone who guesses the topic learns that a project exists and that it needed
attention, which is a real leak but a small and uninteresting one.

That constraint is enforced in one place: a single pure function builds every notification body.
It is a property of the code rather than a rule each call site has to remember.

## Consequences
Better:
- Works today, on plain HTTP, with no infrastructure.
- Survives the dashboard moving, or never moving, behind HTTPS.
- Trivial to test: the rules are pure and the sender is an interface.

Worse:
- A third party sees notification metadata, and the topic is the only thing protecting it.
- The useful detail — what Claude is actually asking — cannot be in the notification, so the
  notification can only ever say "go and look".
- One more service that can be down, though a failed send is logged and never blocks a request.

## Revisit if
Public HTTPS lands, in which case Web Push becomes available and keeps the payload private — add
it as a second sender rather than replacing this one. Or if the terse body proves too thin to
act on, in which case self-hosting ntfy behind that same HTTPS is what makes a fuller body safe.
