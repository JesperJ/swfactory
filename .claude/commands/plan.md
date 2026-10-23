---
description: Turn a feature spec into a technical plan and task list
argument-hint: <project-slug>/<NNN>
---

Plan a feature. Input: $ARGUMENTS

Decide, don't ask. Pick the approach yourself; name the trade-off in one line.

1. Open the spec. If its status isn't `specced` or `planned`, say why and stop.
2. Read the project's code repo properly: structure, conventions, tests. If it isn't available
   in this session, say so and stop rather than planning blind.
3. Fill `## Plan`: approach, files and modules touched, data or API changes, which test proves
   each acceptance criterion, and risks. Where two approaches were close, state which you chose
   and why in one sentence — don't present a menu.
4. Fill `## Tasks`: small steps, each independently verifiable, ordered so tests pass after
   every one. Prefer 3 to 10.
5. Record anything significant and hard to reverse as
   `<project>/decisions/<YYYY-MM-DD>-<slug>.md`.
6. Set `status: planned`, add a Log line, commit `factory: plan <project>/<NNN>`.
7. Reply with the approach in two or three lines and the task count. Point at the spec for the
   rest.

Escalate only a choice that is expensive, irreversible, commercial, or a matter of taste.
