---
title: An escalation reaches the dashboard, not just the terminal
status: specced
priority: P1
summary: The one question an escalation exists to ask is invisible in Next, and the button it offers burns three reviewer agents on unchanged code.
repo: https://github.com/JesperJ/swfactory
---

# An escalation reaches the dashboard, not just the terminal

## Why
011's round 2 found this, and 011 was passed on the decision to spin it out rather than widen.

`approve` has three outcomes. Two of them move the feature: pass sets `done`, rework sets
`building`. The third — escalate — deliberately leaves the status at `reviewing`, because the
feature is not going anywhere until a human answers one question. So `reviewing` now means two
unrelated things, and `src/next.ts:172-174` cannot tell them apart:

```ts
case "reviewing":
  return of("approve", "Review", 2.5, "built, waiting on review");
```

Every feature at `reviewing` gets that identical row. A feature nobody has looked at and a
feature sitting on an unanswered question from round 3 are the same line in Next, with the same
reason and the same button. During 011's own round 2 three features rendered indistinguishably
this way.

Two concrete costs, not one:

**The question is unreadable away from the terminal.** It is written into the spec's `## Log`,
at the bottom of a history that runs to hundreds of lines for a feature like 015. Finding "the
one specific question" means reading exactly the findings-dump the escalation format exists to
replace, just relocated. The chat reply that carries it properly depends on a session URL, and
`hooks/factory-report.sh:16-22` only sets one for web and mobile sessions — a local terminal
session gets `url: null` and `public/app.js:143-144` then renders a bare "a session is blocked
on you" with no link and no hint of the content. On a phone, which is the device this dashboard
is built for, the question cannot be reached at all.

**The obvious tap does the wrong thing.** The row's action is "Review it", which queues a fresh
`/factory review` — three reviewer agents, on code that has not changed since they last read
it, producing a round file that can only repeat the finding that caused the escalation. 015
escalated after three rounds precisely because more rounds were not the answer; the UI's one
affordance is to buy a fourth.

`escalated` is missing from `NextKind` (`src/next.ts:25`), so the dashboard has no way to say
"this one is waiting on you" about a feature, only about a session.

## What
The escalation's question stops being prose in a log and becomes state the dashboard reads.

**`approve` records the question in frontmatter.** Escalating writes a `question:` field holding
the single question it just asked. Pass and rework clear it, because the thing being waited on
is gone. Frontmatter is already the machine-read surface in this repo, and this keeps the
question in exactly one place — the spec — rather than duplicating it into a database the
dashboard would then have to keep in sync.

**`escalated` becomes its own kind.** A feature at `reviewing` with a `question:` is `escalated`;
one without is `approve`, ranked and worded exactly as today. The new kind ranks above
`approve` — a question that has been asked and not answered blocks more than work that has not
been looked at — and below a blocked session, which is a live agent waiting.

**No sub-command can answer it.** `KIND_COMMAND.escalated` is `null`, the same as `answer` and
`review`. The row shows the question and offers no button that would run an agent. That is the
point: the escalation is a decision, and the UI should not sell a way to avoid making it.

**The row says what is being asked.** The question is the row's reason, truncated to fit at
375px, with the full text in the spec sheet one tap away. Reading it on a phone is the
requirement; answering it stays in the terminal.

## Acceptance criteria
- [ ] `approve`'s escalate branch writes the question to the spec's `question:` frontmatter;
      pass and rework clear it
- [ ] `src/specs.ts` parses `question:`; absent, empty or malformed yields `null`, never an error
- [ ] `escalated` is a distinct `NextKind` with `KIND_COMMAND.escalated === null`
- [ ] A `reviewing` feature with a `question:` ranks above one without, and below a blocked
      session
- [ ] Its Next row's reason is the question itself, not "built, waiting on review"
- [ ] Its row offers no action that queues an agent
- [ ] A `reviewing` feature with no `question:` ranks, reads and behaves exactly as today —
      the existing `next` tests pass unchanged
- [ ] The question is legible in Next at 375px and 1280px, light and dark, without opening the
      spec sheet
- [ ] `CLAUDE.md`'s command table records that `approve` escalating leaves the feature at
      `reviewing`

## Out of scope
- Session URLs for sessions started in a local terminal. That is 009, and it is the other half
  of why an escalation is hard to find — but it is about sessions, not features.
- Answering the question from the dashboard. Reading it is the gap; a reply box is a different
  feature and a larger one.
- Changing how escalations are worded. `approve` already asks one question with options and a
  recommendation; 011's round 2 confirmed that across five features.
- Notifying on escalation. Push is 006's.

## Open questions
- Assumed a `question:` frontmatter field over deriving escalation from the number of round
  files in `reviews/`. Counting files infers the state from a side effect and would call a
  feature escalated the moment a round file existed; a field says it outright and is cleared by
  the thing that resolves it.
- Assumed the question is cleared by pass and rework rather than kept as history. The Log
  already holds the history; a stale `question:` would be a lie the dashboard repeats.
- Assumed ranked above `approve` and below `answer`. A live agent waiting costs more than a
  feature waiting, because the agent is burning a session.
- Assumed truncation in the Next row with the full text in the spec sheet, rather than wrapping
  the whole question into the table. A table row that grows to five lines breaks the scan the
  Next view exists for.
- Assumed this does not need the two-round cap to change. The cap works; this is about what
  happens after it fires.
