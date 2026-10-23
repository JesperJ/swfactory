---
title: Next as a table, and the lifecycle made visible
status: planned
priority: P1
summary: Next becomes a scannable table, and Projects gains a lifecycle strip showing the stages and where work sits.
---

# Next as a table, and the lifecycle made visible

## Why
Next currently answers one question well: what is the single most useful thing right now. That
was the right first shape, and it works.

But running several projects, the question changes. It stops being "what is the one thing" and
becomes "show me everything that wants doing, so I can pick". The present layout actively
fights that: one item gets a large hero, the rest get cards with the project in small grey text
under the title, priority is not shown anywhere at all, and four items fill a desktop screen.
At that density you cannot compare two items without reading both.

Priority exists in every spec and already affects ranking, and yet it is invisible in the view
whose entire job is deciding what to do next. That is the gap.

## What
Next becomes a table. One row per actionable item, dense enough that a dozen fit on a desktop
screen without scrolling, with the columns you actually compare on:

| | |
| --- | --- |
| **Do** | the verb — Answer, Review, Build, Plan, Spec — with its colour |
| **Project** | which project, as a column rather than buried in a subtitle |
| **Feature** | id and title |
| **Priority** | P1 / P2 / P3, visible and sortable |
| **Status** | the feature's lifecycle status |
| **Why** | the one-line reason it ranks where it does |
| | the start button, or the state of the job already queued |

Blocked items keep their own group at the bottom, as they do now.

On a phone a real table does not work: six columns at 390px means horizontal scrolling, which
is worse than what exists today. The phone keeps a row list, but each row gains the two things
it is missing — priority and project — as a compact line above the title. The same data, laid
out for the width.

The hero goes. Its job — "here is the one thing" — is served by the first row of a table sorted
the same way, and the space it costs is the reason only four other items fit.

### The lifecycle strip

Nothing in the dashboard shows the process itself. The statuses appear as coloured dots and
words, and what they mean, what order they come in, and which command moves a feature between
them is knowledge that lives only in `CLAUDE.md` and in my head.

So: a strip across the top of **Projects** — deliberately not Next, which is about what to do
rather than how work flows — drawing the six stages in order:

```
 idea ──▶ specced ──▶ planned ──▶ building ──▶ reviewing ──▶ done
   4         0           1            1            2          4
```

Each stage carries the number of features sitting in it right now, across every active project,
in the same colour that stage already uses everywhere else in the UI. A stage with nothing in it
is dimmed rather than hidden, so the shape of the process stays constant and legible.

That makes it two things at once: a diagram of how work moves, and a reading of where the work
actually is. A pile-up at `reviewing` is visible at a glance, which no current view shows.

Drawn as inline SVG, not an image file: it has to re-colour with the theme, scale to a phone,
and show live numbers.

## Acceptance criteria
- [ ] On desktop, Next renders a table with Do, Project, Feature, Priority, Status, Why, and an
      action cell
- [ ] At least 12 rows fit on a 1366×860 screen without scrolling
- [ ] Priority is visible on every row, on both desktop and phone
- [ ] The project is a column on desktop, not a subtitle
- [ ] Clicking a row opens that feature's spec; the action button still queues its job and is
      not triggered by clicking the row
- [ ] Rows can be sorted by priority as well as by the default ranking, and the choice persists
      across a reload
- [ ] On a phone, every row shows priority and project, with no horizontal scrolling
- [ ] Blocked items remain grouped last and keep their reason
- [ ] A queued, running, failed or stale job shows in the action cell exactly as it does now,
      including the failure reason and the retry button
- [ ] `npm run shoot` passes: no console errors, no overflow, tab bar on one row
- [ ] Projects shows a lifecycle strip with all six stages in order: idea, specced, planned,
      building, reviewing, done
- [ ] Each stage shows a live count of features in it across active projects, and the counts
      sum to the number of features in those projects
- [ ] A stage with no features is dimmed, not hidden — the shape of the process stays constant
- [ ] Each stage uses the same colour that status already uses elsewhere in the UI
- [ ] The strip re-colours in dark mode and fits a 390px screen without horizontal scrolling,
      wrapping rather than scrolling sideways (HTML and CSS, with the arrow as an inline SVG
      glyph — see the Plan for why not SVG throughout)
- [ ] The strip appears on Projects only, never on Next

## Out of scope
- Changing the ranking rules themselves. This is how the ranking is displayed, not what it
  decides. `featureAction` and `rankNext` are untouched.
- Filtering by project or status. The table makes the data visible; filtering is a separate
  feature if it turns out to be needed.
- Applying the table treatment to Inbox. The lifecycle strip is a separate thing and does go on
  Projects.
- Making the lifecycle strip interactive — clicking a stage to filter. It reads; it does not
  act. Filtering is the separate feature named above.
- Inline editing of priority.

## Plan
Two parts, independent of each other: the table replaces `renderNext`, the strip is added to
`renderProjects`. Neither touches ranking, matching, or the job pipeline.

