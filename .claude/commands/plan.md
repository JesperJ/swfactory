---
description: Turn an approved feature spec into a technical plan and task list
argument-hint: <project-slug>/<NNN>
---

Plan a feature. Input: $ARGUMENTS

1. Open the feature spec. If its status isn't `specced` (or `planned`, when re-planning), stop and
   say why. If Open questions remain that change the design, ask them first.
2. Read the project's code repo (the one in `repo:` of project.md) enough to plan for real:
   existing structure, conventions, tests. If the repo isn't available in this session, say so
   and stop rather than planning blind.
3. Fill the `## Plan` section: approach, modules/files touched, data or API changes, how each
   acceptance criterion will be verified (which test), and risks.
4. Fill `## Tasks` with small steps, each one independently verifiable, ordered so the project
   builds and tests pass after every step. Prefer 3 to 10 tasks.
5. Record any significant, hard-to-reverse choice as `<project>/decisions/<YYYY-MM-DD>-<slug>.md`
   from `templates/decision.md`.
6. Set `status: planned`, add a Log line, commit `factory: plan <project>/<NNN>`, and ask the
   user to review the plan before `/build`.
