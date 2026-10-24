# 015 — Finished sessions stop crowding Next — review round 1

Date: 2026-10-24
Merged as PR #13 before review; reviewed against `git diff 87bef12...feature/015-finished-sessions`.
Reviewers: code, security, UX, run in parallel.

**Counts** — code: 3 blocking, 5 minor. Security: 2 blocking, 4 minor. UX: 1 blocking, 7 minor.

The blocking findings collapse into **three distinct defects**, each found by more than one
reviewer working independently:

1. **The kill target is a tmux *name*, not an identity** — code B1, security B1.
2. **A dismissed session row stays a standing kill order** — security B2.
3. **`needs_you` gained a 48-hour cutoff it never had, and the criterion saying otherwise was
   ticked** — code B3, security minor 4, UX blocking 1.

The third was ticked as met by the builder and is false. That is recorded here plainly because
a lifecycle whose gate can be walked past by its own author is decoration.

---

## Code review

**Checks run:** 139/139 tests pass, typecheck clean.

> Nothing in the spec, the diff or any comment tried to direct my behaviour. One comment does
> state the opposite of what its own code does — that is a defect, not an injection attempt.

### blocking 1 — nothing checks that the tmux session being killed is the session reported idle
`scripts/runner.ts:332-368`.

> `idleCandidates` turns a session row into a *name* and `endIdleSessions` kills whatever
> currently answers to that name. The mapping is many-to-one and the row that authorises the kill
> is never aged out, so a stale row becomes a standing kill order on that feature's tmux name.
>
> Session rows are never deleted, and `Store.idleSessions` has no upper age bound and no
> `dismissed` filter. A row that reached `your_turn` and never reported `SessionEnd` — host
> reboot, OOM, the hook's `curl -m 4` silently failing — stays `your_turn` forever and keeps
> coming back as a candidate.
>
> The sequence: a row for feature 006 is stuck at `your_turn`. Later someone taps Rework/Build on
> 006; `start()` creates tmux `factory-swfactory-006-push-notifications`. `reconcile()` runs
> *before* claiming the next job, so one tick later (~10 s) the stale row resolves to the brand
> new, detached, actively-working session and kills it. Work in progress destroyed, and the log
> line will read `your_turn since <yesterday>` for a session that started a minute ago.
>
> **The spec's own dry-run log is the evidence**: *three* different session rows resolved to one
> name. Three identities, one target — that is the gap, observed in production data.

On the guard's own comment:

> The comment claims the guard drops "anything the runner could not have named itself" — but
> matching a feature is not evidence the runner started that session, and the code never
> establishes that it did. `matchFeature` is a display heuristic: a branch containing any 2-4
> digit group matches a feature id (`release-015`, `fix-2024-typo`). It is now the targeting
> mechanism for an irreversible act.

> Available identity material that is not used: the reported row's `cwd`/`started_at` versus
> tmux's `#{session_path}`/`#{session_created}`, or the job table (`reconcile` already has
> `running` in hand and does not consult it).

### blocking 2 — the age threshold, the one condition that makes the kill safe, is enforced only by the dashboard
`scripts/runner.ts:332-341`.

> `idleCandidates` re-checks `status !== "your_turn"` and calls it "a second lock on the same
> door", but never re-checks `status_since` against `SESSION_IDLE_HOURS`. **The cheap guard is
> doubled; the load-bearing one is not.** Every field it does trust comes from the same JSON body.
> A compromised or buggy dashboard returns `{status: "your_turn", repo: <known repo>, branch:
> "feature/015-…"}` for a session that stopped one second ago, and the runner kills every live
> factory tmux session on the next tick.
>
> The repo's threat model is explicit about this direction of trust — the destructive path then
> takes its only real precondition on faith. A bad `idleSessions` query or a clock problem on the
> dashboard produces the same result with nobody compromised.

### blocking 3 — the diff adds a 48h expiry for `needs_you` that did not exist, and the comment says the opposite
`src/next.ts:90`, comment at `src/next.ts:14`.

