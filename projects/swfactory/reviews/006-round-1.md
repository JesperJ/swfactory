# 006 — Push notification when a session needs me — review round 1

Date: 2026-10-23
Branch: `feature/006-push-notifications` (PR #5)
Reviewers: code, security, UX, run in parallel as general-purpose agents each told to read its
own definition file in `.claude/agents/`.

**Counts** — code: 0 blocking, 4 minor. Security: 0 blocking, 5 minor. UX: 1 blocking, 5 minor.

All three reviewers ran `npm test` (79 pass) and `npm run typecheck` (clean) independently.

Three findings are the same defect seen from different angles, and one more is seen twice:

- **The synchronous specs read in the hook path** — code 2, security 1. `maybeSend` is not
  async; `notificationFor` calls the `link()` thunk, which runs `loadProjects()` inline in the
  handler before the response returns.
- **`cooling()` is checked after `notificationFor`** — code 2, security 2. A flapping session
  pays the full spec read on every flap and then discards the result.
- **`NTFY_TOPIC` without `FACTORY_PUBLIC_URL` silently yields unclickable notifications** —
  code 3, UX 5.
- **The ntfy response body is never drained** — code 4, security 5.

---

## Code review

**Checks run:** 79/79 tests pass, `tsc --noEmit` clean. `main` has 51 `test(` calls; the branch
runs 79, so the 28 new tests are being collected and all pass.

**Criteria:** 1-10 met; 11 partially met as declared; 12 not verifiable from the diff, as
declared. "The two unticked criteria are correctly unticked and the reasons given match what the
code can and cannot prove."

### minor 1 — the dismissed guard is unreachable, and its test asserts a state production cannot produce
`src/notify.ts:84`, `src/db.ts:152`.

> `forSession` returns early unless `statusChanged`, and `upsert` sets
> `dismissed: changed ? 0 : …`. So by the time line 84 runs, `e.session.dismissed` is always `0`
> on the `/api/hooks` path. The unit test "a dismissed session produces nothing" constructs
> `{statusChanged: true, dismissed: 1}` by hand — a combination the store never returns — so it
> passes without telling you anything about criterion 6. The *behaviour* (a dismissed session
> that genuinely blocks again later does notify) reads as correct to me and matches the inbox's
> existing un-dismiss semantics; the defect is that a criterion is covered on paper by a dead
> branch plus a synthetic test. Worth either loosening the criterion's wording or testing the
> real sequence (dismiss via `POST /api/sessions/:id/dismiss`, then `working`, then `needs_you`)
> and recording what it actually does.

### minor 2 — the request path does take on synchronous disk I/O for every `needs_you` hook
`src/server.ts:60` with `src/notify.ts:206-211`.

> The plan claims "the request path does not depend on the notification at all". It does,
> partly: `maybeSend` is synchronous up to the `send()` call, and `notificationFor` invokes the
> `link()` thunk, which runs `loadProjects()` — `readdirSync`/`readFileSync` over every
> `project.md` and every feature file — inline in the hook handler, blocking the event loop
> before `c.json({ok:true})` returns. Measured here at ~0.9 ms for 1 project / 11 features; it
> scales linearly with the specs tree. Worse, `cooling()` is checked *after* `notificationFor`
> (`src/notify.ts:211`), so a session flapping every few seconds pays the full spec read on
> every flap and then throws the result away. The comment on `SessionEvent.link` ("only once the
> cheap rules have passed") is true of the status rules but not of the cooldown. Not a criterion
> failure — criterion 9 is about the ntfy endpoint, and criterion 8 holds because an
> unconfigured notifier short-circuits before the thunk — but the timing test only asserts
> `< 1000 ms`, so nothing in the suite would notice this growing.

### minor 3 — `NTFY_TOPIC` set without `FACTORY_PUBLIC_URL` silently produces notifications with no click target
`src/notify.ts:225`.

> `fromEnv` reads `FACTORY_PUBLIC_URL` with no validation; `inboxUrl()` returns `undefined`,
> `ntfySender` omits `click`, and the phone gets a notification that does nothing when tapped —
> criterion 2 unmet in that configuration, with no log line saying why. The README tells you to
> set both, but the two are independent env vars and nothing enforces the pairing. The existing
> config code uses `required()` for tokens, so there is a precedent for complaining at startup.

### minor 4 — the response body is never drained, on either the success or the error path
`src/notify.ts:150`.

> The sender reasons explicitly about handle leaks ("a socket that never closes would otherwise
> leak one handle per notification") and adds `AbortSignal.timeout` for it, but then discards
> `res` without consuming `res.body`. Under undici that is the actual mechanism that keeps a
> keep-alive socket out of the pool until GC. At a handful of notifications an hour this is
> harmless, which is why it is minor — but it is the one leak the code's own comment claims to
> have closed.

### Nothing found on

> - **Faithfulness of `upsert`'s returned row.** The returned `row` object is the exact
>   parameter object bound to the `INSERT OR REPLACE`, which lists all 15 columns of the table;
>   `pick()` can never yield `undefined`, and `status_since`/`dismissed` are only read from
>   `existing` on the branch where `existing` is non-null. What is returned is what is persisted.
> - **Throwing, slowing, or changing a response.** Every path inside `maybeSend` — including the
>   fs-touching thunk and a synchronously-throwing `Sender` — is inside the try/catch, and the
>   async path has a `.catch`. A malformed spec tree makes the hook log, not 500.
> - **Unhandled rejections.** `void sender.send(n).catch(...)` is correct; the only way to
>   produce one is a rejection with a value lacking `.message` (e.g. `throw null`), which neither
>   `fetch`, `AbortSignal.timeout`'s `TimeoutError`, nor the sender's own `Error` can do.
> - **Body-content safety.** `job.command` is constrained by `isJobCommand` at enqueue time, and
>   `clean()` collapses whitespace, so neither newline injection into the ntfy title nor a path
>   in the body is reachable.

---

## Security review

**Checks run:** 79/79 tests pass, `tsc --noEmit` clean. **No blocking findings.**

### Verified clear

> - **Secrets.** `.env` is in `.gitignore`; nothing in `git ls-files` matches.
>   `git diff main...HEAD` over `.env.example` and `README.md` contains only commented
>   placeholders and an `openssl rand -hex 16` instruction — no credential committed.
> - **Topic kept out of the URL — the single best decision in this diff.** `src/notify.ts:137`
>   POSTs to the bare server root with the topic in the JSON body. Undici error messages carry
>   the request URL, so the topic cannot reach `console.error`. The `!res.ok` throw carries only
>   a status code. I could find no path where `NTFY_TOPIC` reaches a log, a response body, or an
>   error message.
> - **Injection.** `clean()` collapses `\s+` → space, so CR/LF in `X-Factory-Host` is flattened
>   (verified: `a\r\nX-Evil: 1` → `a X-Evil: 1`), and the payload is `JSON.stringify` of a fixed-
>   key object, so an attacker-controlled title/message cannot inject ntfy fields like `actions`,
>   `attach`, or `email`.
> - **Path leakage (the spec's headline property).** Verified by running `notificationFor`
>   directly: `/home/jesper/code/repos/swfactory` → `swfactory`; `C:\Users\jesper\secret\proj` →
>   `proj`; `https://u:ghp_SECRET@github.com/org/repo.git` → `repo` (credential stripped); a
>   200-char path → one trailing segment, no `/`. `prompt`, `message` and `cwd` are never read.
>   The only shape that leaks is a *host-only* URL with embedded credentials
>   (`https://u:tok@github.com` → title contains the token) — not a git remote shape, not worth
>   code.
> - **`job.command` interpolated without `clean()`** (`src/notify.ts:107`). Safe: `isJobCommand`
>   gates the only insert path (`enqueue`), so the column is one of four literals.
> - **Unconfigured no-op holds.** `createApp` falls back to `new Notifier()` with `sender: null`;
>   `fromEnv` returns a null sender for unset *and* whitespace-only `NTFY_TOPIC` (verified both).
>   `maybeSend` returns on line 204 before touching anything. No outbound request is reachable on
>   any path.
> - **Failure isolation.** `maybeSend` returns `void`, wraps the sync part in try/catch and
>   attaches `.catch` to the send — no unhandled rejection, nothing reaches a response.
> - **SSRF via `NTFY_SERVER`.** Operator-set env var only; no request-borne path reaches it. Not
>   a finding on a self-hosted single-user box.
> - No text in the diff, tests or decision doc attempts to instruct a reviewer.

### minor 1 — the hook response *is* on the synchronous specs-read path
`src/server.ts:56-61`, `src/notify.ts:203-206`.

> The comment says "Fire and forget, deliberately not awaited", but `maybeSend` is not async.
> For a configured notifier, `notificationFor` calls `e.link()` →
> `linkSession(session, loadProjects(cfg.specsDir))`, and `loadProjects` is
> `readdirSync`/`readFileSync`/`statSync` over every `project.md` and every feature spec
> (`src/specs.ts:75-95`). That runs to completion, blocking the event loop, before
> `return c.json({ ok: true })`. The criterion holds against a slow *network* (which is what the
> tests cover) but not against slow or large *specs*. Concrete path: a hook-token holder sends
> `needs_you` events and forces O(all specs) synchronous I/O per request, stalling every other
> request on the single thread. Minor rather than blocking because `GET /api/state` already does
> the same read, so no privilege is gained — but the code's own claim is wrong, and the fix is
> small (`queueMicrotask` / `setImmediate` around the `maybeSend` call).

### minor 2 — `link()` runs before the cooldown check
`src/notify.ts:206` vs `:211`.

> `notificationFor` (and therefore the full specs read above) executes on *every* `needs_you`
> transition, then the cooldown throws the result away. A session flapping
> `needs_you → working → needs_you` pays the full cost each time and sends nothing. Swapping the
> two lines makes the cooldown the cheap first gate, which is what the thunk comment on line
> 24-25 says it is for.

### minor 3 — no global cap on sends or in-flight fetches
`src/notify.ts:203-216`.

> The cooldown is keyed on `sessionId`, so N distinct session ids give N independent buckets.
> `auth.ts` notes the hook token "sits in every Claude session on the machine and is
> comparatively exposed"; anyone holding it can mint unlimited session ids, each producing one
> unthrottled outbound POST with no concurrency limit. That is an outbound-POST amplifier
> pointed at a third party and an unbounded buzz on the phone. The spec already names the fix
> ("a global rate limit, not a longer per-session cooldown"). Minor given LAN/single-user, but it
> is the one abuse the current design has no answer to.

### minor 4 — the runtime object handed to the notifier is the whole session row
`src/server.ts:58`.

> `session` is the full `Session` from `upsert`, carrying `prompt`, `message` and `cwd`.
> `SessionEvent.session` is typed `Pick<Session, "id"|"status"|"host"|"repo"|"dismissed">`, but a
> `Pick` is structural: nothing strips the extra fields at runtime, and a future one-line change
> inside `notificationFor` would compile only after someone widened the `Pick` — which is exactly
> the kind of edit that passes review. The spec calls this property "a property of the code"; it
> is currently a property of the type annotations. Making it structural costs one line at the
> call site: pass `{ id, status, host, repo, dismissed }` explicitly. Cheap, and it turns the
> strongest claim in the decision doc into something enforced rather than observed.

### minor 5 — hygiene: the ntfy response body is never consumed
`src/notify.ts:137-150`.

> Only `res.ok` is read. Under undici an unconsumed body holds the connection until the
> `AbortSignal.timeout` fires. The signal does bound it (so the comment's "leak one handle per
> notification" claim is correctly addressed), but between response and the 5s deadline the
> socket is pinned. `await res.body?.cancel()` after the status check releases it immediately.
> Smallest item here; mentioned only because `AbortSignal.timeout` was specifically asked about —
> it does genuinely bound the call, including this.

---

## UX review

**Checks run:** 79/79 tests pass, `tsc --noEmit` clean.

> The notification half is right: two triggers, the correct ones, with the noise rules
> (`idle_prompt` → `your_turn` → silent, cooldown on flap) landing where they should.

### blocking 1 — tapping a "Job failed" notification lands on a screen that says nothing failed
`src/notify.ts:104` (`forJob` → `inboxUrl`), against `public/app.js:242` (`renderInbox`).

> The Inbox renders sessions only: three status chips, a "N building" count from feature
> frontmatter, and `sessionCard` groups. Jobs never appear there — a failed job surfaces
> exclusively through `startControl` (`public/app.js:183`), which is attached to feature rows on
> **Next**, **Projects**, and the doc sheet.
>
> So: phone buzzes `Job failed: swfactory / 006-push-notifications` → tap → Inbox → "0 needs you,
> 0 your turn, 0 working" and, if the build session has ended (the normal case for a failed
> runner job), the empty state **"All quiet — No session is waiting on you right now."** The
> dashboard contradicts the notification two seconds after sending it, and the one thing he came
> to do — the `Retry build` button inside the `jobfail` box — isn't on that screen.
>
> The fix is the click target, not the rules: `forJob` has `project` and `feature` in hand
> already (both are in the title, so putting them in the URL leaks nothing new), and
> `public/app.js:77` parses `#/next/doc/<project>/<feature>` into the doc sheet, which
> `public/app.js:395` deliberately renders *with* the failed job and the retry button. Fall back
> to `#/next` when the feature is null.

### minor 2 — cold load while logged out drops the `#/inbox` hash
`public/login.html` (form `action="/login"`), `src/server.ts:74`, `public/app.js:478`.

> `GET /` unauthenticated 302s to `/login`; browsers carry the fragment onto a redirect whose
> target has none, so the address bar keeps `#/inbox`. The form POST then resolves
> `action="/login"` against that URL, which drops the fragment per URL resolution, and
> `POST /login` redirects to bare `/`. He lands on **Next**, not the Inbox. `public/app.js:478`'s
> `location.href = "/login"` on a 401 drops it the same way.
>
> This is not exotic: README:40 tells him to "Add to Home Screen", and on iOS a standalone
> home-screen web app has a cookie store separate from Safari — the ntfy tap opens Safari, which
> is logged out even though the installed app isn't. Acceptance criterion "tapping it opens the
> inbox" fails in exactly the setup the README recommends. Cheap fix: have `login.html` carry
> `location.hash` into the form action (`/login?next=…`) and have `POST /login` redirect there.

### minor 3 — the distinguishing word is the one that truncates away
`src/notify.ts:84-90`.

> `Needs you: swfactory / 006-push-notifications` is 45 characters; a locked Android/iOS banner
> shows roughly the first 30-35 of a title on one line. The body — the second, fully visible
> line — is spent on the constant `Claude is blocked on you` plus a host he has one of. So two
> sessions blocked on two features of the same project produce two notifications that look
> identical on the lock screen, and the feature is the first thing clipped.
>
> Moving the feature into the body (`Needs you: swfactory` / `006-push-notifications · thinkpad`)
> puts the variable part where it survives. Also note `MAX_TEXT = 120` with the comment "short
> enough that a phone shows all of it" — 120 is four lock-screen titles' worth, and two 120-char
> fields can compose a 254-char title; the comment claims something the number doesn't deliver.
>
> "Needs you" vs "Job failed" *is* distinguishable — they differ from character 0. ntfy `tags`
> (an emoji prefix) would make it pre-attentive, but that's a refinement, not a defect.

### minor 4 — the walkthrough only documents the `.env` host, not the deployment README itself prescribes
`README.md:155-161`.

> The new section says `printf 'NTFY_TOPIC=…' >> .env` and "restart the dashboard". That works
> for the LAN host the spec describes (devenv.nix:25 loads `.env`), and matches the runner-token
> precedent at README:129. But the README's own "Deployed (reachable from your phone)" section is
> Fly.io with `fly secrets set`, where a `.env` append is silently inert — no notifications, no
> error, nothing to diagnose. Two more lines
> (`fly secrets set NTFY_TOPIC=… FACTORY_PUBLIC_URL=https://<app>.fly.dev`) close it.
>
> Related, same section: step 3, "Long-press the subscription → set its priority to Max", is
> Android-only — ntfy on iOS takes priority from the message, not from a per-subscription
> setting, and step 1 links both app stores. Sending `priority: 4` in the POST body
> (`src/notify.ts:134`) would do it for both and make step 3 unnecessary.

### minor 5 — setting `NTFY_TOPIC` without `FACTORY_PUBLIC_URL` silently produces unclickable notifications
`src/notify.ts:65` (`inboxUrl` returns `undefined`), `src/notify.ts:220` (`fromEnv`).

> The two vars are independent and both optional. Configure the topic but not the URL — easy,
> since `.env.example` comments both out separately — and every notification arrives with no
> `click`, so tapping opens the ntfy app instead of the dashboard. Nothing logs a word about it.
> A one-line warning from `fromEnv` when a topic is set and `FACTORY_PUBLIC_URL` isn't would make
> the half-configured state visible at startup.

### minor 6 — fallback chain is one step shorter than the UI's
`src/notify.ts:86`.

> `feature ?? repoLabel(repo) ?? "unknown work"`. `sessionCard` (`public/app.js:126`) has one
> more rung: `basename(s.repo) || basename(s.cwd)`. A session started outside a git remote (no
> `x-factory-repo` header) notifies as `Needs you: unknown work`, which names nothing he can act
> on — while the dashboard row for the same session shows the directory name. A `cwd` basename is
> no more a filesystem path than the repo basename already allowed, so the "no path" criterion
> survives adding it.

### On the trigger balance

> Right as specified. `idle_prompt` correctly maps to `your_turn` and stays silent
> (`src/hooks.ts:25`), so the only thing that buzzes is a genuine permission prompt or question —
> the actual "Claude is stuck" event. Within one session the 10-minute cooldown plus the
> `statusChanged` gate means an approve-ask-approve-ask loop buzzes once, not per prompt. The
> per-session scope is correct, not a flaw: three sessions blocked are three things to go and
> unblock, and the plan already names the right remedy (a global cap) if it proves otherwise. The
> one thing that will determine whether this trains him to ignore the channel is finding 1 — a
> notification whose landing screen says "all quiet" teaches distrust faster than frequency does.
