---
title: Every row says where it stands, what you could do, and what I'd do
status: reviewing
priority: P1
summary: The board offers one button per feature and no idea why. It should show the options a feature actually has, mark one as recommended, and be willing to say "this is waiting on you".
repo: https://github.com/JesperJ/swfactory
---

# Every row says where it stands, what you could do, and what I'd do

## Why
This is the thing the project was started for. The original complaint, verbatim:

> It is easy to loose track on the higher level on what project/features you should do next so
> lots of time get's lost.

The board solved half of it — Next ranks work and 012 made it a table you can scan. The other
half is still missing, and one evening of real use produced seven instances of it:

- **011 offered "Review it" for a feature already reviewed twice, whose PR merged weeks ago**,
  and which was sitting on an unanswered question. Pressing it burned three reviewer agents on
  unchanged code. The reaction was *"011 does not have a PR — how TF should i review it?"*, which
  is the correct reaction to a button that is wrong.
- **016 at `reviewing` with a merged PR** looked identical to 011 at `reviewing` with no PR.
- **A feature with three review rounds and one with none** render the same line.
- **011 carried unticked acceptance criteria** and nothing said so.
- **A queued job shows a dead "Started" pill** while the Why column still reads "built, waiting
  on review" — the row contradicting itself about work in flight, with no way to look at it.
- **004, blocked, renders with an empty action cell.** "Blocked" is a decision nobody is being
  asked to make.
- **A deferred piece of work** — 015's job-table fix — exists only in a conversation.

Each was logged separately. They are one defect: **the row answers "what command can I queue?"
when the question is "what should I do?"** `featureAction` returns exactly one action, derived
from `status` alone, and `status` is far too coarse to carry the answer.

The structural cause is narrow and fixable. The dashboard reads **only frontmatter** —
`status`, `priority`, `blocked`, `lastLog`. It has never opened `reviews/`, never parsed an
acceptance criterion, never looked at a branch. It cannot distinguish the cases above because it
cannot see them. Widening the view means widening what the model knows, and that is one change
rather than seven.

## What

### The feature model learns what it is missing
`src/specs.ts` gains, per feature: the review rounds that exist and their dates, acceptance
criteria ticked and total, whether a `feature/<NNN>-*` branch exists and whether it is merged,
and the `question:` an escalation left behind. All of it derived from the repo — no new database
to keep in sync, and nothing that can disagree with what is on disk.

### A row offers options, not an action
Today a row has one button. It should name the moves actually available, with one marked:

```
015  Finished sessions stop crowding Next        reviewing
     3 rounds · round 3 predates the last build · 1 of 14 criteria unticked · PR #18 merged
     [Review again]  [Mark done]  ← suggested      Open PR ↗
```

`featureAction` is replaced by `featureOptions`, returning a small list. Exactly one carries a
recommendation and a one-line reason. The list is computed in one place and handed to the view,
the way 005 settled kind-to-command after the UI kept a second disagreeing copy.

### The recommendation may be "nothing"
The strongest option a row can offer is sometimes none. An escalated feature is waiting on a
person; a review that is running is waiting on an agent. Both must be able to say so and offer
no button that queues an agent, because the dashboard should never sell a way to avoid a
decision. This is the half of the old 017 that survives whole.

### A state line, not a status word
One line of facts under the title: rounds, criteria, branch and PR, and whether the newest round
predates the newest build. A status word is a label; this is the evidence a person would go
looking for.

### Work in flight stops lying
A row with a running job says what is running and for how long, and offers the way to look at it
— `tmux attach -t <name>` for a local session, which the dashboard already knows. The Why column
must not continue to claim "built, waiting on review" while a review is running.

## Acceptance criteria
- [x] `specs.ts` exposes, per feature: review rounds with dates, criteria ticked/total, branch
      existence, merged state, and `question:`
- [x] A malformed, missing or unreadable one of those yields a null and never an error, and a
      feature with none of them renders exactly as it does today
- [x] `featureOptions` returns the available moves for a feature, with exactly one recommended
      and a reason for it
- [x] The rules live in `src/next.ts` with tests, not in the view — no second copy in `app.js`
- [x] A feature at `reviewing` with an unanswered `question:` offers **no** agent-queuing action,
      and its row shows the question
