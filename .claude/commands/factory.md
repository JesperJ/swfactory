---
description: Run the factory line - next, project, spec, plan, build, review, approve, rework, status
argument-hint: next | project <idea> | spec <idea> | plan <id> | build <id> | review <id> | approve <id> | rework <id> <note> | status
---

Run the factory. Input: `$ARGUMENTS`

The first word is the sub-command. Everything after it is its argument. With no argument at all,
behave as `next`. Follow only the matching section below.

## Rules that apply to every sub-command

- **Decide, don't ask.** Make the call and state it in one line. Escalate only what is
  expensive, irreversible, commercial, or a matter of taste.
- **Be short.** Reply with the outcome and the next action. Detail belongs in the spec file.
- **Statuses are owned by this command**, never set by hand and never skipped forward. The
  lifecycle is `idea → specced → planned → building → reviewing → done`. Only `approve` may
  set `done`.
- A feature id may be `008`, `swfactory/008`, or a slug. If the project is ambiguous and more
  than one exists, say so and stop.
- The specs live in `projects/` in the factory repo. From a project's own repo, look for
  `$FACTORY_HOME/projects`, then `../swfactory/projects`.
- Every sub-command that changes a spec commits it: `factory: <sub> <project>/<NNN>`.

---

## next

Do the single most useful thing, without being told what it is.

1. Read the dashboard's ranking: `GET $FACTORY_URL/api/state` (it needs the session cookie, so
   if that fails, fall back to computing the same thing from the specs: a feature in
   `reviewing`, then a stalled `building`, then `building`, `planned`, `specced`, `idea`, with
   blocked features last).
2. Take the top item that is not blocked. Say in one line what it is and why it ranks first.
3. Run the matching sub-command below for it — `Review` → `review`, `Build` → `build`,
   `Plan` → `plan`, `Spec` → `spec`, `Continue`/`Unstick` → `build`.

Do not ask which one. The ranking already decided; a confirmation step would hand back the
decision this command exists to absorb.

---

## project `<idea>`

Start a new project. This is the one place a few questions are worth it: a wrong project
premise costs more than a wrong feature, and there is no existing context to draft from.

1. Ask at most 5 short questions, in one message, covering only what you cannot infer: who it
   is for, the core problem, constraints (stack, hosting, deadlines), what is explicitly out of
   scope, and the code repo URL if one exists.
2. Pick a short kebab-case slug. Write `<specs>/<slug>/project.md` from `templates/project.md`.
   Fill every section; anything you cannot fill goes under Open questions rather than being
   left as placeholder text.
3. Propose 3 to 7 first features as one-liners. Do not create them yet.
4. Commit `factory: new project <slug>`, and say that `/factory spec <slug> <idea>` comes next.

---

## spec `<idea>`

Draft a feature spec. Propose, don't interview. Do not open with questions.

1. Read the project's `project.md` and the existing feature titles and statuses so you don't
   duplicate one.
2. Write the whole spec now from the project context and the idea given, using
   `templates/feature.md`. Fill Why, What, Acceptance criteria (observable and testable), and
   Out of scope. Make the obvious calls yourself. Where you assumed something, record it under
   Open questions as the assumption you made — a decision to overturn, not a question to answer.
3. Number it: next free 3-digit id. Write `<project>/features/<NNN>-<kebab-slug>.md` with
   `status: specced`.
4. Reply with the acceptance criteria only, plus any assumption worth challenging.

Stop and ask first only if the idea is too vague to draft anything honest, or if it is really
two features and the split changes what you would write.

---

## plan `<id>`

1. Open the spec. If its status isn't `specced` or `planned`, say why and stop.
2. Read the project's code repo properly: structure, conventions, tests. If it isn't available
   in this session, say so and stop rather than planning blind.
3. Fill `## Plan`: approach, files and modules touched, data or API changes, which test proves
   each acceptance criterion, and risks. Where two approaches were close, name the one you chose
   and why in one sentence. Never present a menu.
4. Fill `## Tasks`: small steps, each independently verifiable, ordered so tests pass after
   every one. Prefer 3 to 10.