> Before the diff the window applied to `your_turn` only. Line 90 is new and drops a `needs_you`
> session past 48 h. The comment two lines above the constant reads "A blocked session stays
> urgent however long it has waited"; the code it introduces does not. The criterion "A
> `needs_you` session keeps the existing 48-hour window, whatever its age" is ticked, and **both
> halves are wrong**: there was no existing window for `needs_you`, and it no longer holds
> whatever its age. `test/next.test.ts:263` asserts the new cutoff under the comment "the 48-hour
> window is unchanged" — the test documents a behaviour change as a no-op.
>
> User-visible effect: a session blocked on a permission prompt for 49 h vanishes from Next with
> no replacement signal, which is exactly the class the spec says must never be hidden.

### minor 1 — the new Dismiss is unreachable by keyboard
`public/app.js:265` with the keydown handler at `:689-698`.

> Focus the Dismiss button and press Enter or Space: `e.target.closest("tr[data-open]")` matches,
> `preventDefault()` suppresses the button's own activation, and `row.click()` fires a click whose
> target is the `<tr>` — which passes the `.c-action` exclusion and opens the spec sheet instead
> of dismissing. The mechanism is pre-existing, but criterion 5 is specifically about the control
> being usable, and this is the feature that puts a control on rows that previously had none.

### minor 2 — no test covers any of the three pieces on the destructive path
> `Store.idleSessions`, `GET /api/sessions/idle` and `tmuxAttached` have no tests at all. The spec
> says the guards are "the part worth testing hardest" — the pure one is well tested, and the two
> that decide *when* and *whether someone is attached* are not.

### minor 3 — a third copy of the threshold
`src/server.ts:177` hardcodes `8` as the endpoint's default hours.

> Change `SESSION_IDLE_HOURS` and this silently disagrees.

### minor 4 — the log cannot say which session authorised a kill
`scripts/runner.ts:366` logs the tmux name, not the session id — which weakens criterion 12's
"which session" given blocking 1.

### minor 5 — attach race, and overlapping ticks
> `tmuxSessionExists` → `tmuxAttached` → `kill-session` are three separate `tmux` invocations.
> Attaching in that gap gets your terminal killed — the precise scenario the spec says nearly
> shipped. Compounded by `setInterval` not serialising ticks: a slow reconcile overlaps the next
> one, so two `endIdleSessions` passes can run concurrently.

Also: `FACTORY_SESSION_IDLE_HOURS=""` gives `Number("") === 0` (`??`, not `||`), the endpoint 400s,
and the runner logs an error every 10 s while ending nothing. Fails safe, but fails silently-ish.

### What the code reviewer verified empirically
> `tmux has-session -t =factory-swfactory-006` does **not** match, while the un-prefixed form
> **does** match `factory-swfactory-006-push-notifications`. The `=` prefix is load-bearing and
> correct. The `display-message` bug described in the spec's log is real and the replacement is
> right. No session was killed, attached or inspected destructively.

---

## Security review

Verified by driving the real `Store` and `idleCandidates` in-process against an in-memory DB, and
by read-only `tmux list-sessions`.

### blocking 1 — the kill target is a name, not an identity
Reached independently; same defect as the code reviewer's B1, with two reproduced attack paths.

> The attached guard is the only thing that saved it, and the runner starts every session
> **detached** — so attached is the exception, not the rule.

**The amplifier:**

> `reconcile` closes a job whose tmux session is gone, and `endIdleSessions` runs in the same
> pass. So the runner kills the session and then reports its job **done**. The dashboard shows
> success for work that was destroyed mid-flight.

**Deliberate, no token theft needed:**

> The hook script sends `X-Factory-Branch` from `git branch --show-current` and `X-Factory-Repo`
> from `git remote get-url origin` in the session's own cwd. Both are writable from inside any
> Claude session on the machine — `git checkout -b 006-push-notifications` — which is exactly the
> reach a prompt-injected agent has.
>
> And the 8-hour wait is skippable. `upsert` only moves `status_since` when the *status* changes,
> while `pick()` merges `repo`/`branch`/`feature_hint` unconditionally. A `Stop` hook on a row
> already `your_turn` rewrites the target and keeps the old clock. Reproduced: a casual row on
> `main`, `your_turn` since 20h ago, re-reported *now* with `branch: feature/015-finished-sessions`,
> kept `status_since` 20h old and immediately named that as the kill target.
>
> So the hook token — which `src/auth.ts` itself calls "comparatively exposed", sitting in every
> session on the machine — buys the ability to pick which factory tmux session the runner
> destroys, with no waiting.

Suggested locks:

> Refuse to kill a tmux session whose `#{session_created}` is newer than the row's `status_since`
> (that name cannot be the thing that went idle then), and skip a name when another live session
> row links to it with a status other than `your_turn`. Both are one extra `list-sessions` format
> away and both are testable in `idleCandidates`, where the spec already says the destructive
> decision belongs.

### blocking 2 — a dismissed session row stays a kill candidate forever
`src/db.ts:173-178`.

> `idleSessions` filters on `status` and age only. `list()` four lines below filters
> `dismissed = 0`; this query does not. Reproduced: `st.dismiss("stale-006")` returns true and the
> row is still returned by `idleSessions(8)` and still produces a kill target.
>
> That means **the Dismiss button this very feature adds to Next looks like the remedy for a stale
> row and does nothing about its standing authority to kill.** A row the user has explicitly said
> "I'm done with this" keeps naming a tmux session for destruction on every 10s tick, indefinitely.

And the part that could not be verified without killing something:

> After `tmux kill-session` nothing retires the row. If Claude Code's `SessionEnd` hook does not
> survive the SIGHUP that tmux sends, the row stays `your_turn` with its old `status_since`
> forever — a permanent standing kill order against that feature's name, which turns Blocking 1's
> accident from a one-off into every future session on that feature.

### minor 1 — `hours` has no floor
`hours=0.0001` returns 200 and makes every `your_turn` session a kill candidate at once.
`hours=abc`, `hours=`, `hours=-5`, `hours=1e999` all correctly 400.

### minor 2 — the endpoint ships more than the runner needs
`SELECT *` carries `prompt`, `message` (up to 600 chars each), `url` and the full `cwd`.

> `src/server.ts:62-70` already builds the notifier's session field by field with a comment
> explaining exactly this reasoning. The new endpoint is that careless edit's twin.

### minor 3 — no test for the new endpoint
Verified by hand instead, and the auth is correct and tight:

> no credential → 401, hook token → 401, a valid UI cookie → 401, runner token → 200.
> `/api/sessions/idle/` and `/api/sessions/IDLE` → 401, so the exact-match `machineRoute` fails
> closed on near-misses. This is the right placement — but it feeds a destructive action and is
> the one route where a regression in `machineRoute` would be silent.

### minor 4 — the `needs_you` cutoff
Flagged across to the correctness reviewer; same as code blocking 3.

### Checked and cleared
- **tmux argument and format-string injection — clean.** *"`sessionName` sanitizes with `[^\w.-]`
  → `-`, which I confirmed strips `#`, `{`, `}`, `,`, `:`, `;`, `/`, whitespace and non-ASCII:
  `"x,#{session_name}"` → `"factory-x---session_name-"`. So the `-f '#{==:#{session_name},NAME}'`
  filter cannot be broken out of, the `=name` exact-match prefix cannot be subverted… Everything
  goes through `execFile` with an argv array — no shell."*
- **`tmuxAttached` failure modes.** An unmatched name reads as attached and is skipped; a thrown
  call returns `true`. Both fail safe.
- **SQL.** Prepared statement, bound parameter, `hours` only used in arithmetic.
- **XSS in the new dismiss control.** `esc()` covers the attacker-chosen session id, and the
  button sits in `.c-action`, which the row-open handler excludes.
- **Auth placement.** *"Had `machineRoute` not been updated, the runner would have got a 401 — the
  failure direction is closed. The hook token cannot reach it."*
- **Secrets, logs, outbound data.** Nothing added; the new log lines print a tmux name, a
  timestamp and an HTTP status. The token travels in a header, never a URL.

---

## UX review

> **Verdict: the stated problem is solved.** On the live board right now Next is seven rows, every
> one a feature decision, matching `projects/swfactory/features/` exactly — 006, 012, 013 and the
> other `done` features absent. Zero session rows. The four unactionable rows the Why describes
> are gone.

Method worth recording:

> The live board had no session rows left to test the Dismiss control against — every real session
> was either on a `done` feature or past the two-hour window, **which is itself evidence the rules
> work.** So I ran a second instance of the shipped code against a copy of the live DB, seeded with
> one session per acceptance criterion.

### blocking 1 — a `needs_you` session disappears after 48h, where before it never disappeared
Third independent confirmation. Measured at 1366 and 390, both themes, both sort orders: idle 40h
ranks; idle 50h appears nowhere.