- [x] A feature whose newest round predates its newest build does not recommend "Mark done"
- [x] A feature with unticked criteria does not recommend "Mark done", and the row says how many
- [x] A feature with a merged PR and a stale round recommends reviewing, not building
- [x] A row for a feature with an open PR links to it; a merged one says so
- [x] A blocked feature offers something — at minimum unblocking it — rather than an empty cell
- [x] A row with a running job says what is running and since when, and never simultaneously
      claims the work is waiting to start
- [x] A local session is reachable from its row by the `tmux attach` command that opens it
- [x] Verified at 390px and 1280px, light and dark, that the state line and options are legible
      and do not push the table past one screen of rows
- [x] `approve` writes `question:` on escalate and clears it on pass and rework

## Out of scope
- Answering a question from the dashboard. Reading it is the gap; a reply box is a bigger
  feature and probably the next one.
- Driving git from the dashboard — merging, pushing, branching. The merge stays the user's, and
  `JOB_COMMANDS` stays deliberately short because it is the blast radius of a compromised page.
  A **link** to a PR is not an action.
- Calling the GitHub API. Branch and merge state come from the local repository, so the board
  keeps working with no network and no token.
- Re-ranking Next. The order is 008's and it works; this changes what a row *says*, not where it
  sits.
- Changing how `approve` words an escalation. Two reviewers confirmed the one-question format is
  right.

## Open questions
These are the calls I made. Each is a decision to overturn, not a question to answer.
- **Options with one recommended, rather than one button.** A single button has to be right
  every time or it teaches you to distrust it, which is what happened with 011. A short list
  with a recommendation degrades gracefully: a wrong recommendation beside a correct option is
  a bad suggestion, not a trap.
- **Everything derived from the repo, nothing stored.** A cache would be a second copy of the
  truth, and this evening produced four comments that claimed something their code did not do.
  Derived state cannot drift from what is on disk.
- ~~**Branch and merge state from local git**~~ — **wrong, and planning caught it.** The
  container has the git binary and no repository: only `projects/` is mounted, read-only. The
  PR *link* still comes from the Log as assumed, which is free. Merge state now arrives from the
  runner, which does have the repo. See `decisions/2026-10-27-vcs-facts-come-from-the-runner.md`.
- **The state line is facts, not a verdict.** "3 rounds · 1 of 14 unticked" rather than "nearly
  done". The verdict belongs in the recommendation, where it is labelled as one.
- **Assumed this supersedes the narrower 017** (escalations reaching the dashboard), rather than
  shipping that first and this after. The mechanism is the same — the dashboard reading more
  than frontmatter — and splitting it would mean touching `specs.ts`, `next.ts` and the row
  renderer twice. The escalation work survives intact as criteria here.

## Plan
The whole feature rests on one observation: almost everything the board is missing is already
in files it reads. `loadFeatures` calls `matter()` on every spec and keeps the body, so
acceptance criteria, the PR link and `question:` cost no extra IO at all. Review rounds cost one
`readdirSync` per project. Only branch and merge state needs anything new, and that is the one
thing the container genuinely cannot see.

**Reading** — `src/specs.ts`. `Feature` gains `criteria: {ticked, total}`, `rounds: {n, date}[]`,
`prUrl`, `question` and `vcs`. Each parser returns null or an empty value on anything
malformed, because this runs on every `/api/state` and a spec someone is halfway through
editing must not take the dashboard down.

**Deciding** — `src/next.ts`. `featureAction` becomes `featureOptions`, returning the moves a
feature actually has plus which one is recommended and why. The rules that matter are the ones
the board got wrong this week: a feature whose newest round predates its newest build does not
recommend "Mark done"; one with unticked criteria does not either; one with an unanswered
`question:` offers no action that queues an agent. `rankNext` ranks on the recommended option,
so 008's order is unchanged and the existing tests keep passing.

**Showing** — `public/app.js`. The row gains a state line of facts and renders the options with
the recommended one marked. 005's lesson applies directly: the UI is handed the options and
never derives them, because a second copy here is exactly how "Review it" once queued a build.

**Merge state** — the runner. It already polls with a token and already asks git about merged
branches in `pruneWorktree`. It reports `{branch, exists, merged}` per feature; the dashboard
stores it and renders "unknown" as nothing rather than as a guess. This is last on purpose:
everything above ships and is useful without it.