5. Record anything significant and hard to reverse as
   `<project>/decisions/<YYYY-MM-DD>-<slug>.md`.
6. Set `status: planned`, add a Log line, commit.
7. Reply with the approach in two or three lines and the task count.

---

## build `<id>`

This is spec-driven, not vibe coding. Build what the spec and plan say. If reality disagrees
with the plan, stop, update the plan in the spec, say so in one line, and carry on.

1. Open the spec. Status must be `planned` or `building`, else stop and name the sub-command
   that comes first.
2. Work in the project's code repo on branch `feature/<NNN>-<slug>`, so the dashboard links
   sessions to the feature. Set `status: building` and add a Log line.
3. For each unchecked task, in order:
   - implement it, with tests for the acceptance criteria it covers;
   - run the repo's tests, linter and type checker, and fix failures before moving on;
   - tick the task in the spec and commit in the code repo, naming the task.
4. When every task is done, check each acceptance criterion against the running code or tests.
   Tick it only if you verified it. Anything unverified stays unticked with a note saying what
   was not checked and why.
5. Push the branch and open a PR that links the spec. Add the PR link to the Log.
6. Set `status: reviewing` and commit.

**Never set `done`.** That is `approve`'s decision, and taking it here is how a lifecycle
becomes decoration. End by saying the feature is ready for `/factory review <id>`.

---

## review `<id>`

1. Open the spec. Status must be `reviewing`, else say what it is and stop.
2. Work out the round number: the next free `n` in `<project>/reviews/<NNN>-round-<n>.md`.
3. Spawn **all three reviewers in a single message** so they run in parallel — `review-code`,
   `review-security`, `review-ux`. Give each: the path to the spec, the feature branch, and the
   round number. Tell each to judge against the spec's acceptance criteria.
4. Write their findings to `<project>/reviews/<NNN>-round-<n>.md`: one section per reviewer,
   each finding keeping its blocking/minor label, file and reasoning. Keep their words; do not
   summarise away the specifics.
5. Commit the findings file.
6. Reply with the counts only — blocking and minor per reviewer — and then run `approve` for
   this feature. Do not paste the findings into the reply; they are on disk and in the dashboard.

---

## approve `<id>`

The gate. Read the spec and the newest round file, then do **exactly one** of three things.

**Pass** — every acceptance criterion met and no blocking finding.
Set `status: done`. Add a Log line naming the round file and why it passed. Commit.

**Rework** — blocking findings that are clear and local, and this is round 1 or 2.
Set `status: building`. Add a Log line listing the blocking findings as the work to do. Commit,
then run `build` for this feature with those findings as the task list.

**Escalate** — anything needing judgement, taste, or money; a blocking finding you don't know
how to resolve; or a third round. Leave the status at `reviewing`. Add a Log line saying what is
being asked and why. Commit.

Then put **one specific question** to the user. Not a list of findings — the single decision
that unblocks it, with the options and your recommendation. If you find yourself writing more
than about five lines, you are reporting rather than asking.

Never pass a feature with an unticked acceptance criterion. If a criterion turned out to be
wrong, that is an escalation, not a pass.

---

## rework `<id>` `<note>`

Send a feature back with an instruction, without a review round.

1. Open the spec. Add the note to `## Tasks` as unchecked items — split it if it contains more
   than one thing.
2. Set `status: building`, add a Log line quoting the note, commit.
3. Run `build` for this feature.

---

## status

The standing review pass. Read every `project.md` and feature file.

Report, briefly:
- per active project: features `reviewing`, then `building` with their last Log line, then what
  is next (`planned`, then `specced`, by priority), then counts of `idea` and `done`
- problems: `building` with no Log entry in 7 days, specs with open questions, `specced` for
  more than 14 days, projects with no `repo:`, features ticked complete but not `done`

Then propose a **diff**: the specific status changes you believe are true — "001: every
criterion ticked and no activity in 5 days → done", "004: says planned, is blocked". List them
numbered. Apply only the ones the user accepts, then commit.

End with the single most useful next action. Keep the whole thing scannable.