**1. The server sends priority and status.** The spec assumed this was pure rendering. It is not:
`NextItem` carries `kind`, `action`, `command`, `title`, `project`, `reason` and `blocked` — but
not `priority` or `status`, so two of the table's columns have no data behind them. The client
*could* find them by looking the feature up in `state.projects`, and that is what makes this
worth a sentence: 005 round 1's blocking defect was precisely the UI deriving something the
server should have handed it, and the fix was to make the server the single source. Doing the
lookup client-side here would repeat the mistake a round of review already caught. So
`featureAction` returns `priority` and `status` alongside `command`, and `NextItem` carries them.
Session rows leave both blank, because a session has no lifecycle status of its own.

This overturns the spec's "No new data" assumption, which was wrong.

**2. The table.** `renderNext` loses the hero and emits one `<table>` on desktop. Columns: Do,
Project, Feature, Priority, Status, Why, action. `startControl` is reused untouched — it already
renders queued, running, failed-with-reason-and-retry, and stale, and nothing about those states
changes here.

Below 900px the same rows render as the current list, with a compact line carrying priority and
project above the title. One render function, two layouts, chosen by CSS rather than by
JavaScript measuring the viewport: a media query cannot disagree with itself about which one is
showing.

Row click opens the spec; the action cell stops propagation so tapping Build never also opens
the sheet. The sort toggle (ranking | priority) writes to `localStorage`, read once at startup,
and falls back to ranking when storage is unavailable or holds something unexpected.

**3. The lifecycle strip.** A pure `lifecycleCounts(projects)` returning one entry per stage in
`FEATURE_STATUSES` order, counting features in active projects. Pure, so it is testable without
a DOM, and so the "counts sum to the number of features" criterion is a unit test rather than a
screenshot.

Rendered at the top of `renderProjects` as HTML and CSS, with only the connecting arrow as an
inline SVG glyph — not the whole strip as SVG, which is what the spec said. Text inside SVG does
not reflow, cannot be selected, and needs manual sizing at every breakpoint; the criterion that
actually matters is that it re-colours with the theme, fits 390px, and shows live numbers, and
HTML meets all three more simply. On a phone the strip wraps to two rows rather than scrolling
sideways. That one criterion is reworded to match; the intent behind it is unchanged.

Risk worth naming: the table is denser, and density is where the earlier UX findings landed —
36px touch targets, actions reading as belonging to the wrong row. The phone layout is the part
most likely to come back from review, so it gets screenshotted at 390px before the desktop one
is called done.

## Tasks
- [ ] `featureAction` and `NextItem` carry `priority` and `status`; test that a ranked item
      exposes the same priority as its spec
- [ ] `lifecycleCounts`, pure, with tests for ordering, empty stages and the sum
- [ ] The desktop table in `renderNext`, reusing `startControl` unchanged
- [ ] The phone layout: priority and project on every row, no horizontal scroll
- [ ] Row click opens the spec; the action cell does not trigger it
- [ ] Sort toggle between ranking and priority, persisted in `localStorage`, defaulting safely
- [ ] The lifecycle strip on Projects: stages in order, live counts, empty stages dimmed
- [ ] Screenshots at 390px then 1366px, light and dark; `npm run shoot` clean

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **Default sort stays urgency-led, with priority as a visible column and the existing
  tiebreak.** Sorting strictly by P1/P2/P3 would put "Spec a P1 idea" above "Answer a session
  that is blocked on you", which is wrong: a blocked session is costing time right now, while a
  P1 idea is not. Priority becomes visible and sortable rather than becoming the primary order.
  If the intent was strictly priority-ordered, this is the line to overturn.
- **The hero is removed rather than kept above the table.** Keeping both means the top item
  appears twice, and the hero is the main reason so little fits on screen.
- ~~**No new data.**~~ Wrong, and corrected in the Plan: `NextItem` carries neither priority nor
  status, so two columns had nothing behind them. The server now sends both rather than the
  client looking them up — the same correction 005 round 1 forced.
- **Sort choice persists in `localStorage`**, not on the server — it is a per-device view
  preference, not shared state.

## Log
- 2026-10-23 Specced, from using Next across eleven features and finding it answers "what is the
  one thing" when the question had become "show me everything so I can pick". Written in a git
  worktree because a build session for 006 was running in the live checkout at the time — the
  collision 005's open question predicts, met in practice for the second time today.
- 2026-10-23 Added the lifecycle strip at the user's request. It is arguably a second feature —
  the table is about choosing what to do, the strip is about understanding how work moves — and
  the honest split would be 012 and 013. Kept together because both are read-only rendering of
  data already on the client, both land in `public/`, and splitting would mean two branches
  touching the same files within an hour of each other. Say so and it splits.
- 2026-10-23 Planned. Two independent parts: the table replaces the hero in `renderNext`, the
  strip is added to `renderProjects`. Neither touches ranking, matching or the job pipeline, and
  `startControl` is reused untouched so every job state keeps behaving as it already does.
  Planning found the spec wrong on one point: `NextItem` carries neither priority nor status, so
  two of the table's columns had no data. The client could look them up from `state.projects`,
  but that is exactly the pattern 005 round 1 flagged as a blocking defect — the UI deriving what
  the server should hand it. The server sends both instead.
  Also stepped away from "inline SVG" for the strip: text in SVG does not reflow or select, and
  the criterion's real intent — theme-aware, fits a phone, live numbers — is better served by
  HTML and CSS with the arrow as the only SVG. That criterion is reworded, not dropped. 8 tasks.
