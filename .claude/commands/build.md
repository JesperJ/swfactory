---
description: Implement a planned feature task by task, against its acceptance criteria
argument-hint: <project-slug>/<NNN>
---

Build a feature. Input: $ARGUMENTS

Rules: this is spec-driven, not vibe coding. Only build what the spec and plan say. If reality
disagrees with the plan, stop, update the plan in the spec, and tell the user, rather than improvising.

1. Open the feature spec. Its status must be `planned` or `building`; otherwise stop and point the
   user to `/new-feature` or `/plan`.
2. Work in the project's code repo on a branch named `feature/<NNN>-<slug>`, so the dashboard links
   this session to the feature. Set `status: building` and add a Log line.
3. For each unchecked task, in order:
   - implement it, with tests for the acceptance criteria it covers;
   - run the repo's tests, linter and type checker, and fix failures before moving on;
   - tick the task in the spec and commit (code repo) with a message naming the task.
4. When every task is done, check each acceptance criterion against the running code or tests and
   tick it only if verified. Anything unverified stays unticked with a note.
5. Push the branch and open a PR that links the spec. Add the PR link to the Log.
6. Set `status: done` only after the PR is merged. Until then leave it `building`. Commit the spec
   change in the factory repo.
