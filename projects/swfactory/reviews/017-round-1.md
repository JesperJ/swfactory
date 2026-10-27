---
feature: 017-what-should-i-do
round: 1
date: 2026-10-27
branch: feature/017-what-should-i-do
base: main
blocking: 2
minor: 5
---

# 017 — review round 1

Three reviewers in parallel against `feature/017-what-should-i-do` (merge-base `8d0b9dc`).
Checks, run independently by two of them: `npm test` **177/177 pass**, `npm run typecheck`
**clean**, `npm run shoot` no console errors and no overflow at any of 15 widths.

Both code and UX found **the same blocking defect independently**: the `reviewing` case in
`featureOptions` never gates the agent-queuing "Review" option on `f.question`, and the CSS that
hides non-recommended buttons only applies at ≥1100px — so on a phone an escalated feature shows
a live "Review" button beside "Answer". That is the 011 failure this feature exists to kill.

## Code review

### Blocking

**1. An escalated feature still offers a clickable agent-queuing button — the exact 011 bug this
feature exists to kill.**
- `src/next.ts:218-220` adds the `"escalated"` option (`command: null`) when
  `f.question && f.status === "reviewing"`, but the `case "reviewing":` block at
  `src/next.ts:231-239` unconditionally still calls `add("approve", ...)`, whose `command` is
  `"review"` (`KIND_COMMAND.approve = "review"`, line ~50). Nothing in the switch skips this when
  `f.question` is set — only the separate `"finish"`/Mark-done branch checks `!f.question`.
  Verified directly: `featureOptions({status:"reviewing", question:"...", rounds:[...]}, now)`
  returns both `{kind:"escalated", command:null, recommended:true}` and
  `{kind:"approve", action:"Review again (round 2)", command:"review", recommended:false}`.
- `public/app.js:171-178` (`optionControls`) renders **every** entry in `item.options`, not just
  the recommended one: any option with a non-null `command` becomes
  `<button data-start="…/review">…</button>` (line 178). Clicking it (handler at
  `public/app.js:710-731`) POSTs `/api/jobs` with `command:"review"`, queuing a review agent.
- `public/styles.css:614`
  (`.nexttable .c-action .opts .btn:not(.primary) { display:none; }`) only suppresses this
  non-recommended button at `@media (min-width: 1100px)`. Below that breakpoint — i.e. the
  dashboard's own stacked/phone layout, and the exact 390px width the project's CLAUDE.md
  requires checking — the button renders live and clickable.
- Sequence that reproduces it: a `reviewing` feature with an unanswered `question:`
  (e.g. 015 mid-escalation), viewed at <1100px width. The row shows "Answer" (inert text,
  correct) **and** a live "Review again" button. Tapping it queues a reviewer agent on
  unchanged, already-escalated work — the precise failure the spec's Why section describes
  ("Pressing it burned three reviewer agents on unchanged code").
- This directly fails the named acceptance criterion: *"A feature at `reviewing` with an
  unanswered `question:` offers **no** agent-queuing action."* The build Log's manual
  verification ("an escalated feature renders Answer... and queues nothing") was evidently only
  exercised at the widths it names elsewhere (1100/1280/1366/1920px), all ≥1100px, where the CSS
  happens to mask the bug.

### Minor