**Which test proves what.** Parsing is unit-tested against fixture markdown in
`test/specs.test.ts`, including a half-written spec. `featureOptions` gets a case per rule in
`test/next.test.ts` — stale round, unticked criteria, open question, blocked, running job — plus
a regression that a feature with none of the new facts produces exactly today's single option.
The endpoint gets auth and shape tests in `test/server.test.ts`. The view is checked with
`npm run shoot` at 390px and 1280px, light and dark.

**Risks.** The honest one is that a recommendation can be confidently wrong, which is worse than
no recommendation — mitigated by always rendering the alternatives beside it and never hiding a
legal move. Second, `loadProjects` is on the hot path; the added work is one readdir and
regexes over strings already in memory, and if that ever matters the fix is caching, not less
truth. Third, the row is already dense at 390px, so the state line must be one line and the
options must wrap, which 012's overflow sweep will catch.

## Tasks
- [x] `specs.ts`: parse acceptance criteria into `{ticked, total}` and `question:` from
      frontmatter, both from data already read; malformed input yields nulls, never a throw
- [x] `specs.ts`: collect `reviews/<NNN>-round-<n>.md` per project and attach rounds with their
      dates to each feature
- [x] `specs.ts`: extract the newest PR link from the spec's Log
- [x] `next.ts`: `featureOptions` replacing `featureAction` — a list, one recommended, with a
      reason; every existing `next` test still passes
- [x] `next.ts`: the three rules that were wrong — stale round, unticked criteria, and an
      unanswered question offering no agent action
- [x] `server.ts` + `app.js`: the Projects view and the feature sheet use the options list, so
      no second copy of these rules exists
- [x] `app.js`: the Next row renders the state line and the options, recommended one marked,
      with a PR link where there is one
- [x] `app.js`: a row with a running job says what is running and since when, offers
      `tmux attach`, and stops claiming the work is waiting to start
- [x] `app.js`: a blocked feature offers unblocking rather than an empty cell
- [x] `factory.md`: `approve` writes `question:` on escalate and clears it on pass and rework
- [x] The runner reports branch and merged state; the dashboard stores it and renders unknown as
      nothing
- [x] Verify at 390px and 1280px, light and dark, that nothing overflows and the table still
      scans

- [x] Round 1 blocking: an escalated feature must offer no agent-queuing action **at every
      width**. `featureOptions`' `reviewing` case adds `approve` (command `review`) regardless of
      `f.question`; gate it there, in `next.ts`, not in CSS. The `>=1100px`-only
      `.btn:not(.primary){display:none}` in `styles.css` both masked this above 1100px and left a
      live Review button on a phone — and hiding legal moves contradicts this spec's own stated
      mitigation, so decide that rule deliberately rather than by breakpoint.
- [x] Round 1 blocking: a **queued** job must not claim to be running. `public/app.js:296`
      treats queued, claimed and running alike and renders "<Action> running. started Xm ago"
      beside a "Queued Xm" pill — the row contradicting itself, which is criterion 11's exact
      failure one job-status earlier.
- [x] Round 1 blocking: wire the Projects view and the feature sheet to `options`. `featureRow`
      and the sheet still call `startControl(featureItem(...))`, which renders nothing when the
      command is null or the feature is blocked — so "Mark done", "Answer" and a blocked feature
      all render as an empty cell there. The task was ticked without this being done.
- [x] Round 1 minor: `"never reviewed"` is printed twice in the Why column — once as the
      recommendation's reason (`next.ts:239`) and once as a fact (`featureFacts`).
- [x] Round 1 minor: an in-progress job is coloured with `class="failed"` (`--needs`, the failure
      colour). Give a running job its own colour.
- [x] Re-verify criteria 5, 10 and 11 in a browser at 390px, not only at >=1100px — each of the
      three blocking findings hid behind a width or a view the first pass never opened.

## Log
- 2026-10-26 Specced narrowly first, as "an escalation reaches the dashboard", after 011's round
  2 found that an escalated feature and an unreviewed one render identically. Widened the same
  evening on the observation that it covered one of seven instances of the same defect logged in
  a single session, and that the underlying cause — the dashboard reading only frontmatter —
  is one change rather than seven. The narrow spec is preserved in git history at
  `017-escalation-question.md`; its `question:` mechanism and four of its criteria are carried
  here unchanged.
