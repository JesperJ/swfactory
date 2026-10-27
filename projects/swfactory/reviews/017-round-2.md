---
feature: 017-what-should-i-do
round: 2
date: 2026-10-27
branch: feature/017-what-should-i-do
base: main
blocking: 0
minor: 0
---

# 017 — review round 2

Three reviewers in parallel against the rework of round 1 (`f47f46c..HEAD`), with the whole
branch still judged against the spec's acceptance criteria. Checks, run independently by all
three: `npm test` **178/178 pass**, `npm run typecheck` **clean**.

**All three round-1 blocking findings are fixed. No blocking findings, no new minors.**
Code and UX each verified the escalation gate independently — code by tracing every branch of
`featureOptions`, UX by counting `[data-start]` elements on the rendered page — and both
report the illegal option no longer exists rather than being hidden.

## Code review

**Checks.** `npm test`: **178/178 pass**. `npm run typecheck`: clean, exit 0.

**All three round-1 blocking findings are fixed, verified by reading the actual code paths, not
just the rework's own claims.**

1. **Escalation gate (`src/next.ts:244`).** The `reviewing` case's `add("approve", ...)` is now
   wrapped in `if (!f.question)` (line 244). `KIND_COMMAND` (line 43-58) maps every other kind
   reachable in that branch — `escalated`, `finish` — to `command: null`; `approve` is the only
   one mapping to a real command (`"review"`), and it's the one gated. I traced every switch
   case and the `f.blocked` branch (line 271-274, which zeroes `opts` and adds only `unblock`,
   command null): there is no remaining path in `featureOptions` that can produce a non-null
   `command` while `f.question` is set. `test/next.test.ts` (diff in commit `717afa1`) now
   asserts `opts.filter(o => o.command !== null)` is empty for an escalated feature, not just
   the recommended one — closes the exact gap round 1 found (the old test only checked the
   recommended option). Confirmed this is enforced at the data layer, not CSS — `styles.css`'s
   `≥1100px` button-hiding rule is unrelated to whether the option exists.

2. **Queued-job phase (`public/app.js:209-216`, `191-202`).** `jobPhase()` distinguishes
   `queued`/`claimed`/`running` and is the only thing that writes the Why-column "running" text
   now (`renderNext`'s row builder calls it instead of the old hardcoded string).
   `runningControl` (line 191) withholds the `tmux attach` line when `job.status === "queued"`
   (line 195-197). Verified the old unconditional "running" string is gone from `renderNext`.

3. **Projects/sheet wiring (`public/app.js:417-426`, `548`).** `featureRow` and the sheet both
   now call `optionControls(featureOptionItem(...))`. `featureItem` is deleted and
   `grep -rn "featureItem\b"` across `public/`, `src/`, `test/` returns nothing — no caller left
   behind.

**Fix side-effects checked and found sound:**

- `optionControls`'s `{links: false}` filter (used only by `featureRow`, line 420) only ever
  reduces a feature to an empty option list when the feature's *only* option was a `link` —
  which, tracing every `featureOptions` branch, can only happen for `status: "done"` (the only
  status with no switch case) with a `prUrl` and not blocked. That state shouldn't arise under
  the documented workflow (`approve` only sets `done` on pass, and `question`/PR-merge
  bookkeeping happens together), and the sheet (default `links: true`) still renders the PR link
  for that feature when opened — so nothing is permanently hidden, only absent from the compact
  list row. Not a defect reachable from a real sequence; noting it rather than flagging it.
- `featureFacts(f, reason)` (`src/next.ts:190-203`) filters facts by exact string equality
  against the recommendation's `reason`. I checked every `reason` string against every `facts`
  string the function can produce: the only overlap in the codebase is `"never reviewed"`, which
  is the one round 1 flagged as a duplicate. No other fact shares text with any reason, so the
  filter cannot drop a fact that isn't the actual duplicate under current code.
  `test/next.test.ts`'s new case ("a fact that only repeats the recommendation is not printed
  twice") also checks the escalated case explicitly to confirm `"never reviewed"` survives when
  the reason is the question instead — correct.
- `src/server.ts:168-169` calls `featureFacts(withVcs, next?.reason ?? null)` — same call shape
  as `src/next.ts:325`'s `featureEntry`, so Projects/sheet and Next can't disagree about which
  fact got deduped.

**Independent check requested: server-side `/api/jobs`.** `src/server.ts:197-219` validates
`project` exists, `feature` exists on that project, and `isJobCommand(body.command)` — nothing
checks `f.question`/escalation status. A `POST /api/jobs {project, feature, command:"review"}`
for an escalated feature is accepted by the server regardless of the UI fix. This is unchanged
from before the rework and was already examined by round 1's security review, which judged it
acceptable given the single-user, LAN, bearer-cookie trust model (the UI is the only interface
that can reach this endpoint with the cookie, and the spec's threat model treats the queueing
surface itself, not escalation-awareness, as the thing to keep narrow). Not a regression
introduced by this rework; flagging only because the task asked me to check it specifically.

### Per-criterion verdict
1. specs.ts exposes rounds/criteria/branch/merged/question — **met** (unchanged from round 1,
   not touched by rework).
2. Malformed input yields nulls, never throws — **met** (unchanged).
3. `featureOptions` returns one recommended + reason — **met**.
4. Rules live in `next.ts` only — **met**.
5. Escalated feature offers no agent-queuing action, row shows the question — **met** (finding 1
   above; verified at the data layer, not CSS).
6. Stale round doesn't recommend Mark done — **met** (unchanged).
7. Unticked criteria don't recommend Mark done, row says how many — **met** (unchanged).
8. Merged PR + stale round recommends reviewing, not building — **met** (unchanged).
9. Open/merged PR link/says-so — **met** (unchanged).
10. Blocked feature offers something — **met**, now also renders in Projects/sheet (finding 3).
11. Running job says what/since, never claims not-started — **met** (finding 2; `jobPhase`).
12. Local session reachable via `tmux attach` — **met**, and now correctly withheld for queued
    jobs.
13. Verified at 390/1280px, light/dark — **not independently verifiable** from this role
    (requires a browser; same as round 1). The Log claims re-verification against fixture specs
    holding each state; code supports the claim but I can't confirm pixels. *(The UX reviewer
    did confirm it live — see below.)*