**2. `roundIsStale` can be fooled by a Log entry that isn't a rebuild.** `src/next.ts`
(`roundIsStale`) treats any `lastLog` date after the newest round's `Date:` as evidence of a
later build, but `.claude/commands/factory.md`'s `approve` step (pass/rework/escalate) also
writes a Log line after a review. If that Log entry lands a day after the round file's date
(review one day, decision logged the next), the round is marked stale and the recommendation
reason changes even though no rebuild happened. Doesn't currently manifest in this repo's own
specs (015's round-3 date and its Log entries are same-day), so it's latent rather than observed.

**3. `prUrlFrom` isn't actually scoped to the Log section** (`src/specs.ts`, `prUrlFrom`),
despite its comment ("The newest pull request link in the Log"). It regexes the whole spec body
for `.../pull/\d+` links and takes the last match. It currently gives correct answers only
because every spec in this repo keeps `## Log` as its final section; a PR link appearing after
Log in some future spec would be picked over the real one.

**4. Projects view and feature sheet don't render `options`/`facts` despite the Tasks checklist
marking that done.** `featureRow` (`public/app.js:385-394`) and the feature-sheet control
(`public/app.js:516`) still call `startControl(featureItem(...))`, which only consumes the single
`feature.next` and renders nothing (`startControl` returns `""`) when its command is null. For an
escalated feature this means the Projects view shows an empty action cell and no question text at
all — not a duplicated rule, and not one of the 13 enumerated acceptance criteria, but it
contradicts the Tasks/Log claim that these views use the options list, and reintroduces the
"empty action cell" complaint pattern for a new case (escalation) in a secondary view.

### Per-criterion verdict
1. `specs.ts` exposes rounds/criteria/branch/merged/question — **met**.
2. Malformed/missing input yields nulls, never throws; plain feature renders as before — **met**
   (`test/specs.test.ts`, code reads defensively; unreadable spec file is skipped rather than
   crashing the whole `/api/state`).
3. `featureOptions` returns a list with exactly one recommended + reason — **met** (mechanic
   itself works; see finding 1 for a rule that's wrong).
4. Rules live in `next.ts`, no second copy in `app.js` — **met**.
5. `reviewing` + unanswered `question:` offers no agent-queuing action, row shows the question —
   **not met** (finding 1).
6. Stale round doesn't recommend Mark done — **met** (`test/next.test.ts`, "Mark done is offered
   only when it would be honest").
7. Unticked criteria don't recommend Mark done, row says how many — **met** (same test;
   `featureFacts`).
8. Merged PR + stale round recommends reviewing, not building — **met** (structural:
   `featureOptions` switches solely on `f.status`, and the `reviewing` branch never offers
   `build`; no dedicated combined test exists, but no path contradicts it).
9. Open PR links; merged PR says so — **met** (`test/next.test.ts` "a pull request is a link,
   never an action").
10. Blocked feature offers something (unblock) — **met** (`test/next.test.ts`, code clears other
    options and adds `unblock`).
11. Running job says what/since, never claims work hasn't started — **met** by code reading
    (`public/app.js` `runningControl`/`row`), not covered by an automated test (no app.js test
    suite exists).
12. Local session reachable via `tmux attach` — **met** (`public/app.js` name formula matches
    `scripts/runner.ts:sessionName`).
13. Verified at 390/1280px, light/dark, no overflow — **not independently verifiable** (requires
    a live browser); the layout/overflow claims in the Log are plausible, but see finding 1 for a
    width-dependent interaction defect the stated verification likely missed.
14. `approve` writes `question:` on escalate, clears on pass/rework — **not verifiable from the
    diff** (this is a natural-language instruction to an agent in `.claude/commands/factory.md`,
    not executable code); the wording is internally consistent with the intended behavior.

## Security review

**No blocking findings.** This diff's new attack surface is handled correctly — the auth
boundary, input validation, and every DOM sink that touches spec-derived or runner-derived
strings were verified.

Verified safe, with the concrete reasoning:

- `src/server.ts:151-154` — `/api/vcs/*` is added to `machineRoute` and the new
  `POST /api/vcs/:project` handler (`src/server.ts:233-251`) sits behind
  `requireBearer(cfg.runnerToken)`, not the UI cookie and not the hook token.
  `test/server.test.ts:498-521` exercises exactly this (no credential → 401, UI cookie → 401,
  hook token → 401, runner token → 200), so this isn't just read-correctly-by-me, it's pinned by
  a test.
- `src/server.ts:235-247` — `project` path param is constrained to `/^[\w.-]+$/` before use as a
  `Store` key; `feature` inside the body gets the same regex; malformed rows (`null`, missing
  `feature`, wrong types) are filtered out rather than stored, confirmed by the "junk entries are
  dropped" test case. No path traversal is possible since the project string is only ever used as
  a Map-key fragment (`src/db.ts:249-257`), never as a filesystem path.
- `scripts/runner.ts:420-434` (`branchFacts`) — branch names come from
  `git branch --list feature/*` via `execFileSync` with an argv array
  (`scripts/runner.ts:92-96`), never shell-concatenated, and the feature's branch is matched by
  exact string equality against the enumerated list, not interpolated into a git invocation. No
  injection path from a crafted feature slug into a shell command.
- `src/specs.ts:118-121` (`prUrlFrom`) — the PR link is extracted with
  `https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+`, which forecloses `javascript:`/`data:`
  schemes and arbitrary hosts. `public/app.js:172-173` renders it as `href="${esc(o.href)}"` with
  `target="_blank" rel="noopener"` — scheme is already constrained upstream, and `rel="noopener"`
  closes the reverse-tabnabbing angle.
- `src/next.ts:219-220` — the escalation `question:` frontmatter string (untrusted,
  PR-controlled) flows into `NextItem.reason` and is rendered only via `esc(i.reason)`, both as
  text (`public/app.js:304`) and inside a `title` attribute (`public/app.js:323`), and `esc`
  (`public/app.js:33-34`) escapes `& < > " '` — correct for both text and attribute context. It
  is not rendered anywhere unescaped; `optionControls` itself never prints `o.reason` at all.
- `public/app.js:195-200` (`runningControl`, the `tmux attach` line) — the session name is built
  only from `item.projectSlug`/`item.feature` (filesystem-derived identifiers, not arbitrary spec
  body text), further stripped to `[\w.-]` and then HTML-escaped before being placed in a
  `<code>` element as inert, user-selectable text. It is never passed to anything that executes
  it — a compromised page can at most display a wrong string for the user to paste, which is
  outside this feature's threat model anyway (the user already trusts their own terminal).
- `JOB_COMMANDS` (`src/db.ts:51`) is unchanged — still `["plan", "build", "spec", "review"]`. The
  new `NextKind`s (`escalated`, `finish`, `unblock`, `link`) all map to `command: null` in
  `KIND_COMMAND` (`src/next.ts:46-50`), so none of the new option kinds can ever populate a
  `data-start` button (`public/app.js:174-178` only emits a button when `o.command` is truthy)
  and `POST /api/jobs` independently re-validates with `isJobCommand` (`src/server.ts:206`)
  regardless of what the client sends. The blast radius the spec calls out stays exactly as
  narrow as before.

### Minor

**5. `src/server.ts:245** (`branch: typeof f.branch === "string" ? f.branch : null`): this is the
one field in the new endpoint's payload that isn't held to the same `/^[\w.-]+$/` contract as
`project`/`feature` — it accepts any string from the runner. Today it's inert: `vcs.branch` is
stored (`src/db.ts:249-257`) but never read by `public/app.js` or `src/next.ts` (confirmed by
grep — only `.merged`/`.exists` are consumed). Not worth fixing now since nothing renders it, but
if a future row ever prints `f.vcs.branch` directly, it should go through `esc()` like everything
else here, since the string still ultimately traces back to whatever a local branch happens to be
named.

**6. `src/server.ts:239-247` / `src/db.ts:249-252`:** `setVcs` has no cap on `body.features` array
length or per-field string size, so a caller holding the runner token could post an oversized
payload and grow the in-memory `Map` unboundedly. Given the runner token is already the same
high-trust credential that can queue arbitrary `plan`/`build`/`spec`/`review` jobs, and this is a
self-hosted single-user LAN tool per the project's own stated threat model, this isn't worth
guarding against — flagging only for completeness, not as something to fix.

No action needed before merge on the security axis.

## UX review

Verified: `npm test` (177/177 pass), `npm run typecheck` (clean), `npm run shoot` (no console
errors, no overflow at any of the 15 widths, tab bar stays one row). An isolated dev server was
stood up from this exact checkout (bypassing a shared, flaky proxy on the usual port) and driven
with Playwright to inspect real rendered output, including a deliberately queued job, since this
is state the static screenshots don't exercise.

**The core idea works where it's been applied.** The Next table's recommended-option treatment is
good: a null-command move (e.g. "Mark done") renders as a dashed "it's yours" box labelled
`· suggested`, a real recommended move is a solid button, alternatives are present but visually
secondary, and a PR shows as "Open PR ↗" or "PR merged". That part solves the stated problem.

### Blocking

**7. An escalated feature still offers a real "Review" button — on phone, where the spec
explicitly forbids it.** `src/next.ts:230-236`, the `reviewing` case unconditionally adds the
`approve`/"Review again" option with a real `command: "review"`, regardless of `f.question`. Only
`finish` is gated by `!f.question` (line 241). Confirmed by calling `featureOptions()` on an
escalated feature: it returns
`[{kind:"escalated", action:"Answer", command:null, recommended:true}, {kind:"approve", action:"Review", command:"review", recommended:false}]`.
In `public/app.js`, `optionControls` (line ~162) only hides non-primary buttons at `≥1100px`
(`styles.css`, `.nexttable .c-action .opts .btn:not(.primary)`); below that breakpoint — i.e. on
the phone this dashboard is mostly used from — the "Review" button renders as a normal, tappable,
agent-queuing control right next to "Answer". Tapping it queues a real review job via
`POST /api/jobs`, which the server accepts (`isJobCommand` is a shape check only, no escalation
awareness). This is exactly the failure the spec's Why section names — "011 offered 'Review it'
for a feature... sitting on an unanswered question... burned three reviewer agents" —
reintroduced at the one moment the spec says it must never happen.
*(Same defect as code finding 1, found independently.)*

**8. A merely-queued job's Why text claims it's "running."** `public/app.js:296` computes
`running` as "not done, not stale, not failed" — true for `queued`, `claimed`, and `running`
alike — then line 303 unconditionally renders `"<Action> running. started Xm ago"`. With a job
queued and left unclaimed (no runner picked it up), the row showed, in bold orange: **"Review
running. started 39m ago"** sitting directly beside a **"Queued 39m"** pill — two adjacent
elements on the same row contradicting each other about whether work has actually started. This
is the identical "work in flight stops lying" defect the spec sets out to kill (*"the Why column
still reads 'built, waiting on review' while a review is running"*), just reappearing one
job-status earlier. Any feature sitting in a backlog before a runner claims it will show this.

**9. Projects view and the feature sheet were not wired to the options list — dead ends reappear
exactly where the spec names them.** The plan's task "`server.ts` + `app.js`: the Projects view
and the feature sheet use the options list, so no second copy of these rules exists" is checked
off, but `featureRow` (`public/app.js:385-394`) and the sheet's action (`public/app.js:516`) both
still call `startControl(featureItem(...))`, which returns `""` whenever `item.command` is null
(`public/app.js:209`) or `item.blocked` is true. Since 017 introduces several null-command kinds
(`escalated`, `finish`, `unblock`, `link`), any feature whose recommended move is one of those now
renders with **nothing to tap** in Projects/sheet. Confirmed live: feature 015, recommended "Mark
done" (command null), shows status "reviewing" in the Projects list with no button, no dashed
indicator, nothing — on the same phone-width screenshot where Next correctly shows a dashed "Mark
done · suggested" box for the identical feature. The same `|| item.blocked` short-circuit means a
blocked feature (e.g. 004) gets an empty cell here too — the literal bug the spec opens with
("004, blocked, renders with an empty action cell... nobody is being asked to make a decision")
still exists, just one view over. Projects is a primary bottom-tab destination on phone, so this
is a dead end on the device this dashboard is mostly used from.
*(Same surface as code finding 4, judged blocking from the user's side.)*

### Minor

**10. "Never reviewed" appears twice in a row.** For a feature with zero review rounds,
`src/next.ts:239` sets the recommendation's `reason` to `"never reviewed"`, and `featureFacts`
(`src/next.ts:193`) independently pushes the same string into `facts`. Since the Why column
concatenates `reason` + `facts.join(" · ")` (`public/app.js` row renderer), the rendered text
reads **"never reviewed · never reviewed · all 14 criteria met"**, confirmed live. It's not
wrong, just redundant, and it eats into the single line of space the builder's log says was
fought for.

**11. A running/queued/claimed job borrows the "failed" color.** `public/app.js:303` wraps the
running-state text in `<b class="failed">`, which is styled via `--needs` (orange, "needs
attention" — the same color used for actual failures and P1 priority). An ordinary in-progress job
visually reads as something wrong.

### Verified correct
- 390px/1280px, light/dark: no overflow at any of 15 widths (320-1920), confirmed by
  `npm run shoot`'s own sweep.
- Row height: a plain row is genuinely 51px at ≥1100px as claimed.
- Honest PR state ("Open PR ↗" vs "PR merged") renders correctly.
- 177/177 tests pass, but note: none of them exercise `public/app.js` rendering at all (it's
  JS-only, not unit tested), so the UX findings above would not be caught by `npm test` and
  weren't — they only show up by actually looking at the rendered page, which is what the Log's
  "verified in a browser" claim should have, but evidently didn't, cover for the Projects view,
  the escalated-on-phone case, or a merely-queued job.

**Net:** the mechanism (facts + options + one recommendation) is the right fix and works well in
Next. But three of the spec's own named failure modes — an escalated feature selling an agent
action, a row lying about work being in flight, and an empty action cell on a blocked/
non-agent-actionable feature — are still reproducible in this diff, just moved to a different
surface or a different job-status transition than where 011/015 first found them.
