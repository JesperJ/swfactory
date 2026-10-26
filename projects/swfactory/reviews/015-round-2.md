# 015 — Finished sessions stop crowding Next — review round 2 (rework)

Date: 2026-10-26
Reviewed against `git diff 3802d03...feature/015-rework-guards`, merged as PR #15 and deployed.
Reviewers: code, security, UX, run in parallel. All three read round 1 first and were asked to
judge whether each blocking finding was actually fixed.

**Counts** — code: 2 blocking, 9 minor. Security: 2 blocking, 6 minor. UX: 0 blocking, 6 minor.

### Round 1's three blocking findings

| # | Round 1 finding | Round 2 verdict |
| --- | --- | --- |
| 1 | Kill target is a name, not an identity | **half fixed, still blocking** — the accident is closed, the deliberate retarget is not |
| 2 | Age enforced only by the dashboard; no `dismissed` filter | **fixed**, both halves, and the un-dismiss bypass self-defeats |
| 3 | `needs_you` gained a 48h cutoff under a comment and test claiming otherwise | **fixed**, cleanly, confirmed in the browser |

And one new blocking defect, found by code and security independently: **the second guard added
to fix round 1 is dead code.**

---

## The one defect, in two halves

Both blocking findings from both reviewers are the same defect. Recording it once.

### half one — the `busy` guard can never fire
`scripts/runner.ts:348-354` builds the set, `:364` checks it, `src/db.ts:186-191` makes it
impossible.

> `busy` is built by skipping every row whose status *is* `your_turn` and recording the names of
> the rest. But the only caller feeds it `GET /api/sessions/idle`, which is
> `Store.idleSessions`, whose SQL is `WHERE status = 'your_turn' AND dismissed = 0 AND …`. Every
> row the runner ever receives is `your_turn`. The loop therefore `continue`s on every element
> and `busy` is empty on every tick in production. `if (busy.has(name)) continue` can never fire.

Security reproduced the same thing and drew the line to its test:

> The test that covers it, `test/runner.test.ts:378` ("a name another live session is using is
> never a target"), passes `session({ status: "working" })` straight into `idleCandidates`. That
> input cannot come from `idleSessions`. **The test proves the guard works on data the guard will
> never see**, which is why a dead branch shipped looking covered.

And the code reviewer noted the two tests added in the same commit contradict each other:

> `test/jobs.test.ts:150-158`, added in the same commit, proves it by asserting `idleSessions`
> returns only the `your_turn` row. The two tests contradict each other's premise.

Both called it blocking for the same reason, which is the one worth keeping:

> I am calling this blocking rather than minor because the rework task list ticks it … and the
> comment asserts it. That is the same defect class as round 1's blocking 3: **a gate walked past
> by its own author.**

### half two — the identity check is one-directional
`scripts/runner.ts:396`.

> The check refuses a tmux session created *after* the row's `status_since`. It says nothing
> about a session created *before* it. That closes the accidental case round 1 described —
> genuinely, and that was the main one. It does not close the deliberate one.

> The guard is one-sided: it refuses a target created **after** the row went idle and permits any
> target created **before** it. Long-lived sessions are therefore still reachable, and long-lived
> detached sessions are exactly what the feature exists to kill — **so the attack and the feature
> now share a target class.**

Reproduced read-only against the **live 006 session**:

```
before retarget: 1 candidate rows, 0 kill targets
statusChanged: false   status_since still: 2026-10-25T20:27:35.279Z
after retarget, kill targets: [ 'factory-swfactory-006-push-notifications' ]
factory-swfactory-006-push-notifications attached: true
  created: 2026-10-23T20:21:41.000Z   row idle since: 2026-10-25T20:27:35.279Z
  => identity check PASSES
```

> A casual row on `main`, `your_turn` for 20h, re-reported with
> `branch: feature/006-push-notifications` and no status change: old clock kept, new target
> acquired, **and the identity check passes**, because the real 006 tmux session was created 2
> days before that row went idle. The only thing standing between that row and the session is
> `attached: true` — the guard round 1 called the exception rather than the rule, since the
> runner starts everything detached. Detach that terminal and it dies on the next tick.

The upstream mechanics are unchanged from round 1: `src/db.ts:136` sets `changed` from the status
alone, `:142` moves `status_since` only when `changed`, and `:146` merges `branch`
unconditionally. Security added that the ids are not even guesswork:

> The id used to need guessing; it does not. Every session id on this machine is a filename:
> `ls ~/.claude/projects/*/*.jsonl` lists 33 of them here, with mtimes that say which are old.

Reachable without an attacker, too:

> any tmux session older than some other row's `status_since`, running detached — a second
> `claude` started inside an existing factory tmux session, which is the one way a new session id
> gets an old `session_created`. That is precisely the case `busy` was meant to catch, which is
> why blocking 1 and blocking 2 are one defect with two halves.

**What both reviewers propose instead** — compare an identity the reporter does not control:

> The row already carries `cwd`, and the projection ships it — `#{session_path}` versus the row's
> `cwd` would make a retarget require also faking the cwd … and the job table (`reconcile`
> already holds `running`) knows which tmux name the runner itself created for which feature.
> Either is a narrower fix than this one and does not depend on an ordering the attacker can
> satisfy.

And on the spec's own claim:

> The spec's Log claims "The destructive path is now identity-based, not name-based." It is
> identity-*gated*, in one direction. The verification recorded tested only that direction.

---

## What round 2 confirms as genuinely fixed

**Round 1 blocking 2 — dismissed rows and the dashboard-only age check.** Security went after the
obvious bypass and found it self-defeating:

> A `Stop` on a dismissed `your_turn` row: `changed = false`, so `dismissed` stays `1` **and**
> `status_since` stays old. No revival. `Notification` → `needs_you` → `Stop` → `your_turn` does
> clear `dismissed`, but each real status change rewrites `status_since` to the server's `now`…
> So the only way to un-dismiss a row costs the attacker the whole 8-hour clock. `status_since`
> is never caller-settable.

> **The age re-check.** Genuinely fixed and genuinely load-bearing. A dashboard that returns a
> session that stopped one second ago now gets nothing killed, which was the round 1 path.

**Round 1 blocking 3 — `needs_you`.** UX verified it in the browser rather than the diff:

> Measured against a copy of the live DB, seeded with blocked sessions at 40h, 49h, 60h and 13
> days: every one of them ranks in Next, at 390×844 and 1366×768, light and dark, Ranked and
> Priority — eight configurations, no exceptions. The 49-hour row is the exact case that was
> blocking in round 1, and it is now the top of the list where it belongs.
>
> The second half of the round-1 harm is also gone: Next and the Inbox no longer disagree about a
> blocked session.

**An open question from round 1, answered by production.** Round 1 security could not tell whether
anything retires a row after a kill — whether `SessionEnd` survives tmux's SIGHUP:

> Production says it does: after 18:33:13 and 22:54:22 on 24 Oct, the names
> `factory-swfactory-007-private-specs`, `-010-commands-everywhere` and `-009-local-session-links`
> appear **zero** times in 50k subsequent journal lines. The rows went to `ended` and dropped out
> of the query. The permanent-standing-kill-order escalation does not materialise.

---

## Minor findings

### The same mistake, one layer down (UX minor 1)
The most useful minor in the round, because it is the round 1 defect's exact shape repeated:

> Not in `rankNext` — in its data source. `src/server.ts:148` feeds `rankNext(projects,
> store.list())`, and `Store.list(days = 14)` drops anything whose `updated_at` is older than 14
> days. Measured: a blocked session 335 hours old ranks; one 337 hours old never reaches the
> client at all.
>
> The test the rework added asserts 40h, 60h and `24 * 14` — and **`24 * 14` is exactly the
> boundary**. It passes because it hands a session straight to `rankNext`, which is the one layer
> that no longer has a cutoff. End to end, that is the first value that fails.
>
> Why this is minor rather than blocking: past 14 days the row leaves Next, the Inbox and the
> badge together, so nothing claims it is there and nothing counts it… But it is the same shape
> of mistake one layer down: **a test that asserts a behaviour the real path does not have, at
> the exact value it chose as proof.**
>
> Who it bites: a session blocked on a person is the one kind the runner is forbidden to end. So
> the single row the machine can never clean up is also the one the dashboard silently forgets.

### The log is 1000:1 noise (code minor 3)
> Since 24 Oct the runner's journal is 53,687 lines, of which **53,623** are the same
> "`factory-swfactory-006-push-notifications … but attached — leaving it alone`" line, once per
> 10s tick for three days. The three real `ended` lines are three. Criterion 12 is met, and this
> diff made the line longer rather than rarer. **A skip that repeats unchanged every tick is not
> an event.**

### The one load-bearing guard fails open (code minor 1)
> `scripts/runner.ts:396`: if `#{session_created}` does not parse, `info.created.getTime()` is
> `NaN`, `NaN > anything` is `false`, and the kill proceeds. Every other guard in the function
> refuses on bad input, and `tmuxSession`'s own catch comment claims "every guard below refuses".

### "but attached" is logged for sessions that do not exist (code minor 2, security minor 3)
> `tmux list-sessions -f …` exits 0 with empty output for an unmatched name (→ `null`, correct)
> but exits **1 when there is no tmux server at all**. That lands in the catch, returns
> `attached: true`, and the runner logs "idle since X but attached — leaving it alone" about a
> session that is gone entirely. Fails safe; logs a falsehood, on the path whose criterion is
> about honest logging.

### The untested half (code minor 6, security minor 1)
> Round 1 rework task 5 reads "Tests for the destructive path: `idleSessions`,
> `GET /api/sessions/idle`, `tmuxAttached`". The first two are now tested well. `tmuxAttached`
> was renamed to `tmuxSession` and still has no test of any kind — **it is the function that
> parses the format string and owns the catch-all**. The task naming it is ticked.

> The spec's own rule is that the destructive decision belongs in `idleCandidates` because that is
> where it can be tested; the new guard was put on the other side of that line.

### `MIN_IDLE_HOURS` is a floor used as a default (code minor 4, security minor 5)
> `src/server.ts:24` says "A floor, not a default"; `:211` uses it as the default. Round 1 minor 3
> asked for the duplicated `8` to go — it did, and the unparameterised default quietly became 1
> hour.

### Carried over, unfixed
- **Ticks still not serialised** (`scripts/runner.ts:486`) — two `endIdleSessions` passes can
  overlap. Round 1 minor 5's second half.
- **The attach race is narrowed, not closed**, and the comment says closed: *"Three gaps became
  one; attach in that one and you still lose the terminal."*
- **`FACTORY_SESSION_IDLE_HOURS=""`** → `Number("") === 0` defeats both filters at once; it now
  fails closed only because the endpoint 400s, after which the runner errors every 10s.
- **`as Session` casts** (`runner.ts:352`, `:361`) undo what the `IdleSession` projection bought:
  *"the day someone makes matching consult `url` or `host`, the compiler stays quiet and the
  runner silently matches on `undefined` — on the path that ends processes."*
- **Two clocks** if the dashboard ever moves off the host: `#{session_created}` is the tmux host's
  clock, `status_since` the dashboard's. *"The unsafe direction is silent."*
- **Dismiss unreachable by keyboard** (round 1, re-verified both widths): *"Focus the Dismiss
  button on the 49h blocked row and press Enter at 1366: the spec sheet opens and the session is
  not dismissed… The only control on a row that must be answered cannot be operated from a
  keyboard, and that row now stays there indefinitely."*
- **Session rows carry no age** — newly load-bearing now that blocked rows are unbounded:
  *"two rows for 004 sat adjacent — one blocked 13 days, one blocked 335 hours — and they are the
  same six words, twice."*
- **The badge still counts what Next suppresses** — 7 session rows in Next, `(11) Factory` in the
  title, including a blocked session on a `done` feature.

---

## Method note, worth keeping

UX recorded a trap for whoever reviews next:

> `FACTORY_URL=http://192.168.1.107:8088` is exported in the shell environment. My first run
> silently photographed the *live* board instead of my seeded instance and reported eight
> identical "MISSING" failures that were nothing of the kind. Any Playwright driver that does
> `process.env.FACTORY_URL ?? …` must be given an explicit URL.

Both instances reported build `d40e2163`, which is how the reviewer established it was driving the
deployed code rather than assuming it.

---

## Disposition

**Rework, round 2.** One defect, two halves, both in five lines of `scripts/runner.ts`:

1. Feed `idleCandidates` rows it can actually reason about, or drop the `busy` guard — but do not
   leave a ticked task describing a branch that cannot execute.
2. Bind the kill to an identity the reporter does not control. `#{session_path}` against the row's
   `cwd` is the cheap one and both reviewers independently proposed it.

Everything else round 1 asked for is genuinely in, and the `needs_you` fix is clean and verified in
a browser. No acceptance criterion is ticked while false this round; two *round 1 rework tasks*
are — the `busy` half of task 1, and the `tmuxAttached` test in task 5.