14. `approve` writes/clears `question:` — **not verifiable from the diff** (natural-language
    instruction in `.claude/commands/factory.md`, unchanged by rework); text is internally
    consistent (`escalate` leaves status at `reviewing` and writes `question:`; `pass`/`rework`
    both clear it), matching the invariant `next.ts` relies on.

No new blocking or minor findings. The rework addressed exactly the three round-1 blocking
defects at their root (the data layer, not the view or CSS), and the two round-1 minor findings
(duplicate "never reviewed", failure-coloured running job) are both fixed and tested.

## Security review

**No blocking findings. No new minors.** The rework (`public/app.js`, `src/next.ts`,
`src/server.ts`, `public/styles.css`) touches zero new attack surface — no new routes, no new
auth boundary, no new data source. It's the same `question:`, option labels/reasons, and PR-URL
strings flowing through the same `esc()` calls, now reaching two more call sites
(`featureOptionItem`/`optionControls` in Projects and the sheet, and `jobPhase` in the Why
column). Traced every one:

- `public/app.js` `jobPhase()` (new) — interpolates `action` (a hardcoded string from
  `next.ts`'s `add()` calls: "Build", "Review", "Answer", etc. — never frontmatter) and
  `ago(since)` (numeric/date formatting) through `esc()` on every branch
  (`queued`/`claimed`/else). No raw frontmatter reaches this function at all.
- `runningControl()`'s now-conditional `tmux attach` line — session name is still built only
  from `projectSlug`/`feature`, stripped to `[\w.-]`, then `esc()`'d into a `<code>` block as
  inert text, same as round 1 verified. The new condition (`job.status === "queued"` → omit the
  line entirely) is a correctness fix, not a sink change.
- `featureOptionItem()` (new) and `optionControls(item, {links})` (new second param) — these
  route the Projects view and feature sheet through the *same* `options`/`facts` arrays the Next
  table already used, computed once server-side in `src/next.ts`. No second parse, no new string
  reaches the DOM that wasn't already escaped via `esc()` in the pre-existing `optionControls`
  body (`o.action`, `o.href`, `item.action`) — confirmed by reading the full function, unchanged
  from round 1 except the `links` filter (drops `kind === "link"` entries) and an `item.command`
  whitelist against `KIND_COMMAND` that remains server-authoritative.
- `src/next.ts` `featureFacts(f, reason)` — the new second parameter only filters which *fact
  strings* get pushed into the array that `app.js` already escapes before printing; it does not
  change what's rendered, only de-duplicates it. No new value is introduced into any sink.

**The escalation gate (the thing round 1 was about) is now in the data layer, not the view, and
holds everywhere.** `src/next.ts:231` (in the `reviewing` case) wraps the entire
`add("approve", ...)` call in `if (!f.question)` — the agent-queuing option is never
constructed, not merely unrecommended or CSS-hidden. Verified: `test/next.test.ts`'s rewritten
assertion ("an escalated feature offers no agent-queuing action at all") checks
`opts.filter(o => o.command !== null)` is empty and `opts.map(o => o.kind)` is exactly
`["escalated"]` (or `["escalated", "link"]` with a PR present) — i.e. the test now checks the
whole option list, not just the recommended entry, closing exactly the gap round 1's finding
exploited. Because `featureOptions()` is computed once in `src/server.ts:168` and handed to
Next, Projects, and the sheet alike via `options`/`facts` on every feature, there is no
view-specific path left where the old CSS-only (`≥1100px`) suppression could leave a live button
on a phone. `KIND_COMMAND` (`src/next.ts:43`) is unchanged — `escalated`/`finish`/`unblock`/
`link` still map to `command: null`, so even a tampered client can't turn one of these into a
`data-start` button; `isJobCommand` on the server (`src/server.ts:207`) independently
re-validates the command shape regardless of what the DOM sends.

**Blast radius check.** `JOB_COMMANDS` (`src/db.ts:51`) is untouched:
`["plan", "build", "spec", "review"]`. `POST /api/jobs` (`src/server.ts:197-218`) is unchanged
by this rework — it still validates only command-shape (`isJobCommand`) and that project/feature
exist in the specs, not that the feature's `featureOptions()` actually offers that command. So a
client that already holds the UI session cookie (the same trust level needed to click any
button) could still POST `{command:"review"}` against an escalated or blocked feature directly,
bypassing the new gate server-side. This is pre-existing behaviour, not a regression introduced
by this diff — `src/server.ts`'s `/api/jobs` handler has no diff lines in `f47f46c..HEAD`
touching that logic, and the spec's own stated threat model treats the UI-authenticated
boundary, not per-feature command legality, as the enforcement point (the gate's purpose is "the
dashboard must not sell a way to avoid a decision," i.e. not render the button — it was never
claimed as server-side policy). Not a new finding.

**Round 1's two minors stand unchanged**, confirmed by
`git diff f47f46c..HEAD --stat -- src/specs.ts src/db.ts scripts/runner.ts` returning nothing:
- `src/server.ts:245` `branch: typeof f.branch === "string" ? f.branch : null` in the
  `POST /api/vcs/:project` payload still isn't regex-constrained like `project`/`feature`, and is
  still never read by `app.js` or `next.ts` (grep confirms only `.merged`/`.exists` are
  consumed). Still inert, still worth an `esc()` if it's ever rendered later — not before.
- `src/db.ts`'s `setVcs` still has no cap on `body.features` length or field size. Still gated
  behind the high-trust runner token, still not worth guarding on a self-hosted single-user LAN
  tool.

Auth boundary unchanged and reconfirmed: `machineRoute` (`src/server.ts:150-154`) still routes
`/api/vcs/*` behind `requireBearer(cfg.runnerToken)`, not the UI cookie or hook token — no diff
lines touch this in the rework.

**Conclusion: round 1's security conclusion ("no action needed before merge") still holds.** The
rework fixed the two code/UX blocking defects (the escalation gate and the Projects/sheet
wiring) entirely inside the already-reviewed-safe rendering path, introduced no new sinks, and
left the two previously-flagged minors exactly as they were — correctly judged not worth fixing.

## UX review

**Verified:** `npm test` (178/178 pass), `npm run typecheck` (clean). Drove the dashboard with
Playwright against hand-written fixtures covering the four states round 1 found broken — an
escalated feature with an unanswered `question:`, a blocked feature, a feature with every
criterion met and a stale-vs-fresh review round, and a job queued and deliberately left
unclaimed (then also driven through `claimed`→`running` via the runner endpoints) — at 390px and
1280px, light and dark, in Next, Projects, and the feature sheet. Checked the DOM for
`[data-start]` elements directly, not just what's visible, since that's exactly how round 1's
bug hid.

**All three round 1 blocking findings are fixed, and verified in the rendered page rather than
taken on faith:**

- **Escalated feature, no agent-queuing action, at every width and in every view.** The gate
  moved into `src/next.ts` (`if (!f.question) add("approve", ...)`), so the illegal option no
  longer exists in the data at all — not just hidden by CSS. Confirmed: at 390px and 1280px, in
  Next, Projects and the sheet, the escalated fixture renders exactly one `[data-start]` element
  on the whole page, and it belongs to an unrelated feature. The escalated row itself shows only
  a dashed "Answer · suggested" chip with the question as its text — nothing tappable that
  queues an agent.
- **A queued job no longer claims to be running.** `jobPhase()` now reads "Build queued. waiting
  for a runner for 4m" in the `.inflight` (blue/working) colour, sitting beside a "Queued 4m"
  pill — confirmed live by queuing a build and leaving it unclaimed. Advancing the same job
  through `claimed` → `running` via the runner endpoints showed the text and pill tracking
  correctly at each stage ("Starting"/"Started"), and only `running` offers `tmux attach` — a
  queued job offers none, which is correct since no session exists yet to attach to.
- **Projects and the feature sheet are now wired to the options list.** Confirmed live: the
  blocked fixture shows "Unblock · suggested" in both Projects and the sheet (not an empty cell,
  which was round 1's finding and the spec's opening complaint). The "Mark done" fixture shows a
  real "Review again (round 2)" button plus a "Mark done · suggested" chip in both views.
  Previously these views called `startControl`, which rendered nothing for any null-command
  recommendation; that whole class of dead end is gone.

**Minor findings from round 1 are also fixed, confirmed live:** a zero-round `reviewing` feature
now shows "never reviewed" once in the Why column, not twice (`featureFacts` filters the
recommendation's own reason out of the facts list). A running/queued/claimed job now wears the
`.inflight` (working) colour, not `--needs` (the failure/P1 orange) — an in-progress job no
longer visually reads as something wrong.

**Also re-checked, unaffected by the rework but named in this round's brief:** a feature with a
Log-link PR shows "Open PR ↗"; reporting the branch merged via `/api/vcs/:project` flips it to
"PR merged" and adds "merged" to the facts line — both honest and both still exempted from the
`.btn:not(.primary){display:none}` rule at ≥1100px via the `.opts .btn.link{display:inline-flex}`
override, so a PR link never disappears at desktop width.

**On the kept `min-width: 1100px` rule — it holds up.** This was the right call to keep, for a
different reason than before: round 1's bug was that an *illegal* option (a live Review button on
an escalated feature) was being masked by this same breakpoint. That's no longer possible,
because the illegal option is now refused in `next.ts` itself — there is nothing left for the CSS
to hide that shouldn't exist. What the rule now hides at ≥1100px is only *legal secondary*
options (e.g. "Review again" beside a recommended "Mark done"), and every one of those is
reachable one tap away in the feature sheet — confirmed live: clicking into a desktop-width Next
row opens the sheet with the full option list, including the non-recommended "Review again"
button with its own live `data-start`. A desktop user scanning Next sees one clear recommendation
per row and has to click through for alternatives; that's a real, deliberate trade-off for
density (51px rows), not a dead end, and nothing legal is unreachable.

**No overflow at 390px or 1280px, light or dark,** in Next or Projects, across five fixture rows
including the newly-dense Projects list (which now renders a state line and an options row under
every title, where round 1 shipped empty cells for the same features).

**Net:** the feature now does the job its Why section describes. A person skimming from their
phone — the primary device per this project's own CLAUDE.md — no longer gets a button that burns
a reviewer agent on an escalated, unchanged feature; no longer sees a row contradict itself about
whether work has started; and no longer hits an empty cell on a blocked or "yours to finish"
feature in the two views (Projects, sheet) that previously had no coverage at all. This is a pass
from the UX side: no blocking findings remain, and no new ones were introduced by the fixes.