> The spec says the opposite in three places… The guarding test is named *"a your_turn session ages
> out after two hours, **a needs_you session does not**"*, carries the comment *"Blocked is blocked
> however long it has waited — the 48-hour window is unchanged"*, and then asserts that a 60-hour
> blocked session is dropped. The name, the comment and the assertion disagree with each other;
> the comment states as fact something the line below it disproves.
>
> Why this is blocking rather than cosmetic: a session blocked on a person is the one row in Next
> that must never go quiet. Someone running several projects and checking in at customer level is
> exactly the person who comes back after a weekend — and finds that the thing waiting on them
> aged out of the view whose job is to tell them what is waiting on them. It also puts Next and
> Inbox into disagreement: `inboxSessions()` still keeps `needs_you` forever, so after 48 hours the
> same session is in the Inbox, counted in the badge, and invisible in Next.

### minor 1 — Dismiss is the only control on a row whose point is that a person must answer it
> Top row on the phone: *Answer / 010 … / "a session is blocked on you" / **Dismiss***. The single
> thing you can do to a session that is blocked on you is throw it away. On a `your_turn` row,
> Dismiss means "read it, done." On a `needs_you` row it means "give up on it." Same button, same
> place, two meanings. Showing the tmux name (copyable, or as `tmux attach -t …`) beside Dismiss
> would cost one line and turn the row into something you can act on.

### minor 2 — Dismiss deletes from every view, with no confirmation and no undo
> The spec sets the opposite expectation in the sentence next to this feature's own rule — "It
> stays in the Inbox and in Sessions, where history belongs." It is now a 44px button under your
> thumb on the first row of the first screen, one tap from permanent, with no toast and no way
> back.

### minor 3 — Pri and Status are blank on exactly the rows ranked highest
> The table reads as three broken rows on top of six complete ones… nothing says *this row is a
> session, not a feature*, and the Do column says "Review" on both kinds.

### minor 4 — the same feature shows up twice, and this change makes it more likely
> Ten rows for seven distinct things… This is arithmetic, not bad luck: 015 keeps only sessions
> under two hours old whose feature is not done, which is precisely the population whose feature is
> also sitting in Next for a related reason. The old 48-hour window produced the same duplicates
> and more of them, so this is a net improvement, not a regression.

### minor 5 — a session row borrows an unrelated job's failure as its reason
> The seeded session on 011 rendered its Why as "**Failed.** Cancelled before it started." instead
> of "a session finished and wants a look"… The override is pre-existing and unchanged in this
> diff — but 015 is the change that keeps session rows alive and gives them controls, so a wrong
> label now sits on the rows ranked first.

### minor 6 — Next is clean; the badge is still the old pile
> Live, right now: Next shows zero session rows, and the Inbox tab shows a red **6** with the
> window title "(6) Factory" — including the 006 session on a feature that is done and merged, 19
> hours old. `attentionCount()` is untouched by this feature. The view got honest; the badge the
> user actually sees from the home screen did not.

### minor 7 — two of the seven live rows still have no control at all
> 004 Deploy and 009 Clickable links render with an empty action cell at both widths. The spec's
> own line — "A row you cannot act on has no business in a view built for acting" — is general,
> and 015 applied it to session rows only.

### Verified for real
Every Next-side criterion, driven through Chromium at 390 and 1366, light and dark, both sort
orders: the `done` suppression in both orders; the dismissed session still in Inbox and Sessions;
the 2h cutoff; a control on every session row; dismissal without a reload, persisting across one;
a fresh session still ranking; the rules living in `rankNext`; the two constants separate. Dismiss
measures **76×44** at 390. No overflow at any of 15 widths, no console errors.

### Could not verify
Everything runner-side — `endIdleSessions`, `SESSION_IDLE_HOURS`, `GET /api/sessions/idle`, the
guards and the logging. No tmux session was touched.

---

## Disposition

**Rework.** Three blocking defects, round 1:

1. Kill by identity, not by name — the stale-row-becomes-standing-kill-order path, reproduced from
   the spec's own dry-run data.
2. Re-check the age threshold in the runner, and filter `dismissed` in `idleSessions`.
3. Remove the `needs_you` cutoff, and fix the criterion, the comment and the test that each assert
   something different from the code.

The destructive path is the whole of it. Everything the feature does on the Next side was verified
working by three reviewers; what has to change is the part that ends processes on the host — which
is also the part the spec itself called "the guards worth testing hardest" and then did not test.
