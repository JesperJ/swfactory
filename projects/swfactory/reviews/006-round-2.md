# 006 — Push notification when a session needs me — review round 2

Date: 2026-10-23
Branch: `feature/006-push-notifications` (PR #5), at `62228bb`
Reviewers: code, security, UX, run in parallel as general-purpose agents each told to read its
own definition file in `.claude/agents/`. Each was given its own round-1 findings and asked to
say whether they were genuinely resolved or only apparently so.

**Counts** — code: 0 blocking, 3 minor. Security: 0 blocking, 4 minor. UX: 0 blocking, 3 minor.

All three ran `npm test` (89 pass) and `npm run typecheck` (clean). UX verified against a live
dashboard at 390px with real Chromium.

**Round 1's blocking finding is genuinely resolved**, measured rather than read: a cold load of
`#/next/doc/swfactory/006-push-notifications` at 390×844 opens the sheet by itself, shows
`.jobfail-why`, and puts a 113×44px Retry button above the fold.

**Two round-1 minors were not taken, and the spec's Log wrongly recorded all eleven as done** —
security 3 (no global cap) and UX 2 (logged-out cold load drops the hash). Security 4 was taken
for sessions and not for jobs.

Convergent in round 2:
- **`clean()` truncates before `lastSegment()` splits** — code 1, security 4, UX 1. All three
  found it independently. Introduced by the rework: `MAX_TEXT` dropped 120→60 and `cwd` became
  an input, so an ordinary long path now names a middle component, or nothing at all.
- **The job call site still hands over the whole row** — code 2, security 1. The session call
  site was fixed; the job one, whose row carries `error`, was not.

---

## Code review

**Checks run:** 89/89 tests pass, `tsc --noEmit` clean, at `62228bb`.

**Criteria:** 1-10 met; 11 partially met as declared; 12 not verifiable from the diff, as
declared. Criterion 1 has a reachable edge where it does not hold — see minor 1.

### Round-1 findings: genuinely resolved?

> | Round-1 finding | Status |
> |---|---|
> | **UX blocking 1** — job tap lands on the Inbox | **Genuinely resolved.** `forJob` emits `#/next/doc/<project>/<feature>`. Verified against `public/app.js:76-83`: `parseRoute` splits on `/` *then* `decodeURIComponent`s, so `%2F` in a slug survives; `docAt = parts.indexOf("doc") = 1` → `tab:"next"`, `doc:{project,feature}`. Verified the sheet actually renders the job: `public/app.js:395` → `startControl` → the `jobfail` box with Retry. Its three suppression conditions are unreachable for a real failed job — `scripts/runner.ts:131` marks a dead tmux session **done**, never **failed**. |
> | code 1 — dismissed guard tested with a state the store can't produce | **Resolved.** The new test runs dismiss → `UserPromptSubmit` → `Notification` through real endpoints and advances the clock past the cooldown first, so it tests the dismissed rule and not the cooldown. |
> | code 2 / sec 1 — synchronous `loadProjects()` in the hook path | **Resolved.** `setImmediate` at `src/notify.ts:241`; a test asserts the link thunk is untouched inside the caller's turn. |
> | code 2 / sec 2 — cooldown checked after `notificationFor` | **Resolved.** `src/notify.ts:254-255` gates before the thunk; a test counts thunk invocations. |
> | code 3 / UX 5 — `NTFY_TOPIC` without `FACTORY_PUBLIC_URL` | **Resolved.** `fromEnv` warns; tested both directions. |
> | code 4 / sec 5 — ntfy body never drained | **Resolved**, and correctly placed *before* the `!res.ok` throw, so the error path drains too. |
> | sec 4 — whole session row handed to the notifier | **Resolved for sessions. Not for jobs** — see minor 2. |
> | UX 3 — feature in the title | **Resolved.** |
> | UX 4 — `.env`-only walkthrough, Android-only priority step | **Resolved.** |
> | UX 6 — fallback one rung shorter than the UI's | **Resolved.** |
> | **sec 3 — no global cap on sends or in-flight fetches** | **NOT addressed.** |
> | **UX 2 — logged-out cold load drops the `#/inbox` hash** | **NOT addressed.** |
>
> The spec Log at line 194 says *"Round 1 rework done: the blocking finding and all eleven
> minors."* Two of them were not taken. Deliberate deferral is fine; the Log recording them as
> done is not.

### minor 1 — `clean()` truncates before `lastSegment()` splits, so a repo URL or cwd over 60 characters names the wrong thing, or nothing at all
`src/notify.ts:57-66`, with `MAX_TEXT = 60` at `:43`.

> `lastSegment` calls `clean(v)` *first*, which clips to 59 chars + `…`, and only then splits on
> `/`. The segment it pops is therefore from the truncated prefix, not the real basename. The
> rework made this reachable in two ways at once: `MAX_TEXT` dropped 120→60, and `cwd` — which
> is always a full path — became an input. Run directly:
>
> ```
> cwd /home/jesper/code/repos/acme-corporation/services/billing-gateway (65)
>   → "Needs you: billing-g…"
> cwd /Users/jesper/Library/Mobile Documents/com~apple~CloudDocs/work/widget (70)
>   → "Needs you: …"
> repo https://git.enterprise.example.com/departments/platform-engineering/infra-tools
>   → "Needs you: platform-eng…"   (names the wrong repository)
> ```
>
> No path leaks — criterion 7 holds — but criterion 1's "naming the repo when no feature
> matched" does not, for the exact case UX minor 6 added `cwd` for: a session outside a tracked
> project, which is where deep paths live. The second example names nothing at all. The existing
> tests use 33- and 38-char paths, so nothing in the suite notices.

### minor 2 — the job call site still hands the notifier the whole row, which is what the session call site was changed to stop doing
`src/server.ts:185` against `JobEvent.job` at `src/notify.ts:34`.

> Round 1 sec 4 was taken for sessions: `src/server.ts:58-65` now builds the projection field by
> field, and `src/notify.ts:22-24` writes down why ("a `Pick` is a compile-time shape… one
> careless edit from the body"). The job path was left as the full `Job` row, which carries
> `error` — runner output that `src/notify.ts:128` explicitly reasons about as being able to
> carry paths — plus `session_id`. The reasoning the diff states about itself applies more
> strongly here than where it was applied, and the asymmetry is the thing a future edit will
> trip over.

### minor 3 — one notification test passes with the notifier entirely disabled
`test/server.test.ts`, "Stop and SessionEnd notify nothing".

> I mutation-tested the async suite. Replacing `setImmediate(() => this.deliver(event))` with a
> no-op fails 13 tests; delaying delivery by one extra loop turn fails 11. This test survives
> both: it only asserts `sent.length === 0` and has no positive control in the same test, so it
> would pass if `maybeSend` were deleted.

### Checked and clear

> - **Could the new async tests pass spuriously?** No. One `await flush()` is exactly enough and
>   is not luck: `maybeSend`'s `setImmediate` is always queued inside the caller's synchronous
>   turn, before the test's own `setImmediate`, and the check-phase queue is FIFO. The two
>   mutations above confirm the suite is sensitive both to "never delivers" and to "delivers one
>   turn later"; only minor 3 survives.
> - **Error isolation from the detached callback.** Total for every real caller. Two theoretical
>   escapes exist and I confirmed them at runtime, but neither is reachable with the shipped
>   sender.
> - **Rule drift between `sessionWouldNotify` and `forSession`.** None — `forSession` calls it as
>   its first line, so there is one copy.
> - **Cooldown placement** cannot change behaviour: the only way `forSession` returns `null` is
>   `!sessionWouldNotify`, which `deliver` has already checked.
> - **`upsert`'s returned row** is the exact object bound to the `INSERT OR REPLACE`.

---

## Security review

**Checks run:** 89/89 pass, `tsc --noEmit` clean, at `62228bb`. Findings each reproduced by
executing the code, not read off. **0 blocking, 4 minor.**

### Status of round-1 findings

> | Round 1 | Verdict |
> | --- | --- |
> | **1 — hook response on the synchronous specs-read path** | **Genuinely resolved.** Instrumented `link()`: call count is `0` immediately after `maybeSend` returns, `1` after the next `setImmediate` tick. |
> | **2 — `link()` ran before the cooldown** | **Genuinely resolved.** Second `needs_you` inside the window: `link` calls stay at 1, sends stay at 1. |
> | **3 — no global cap** | **Not taken.** Still minor, but marginally worse than round 1, not better. |
> | **4 — whole session row handed to the notifier** | **Only half resolved.** Fixed for sessions, verified. **Not fixed for jobs.** |
> | **5 — response body never drained** | **Genuinely resolved, and correct on both paths.** `await res.body?.cancel().catch(() => {})` sits *before* the `!res.ok` throw. `?.` makes a null body a no-op; the `.catch` means a cancel failure cannot mask the status error. |

### minor 1 — the job trigger still hands the notifier the whole row, `error` included
`src/server.ts:185`, against `src/notify.ts:34` and the comment at `src/notify.ts:128`.

> Executed against a real store:
>
> ```
> object handed to notifier.maybeSend:
> {"id":1,"project":"p","feature":"f","command":"build","status":"failed",
>  "error":"/home/jesper/SECRET/PATH: boom","session_id":null, ...}
> ```
>
> `error` is runner-supplied and is exactly the "absolute path" the headline criterion forbids.
> Nothing reads it today, so no path leaks now — but the reasoning that justified the session fix
> applies verbatim. The rework made the session claim structurally true and left the job claim a
> type annotation. Fix is the same six lines already written next door.

### minor 2 — no global cap, jobs are not cooled at all, and `priority: 4` now rides every message
`src/notify.ts:147`, `:239-256`.

> The spec's argument — per-session is correct because two blocked sessions are two things
> needing you — holds for the *session* trigger. It does not cover two things the rework
> introduced or left:
>
> - Jobs are deliberately uncooled. `previousStatus === "failed"` blocks a re-report, but a
>   runner-token holder can cycle `running → failed → running → failed` and get one POST per
>   cycle, unthrottled, with no concurrency limit on the in-flight fetches.
> - Sessions remain uncapped across ids: the hook token "sits in every Claude session on the
>   machine", and N minted session ids give N independent buckets.
> - `priority: 4` is now unconditional. On ntfy that is "high" — not `5`/max, so it does not
>   bypass a Do Not Disturb channel setting. But it does defeat the ordinary "let it buzz
>   quietly" muting the spec's own out-of-scope section leans on, so the cost of each
>   unthrottled message went up while the throttle stayed the same.
>
> Still minor on a single-user LAN box. But the spec's "the fix is a global rate limit" is now
> one notch more true than it was in round 1, and the out-of-scope line that justified skipping
> it is one notch less true.

### minor 3 — the detached callback can take the process down on a non-`Error` rejection
`src/notify.ts:261`, same shape at `:265`.

> The `.catch` handler itself does `(err as Error).message`. A `Sender` rejecting with
> `null`/`undefined` makes that handler throw, rejecting the `void`ed promise with nobody
> attached:
>
> ```
> TypeError: Cannot read properties of null (reading 'message')
>     at src/notify.ts:261:83
> exit=1
> ```
>
> Unreachable with the shipped sender. What changed is the blast radius: in round 1 this would
> have failed one request; now it is an orphaned `setImmediate` callback with no request to
> attribute it to — precisely the failure mode the comment claims to have closed.
> `err instanceof Error ? err.message : String(err)` — one line, in two places.

### minor 4 — `clean()` clips to 60 chars *before* `lastSegment()` splits
`src/notify.ts:43`, `:57-66`. Same defect code 1 and UX 1 found.

> Not a path disclosure — I could not construct any input where a `/` or `\` survives, because
> `pop()` runs after the split regardless. But it names a parent directory instead of the
> working directory, and the UI shows the correct basename for the same session. `MAX_TEXT`
> dropping 120 → 60 made this reachable at ordinary path lengths. Swap the order.

### Verified clear

> - **The reduction is airtight for the "no absolute path" criterion.** Executed `notificationFor`
>   over `/`, `//`, `///`, `""`, `" "`, `\`, `C:`, `C:\`, `C:\Users\j\proj`, `\\server\share\proj`,
>   trailing slashes, a relative path, an RTL-override char, an embedded newline, `.git`, scp-form
>   and https-form remotes, and a remote with a path in its query string. No output ever contains
>   a separator.
> - **Repo credentials.** `https://u:ghp_…@github.com/org/repo.git` → `repo`. `MAX_TEXT` 60 now
>   truncates a host-only-URL token mid-way, so the rework made this marginally better.
> - **The startup warning cannot print the topic** — a fixed string naming only variable *names*.
> - **The new click target cannot be pointed anywhere.** `encodeURIComponent` escapes `/ \ # ? :`
>   — `"../../evil"` → `..%2F..%2Fevil`, `"javascript:alert(1)"` → `javascript%3Aalert(1)`, all
>   still inside `<base>/#/next/doc/…`. Both components are already constrained to slugs that
>   exist in the specs tree. Client side, `parseRoute` uses them only in comparisons, never
>   interpolated into `innerHTML`.
> - **Topic still out of the URL**, so undici's URL-carrying errors cannot leak it.
> - **Injection.** Fixed-key `JSON.stringify`; `priority` is a module constant, not settable.
> - **Unconfigured no-op intact. Failure isolation intact. Secrets clean** — `.env` ignored, tree
>   clean, the only `ghp_` hit in the diff is a placeholder inside the round-1 review prose.

---

## UX review

**Checks run:** 89/89 pass, typecheck clean, plus a live dashboard at 390px with real Chromium.

> **Overall: the feature now does the job it claims.** The job notification lands somewhere that
> shows the failure and offers the fix, and the lock-screen text puts the varying part where it
> survives.

### Round-1 findings

> **blocking 1 — genuinely resolved.** Not just apparently. Measured live: seeded a failed
> `build` job, then cold-loaded `#/next/doc/swfactory/006-push-notifications` at 390×844:
> `#sheet` is `hidden:false, open:true` after the single navigation — the sheet opens itself, no
> second tap. `.jobfail-why` reads "Failed. runner: claude exited 1 before reporting"; the retry
> button is **113×44 px** at y=531 in an 844px viewport — above the fold, no scroll. No console
> errors. The no-feature fallback renders the same `.jobfail` box on `#/next`.
>
> **minor 3 (truncation) — resolved for the paths that matter.** Measured: `Needs you: swfactory`
> (20) / `006-push-notifications · thinkpad` (33); `Job failed: swfactory` (21) /
> `006-push-notifications · /factory build` (39). Both titles clear a 30–35 char clip, and the
> body now carries the part that distinguishes two sessions on two features of the same project.
> The `body()` dedupe works: no case where the body is empty or repeats the title.
>
> **minor 4 (README) — half resolved.** `priority: 4` is right, and I verified rather than
> assumed: ntfy documents message priority on all three platforms, and 4 "high" gives "long
> vibration burst, default notification sound with a pop-over notification". 5 only lengthens the
> vibration. The Fly block has a defect — new finding 2.
>
> **minor 5 — resolved, and actionable.** Names both variables and the consequence, fires once
> at startup, goes to stderr so `fly logs` shows it.
>
> **minor 6 — resolved as a chain**, but the rung is broken for long paths — new finding 1.
>
> **minor 2 (logged-out hash drop) — confirmed NOT fixed; re-judged, still minor.** Measured end
> to end: deep link → `http://host/login#/next/doc/...` (fragment survives the 302) → submit →
> final URL `http://host/`, title "Next", sheet hidden. It costs *less* than I expected: the new
> victim's consolation prize is Next, which is the one screen that *does* render `.jobfail` boxes
> — confirmed in the logged-out screenshot. So the deeper link degrades to a usable screen rather
> than a contradicting one. It only degrades further once the failed feature falls outside Next's
> hero + 4 alternates. Still worth the one-line `?next=` fix, because README:40's "Add to Home
> Screen" means the *first* tap on iOS always goes through Safari's separate cookie store.

### minor 1 — a long working directory makes the notification name a mangled fragment, or nothing at all
`src/notify.ts:46-64`, reachable via the new `cwd` rung.

> | cwd | real basename | title sent |
> | --- | --- | --- |
> | `/home/jesper/code/repos/swfactory` (33) | `swfactory` | `Needs you: swfactory` ✓ |
> | `/home/jesper/code/repos/swfactory/.claude/worktrees/006-push-notifications` (74) | `006-push-notifications` | **`Needs you: 006-pus…`** |
> | `/Users/jesper/Library/Mobile Documents/com~apple~CloudDocs/work/clientproj` (74) | `clientproj` | **`Needs you: …`** |
>
> The last row is a notification whose title is a bare ellipsis — it names nothing, which is
> worse than the `"unknown work"` it was added to avoid, because it reads as a rendering bug. The
> basename is 10 characters; the cap is 60; nothing about it needed clipping. Minor — but minor
> 6's stated goal, "named the same way in both places" as `sessionCard`'s `basename()`, is not
> met until the last segment is taken before cleaning rather than after.

### minor 2 — the Fly.io block generates a topic and then discards it, while the next step says to read it from `.env`
`README.md:163-171` against step 2 at `README.md:180`.

> `fly secrets set NTFY_TOPIC="factory-$(openssl rand -hex 16)"` expands the topic in the shell,
> ships it, and never prints it — and the README's own next line says the value is not shown by
> `fly secrets list`. Step 2 then instructs "paste the topic exactly as it is in `.env`", but the
> Fly path never writes a `.env`. Someone following the new block on a clean phone reaches step 2
> with no way to learn the topic they just set, and the only recovery is to set a second one.
> This is the one place the walkthrough does not read correctly end to end.

### minor 3 — the landing screen's one button can run a different command than the one the notification said failed
`public/app.js:188` reached from `src/notify.ts:127`.

> Observed live, not hypothesised. Notification: `Job failed: swfactory` /
> `006-push-notifications · /factory build`. Tap → doc sheet → the button reads **"Retry review"**
> and queues `review`, because `startControl` labels from the feature's *current* recommended
> action while `jobFor` matches the failed job by project+feature only, ignoring its command. The
> window is "the job got far enough to advance the feature's status, then failed" — a build that
> reached `reviewing` and then died, which is exactly the half-finished failure worth notifying
> about. The person is told build failed and handed a button that reviews. Pre-existing
> `startControl` behaviour, but the new click target points him straight at it.

### Nothing found on

> - **Noise.** Unchanged and still right: two triggers, `idle_prompt`→`your_turn` stays silent,
>   the cooldown gates before the specs read without changing what gets sent.
> - **Dead ends from the new link.** `closeSheet()` arriving externally sets `#/next`, a real
>   screen. Swipe-down and the close button both work at 390px.
> - **The `#/next/doc/…` encoding** — a slash in a slug cannot break out, and there is a test.