- 2026-10-27 Planned. 12 tasks, ordered so the parsing lands first — most of what the board
  is missing is already in files it reads, so criteria, the PR link and `question:` cost no IO
  at all and rounds cost one readdir per project.
  Planning overturned one of the spec's open questions. It assumed branch and merge state could
  come from local git; the container has the git binary and no repository, because only
  `projects/` is mounted. That is recorded as a decision rather than a footnote, since it also
  rules out mounting `.git` into a web-reachable process. Merge state now comes from the runner,
  last in the order, so everything before it ships without it.
- 2026-10-27 Building on `feature/017-what-should-i-do`.
- 2026-10-27 Built, 12 tasks. 177 tests, typecheck clean, no overflow at 15 widths.
  Three measurements drove the layout rather than taste, and each corrected a guess. Options
  stacking made a plain row **129px** against the 51px it had been, which breaks the density
  012's criterion protects. A facts line of its own cost another 16px, so the facts moved into
  the Why column, where "why is this row here" already lives. And under `table-layout: fixed`
  the action cell rendered on top of the Why column, so the table shows the recommended move
  plus the pull request while the stacked layout shows every option and labels the suggested
  one. Rows are back to 51px.
  Two of my own checks were wrong before the third was right: comparing control edges against
  the neighbouring cell's border box counted padding as a collision, and a Range over the Why
  text measures where text *would* end rather than where it is painted, since the cell
  ellipsises. The check that holds compares against the content box, and passes at 1100, 1280,
  1366 and 1920.
  Verified in a browser rather than by unit test alone: an escalated feature renders **Answer**
  with the question as its reason and queues nothing; a running job says "Plan running. started
  7m ago" and offers `tmux attach`, where the row previously showed a dead pill beside a Why
  column still claiming the work had not begun; a blocked feature offers Unblock and no agent.
  The runner's report was driven end to end against this repo: 8 branches read correctly, 007
  and 017 open and the rest merged, and rows with a PR in their Log then read "PR merged".
  The endpoint test caught `machineRoute` not actually having been updated, which would have
  left the route behind UI auth and silently 401ed the runner every tick.
- 2026-10-27 Review round 1 — `reviews/017-round-1.md`. Code 1 blocking / 3 minor, security
  0 blocking / 2 minor, UX 3 blocking / 2 minor; 177/177 tests pass and typecheck is clean.
  Reworked rather than escalated: all three blocking findings are local and this is round 1.
  Code and UX found the **same** first defect independently — the `reviewing` case in
  `featureOptions` never gates the agent-queuing `approve` option on `f.question`, so an
  escalated feature shows a live "Review" button beside "Answer" below 1100px, which is the 011
  failure this feature exists to kill. The other two: a **queued** job's Why column claims
  "Review running. started 39m ago" beside a "Queued 39m" pill, and the Projects view and the
  feature sheet were never wired to `options` despite that task being ticked, so "Mark done",
  "Answer" and a blocked feature all render as the empty action cell this spec opens by
  complaining about. Criteria 5, 10 and 11 unticked accordingly.
  Security found nothing blocking: the new `POST /api/vcs/:project` sits behind the runner token
  with a test pinning that a UI cookie and the hook token both 401, and `JOB_COMMANDS` is
  unwidened. Every blocking finding hid behind a width or a view the build's own verification
  never opened.
- 2026-10-27 Round 1 reworked. 178 tests, typecheck clean, no overflow at 15 widths, a plain
  table row still 51px. All three blocking findings fixed and verified in a browser against
  fixture specs that actually hold the states — an escalated feature, a blocked one, a feature
  whose recommended move is "Mark done", and a job queued with no runner to claim it — because
  each of the three hid behind a width or a view the first pass never opened.
  The escalation gate went into `next.ts`, not the stylesheet: at 390px and 1280px, in light
  and dark, in Next, Projects and the sheet, an escalated feature now renders no `data-start`
  element at all. Checking the DOM rather than what is visible is deliberate — round 1's bug
  was a real button that a `min-width: 1100px` rule happened to hide.
  Kept that rule, having looked at it again. The table shows the recommended move and the pull
  request because three variable-width controls do not fit a 51px row; every option is on the
  row below 1100px and in the feature sheet, which is now wired to the same list. Nothing legal
  is hidden everywhere — and with the gate in the data layer there is no illegal option left to
  hide.
  A queued job now says "Build queued. waiting for a runner for 2m" beside its "Queued 2m" pill
  instead of claiming it started, offers no `tmux attach` to a session that does not exist yet,
  and wears the working colour rather than the failure one.
  Pull request: https://github.com/JesperJ/swfactory/pull/20
