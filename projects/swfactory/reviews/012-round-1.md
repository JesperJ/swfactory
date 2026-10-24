# 012 — Next as a table, and the lifecycle made visible — review round 1

Date: 2026-10-24
Merged as PR #6; reviewed after the fact, so `main` already carries one fix that landed via 013.
Reviewers: code, security, UX, run in parallel.

**Counts** — code: 1 blocking, 1 minor. Security: 0 blocking, 1 minor. UX: 0 blocking,
2 minor/moderate. One finding is new and in none of the three categories above: the table
breaks at its own breakpoint.

---

## Code review

**Checks run:** 123/123 tests pass, typecheck clean — with a caveat the reviewer raised itself:

> `main` already contains a post-012 CSS fix from 013's rework, so a clean run on `main` does
> not mean 012 as merged was clean.

### blocking 1 — the `nowrap` bug shipped unverified, and was fixed by accident
`public/styles.css:466` as merged at `90087d1`.

> `.jobfail-why` is built to wrap (`width: 100%; overflow-wrap: anywhere`), but it lives inside
> `.c-action`, and `white-space: nowrap` on the ancestor overrides that — nowrap always wins
> over overflow-wrap when deciding whether to break at all. Any row with a failed or stale job
> and a non-trivial reason renders one unbroken line, pushing `scrollWidth` past the viewport.
>
> It was not caught by `npm run shoot` because, per the spec's own Log, no failed job existed
> in the dashboard state when shoot was run that session. It was fixed later, but not by any
> review of 012 — it was one of "three local fixes" bundled into 013's round-1 rework.
>
> As merged at `90087d1`, 012 did not satisfy this criterion; the fix exists on `main` today but
> landed outside 012's own process.

The real finding is about the check, not the CSS: a visual test that only runs against whatever
state happens to exist is not a test of the states that matter.

### minor 2 — the row's "open spec" affordance is no longer keyboard-reachable
> Before 012, each row was a real `<a class="nextrow" href=...>` — focusable and
> Enter-activatable. The table row is now a plain `<tr data-open="...">` with the open-behavior
> wired only through a document-level `click` listener; it has no `tabindex`, role, or keydown
> handling. A keyboard-only user tabbing through Next now skips straight from one row's action
> button to the next row's, with no way to reach a feature's spec from this view.
>
> No acceptance criterion names keyboard access, so this doesn't fail a written criterion, but
> it is a real loss of a path a real user previously had.

### On the density criterion
> The number is the wrong thing to argue with directly... getting there means a materially
> sparser row (likely losing the Status column text or the secondary line) at odds with the
> "the columns you actually compare on" goal the spec itself sets. I'd treat this as a
> density/legibility trade-off for the user to call, not a thing the builder under-delivered on.

Also noted: `.prio.p-P3` has no colour rule, so P3 is visually identical to no priority.

---

## Security review

**0 blocking.** 123/123 pass, `.env` untracked, no new exposure in `/api/state` —
`lifecycle` is a six-bucket rollup, strictly less granular than data already sent.

### minor 1 — the one unescaped interpolation in the file
`public/app.js`, `lifecycleStrip()`:

> `s.status` is interpolated into the `aria-label` **without** `esc()`. Everywhere else
> `status` is rendered it goes through `esc()` — this one spot was missed.
>
> `lifecycleCounts()` deliberately includes any status found in frontmatter that is not one of
> the six known ones, specifically so a typo isn't silently dropped. That status string comes
> straight from `str(data.status)` with no character restriction. A feature spec with
> `status: foo" onmouseover="alert(1)` would flow through unescaped into this attribute.
>
> Exploitability is low in practice: specs come from the user's own repo, so this is
> realistically self-XSS, not a remote-attacker path. It's flagged because the fix is a
> one-token change and the repo is public.

The decision that makes unknown statuses visible is the same decision that lets an arbitrary
string reach the attribute — worth knowing, and not a reason to reverse it.

### Checked and cleared
- Every other interpolation in the table markup goes through `esc()`.
- Row click → `openDoc`: *"`data-open` is built from `docHash()`, which runs `project`/`feature`
  through `encodeURIComponent` before the whole string is HTML-escaped... so the click handler's
  split/decode round-trip can't be confused by a slug containing literal slashes, quotes, or `%`."*
- `statusClass()` uses an allowlist — *"this is the safe pattern the aria-label line should have
  matched."*
- `localStorage` sort preference: guarded read, value validated against `SORTS` before use.

---

## UX review

Ran `shoot`, then took a dozen more screenshots the stock script does not cover: desktop dark
Projects, both sort states, and a sweep of widths between 700 and 1250px.

> **Does the table solve the stated problem?** Yes, at its intended width... Comparing two items
> — the thing the spec says was impossible before — now genuinely takes one glance.

### moderate 1 (new) — the table breaks at exactly its own breakpoint
> The desktop table and the sidebar both switch on at `min-width: 900px`. That means at the
> exact width where the table layout turns on, it also has the least room: sidebar is a fixed
> 248px, so the table gets squeezed into the remainder.
>
> **At 900px wide: real horizontal overflow** — `scrollWidth 935 > innerWidth 900`. This is
> precisely the failure mode the spec called out for phone — except it's happening on desktop,
> at the literal breakpoint the devs chose.
>
> From 950–1100px there's no overflow, but every row — not just failure rows — wraps to
> 100–140px tall (vs ~82px at 1366px)... A non-maximized browser window, a 13" laptop not at
> full width, or a split-screen session will land in this band often. In that range the table
> is worse than the hero-plus-cards it replaced.
>
> `npm run shoot` wouldn't catch this because it only shoots 390 and 1366.

Suggested fix: switch the table to the phone layout later than the sidebar (≈1024px), or let a
column drop before anything wraps.

### minor 2 — the retry button is a more targeted lever than shrinking every row
> The retry button sits on its own line below the reason text rather than trailing it inline.
> Putting it inline would meaningfully cut these rows' height without touching normal-row
> density, which more directly attacks the "12 rows" goal than shrinking every row would.
>
> The dataset in this review happens to have 3 of 11 rows carrying a failure block, driven by an
> operational hazard already logged in the spec — not a steady-state ratio.

### On the density criterion — the most useful thing in the round
> I think the fixed-count framing is the wrong tool, not necessarily the wrong ambition. Three
> separate things get bundled into one number: fixed chrome (~160px), a normal row's height
> (~82px), and the failure block's extra height (which varies with how many items are currently
> broken, a property of the data, not the table). A fixed row-count target on a fixed viewport
> conflates all three, so it will drift depending on what else happens to be failing that day.
>
> I'd reframe it as something that isolates the actual design lever: e.g. "a row without a
> failure block is ≤~60px" and "a failure block adds no more than one row's worth of height"...
> the way it's currently written isn't measuring the table's design so much as measuring today's
> incident count.

### Confirmed working
The lifecycle strip on desktop, in dark mode, and as a 3-column grid below 600px; counts adding
up to the project total; empty stages dimmed not hidden; the sort toggle producing a visibly
different, readable order. Phone layout usable at 390px with 44px tap targets.

Noted, by design rather than defect: session rows carry no priority or status, *"which means the
row most worth comparing (the thing ranked #1) is exactly the row where the Priority column is
blank."*

Minor drift from the written plan: the compact priority/project line renders below the title
rather than above it.
