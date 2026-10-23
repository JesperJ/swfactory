---
description: Draft a feature spec (why, what, acceptance criteria) for a project
argument-hint: <project-slug> <feature idea>
---

Draft a feature spec. Input: $ARGUMENTS

Propose, don't interview. Do not open with questions.

1. Find the specs folder and the project. Read `project.md` and the existing feature titles and
   statuses so you don't duplicate one.
2. Write the whole spec now, from the project context and the idea given. Fill Why, What,
   Acceptance criteria (observable and testable), and Out of scope. Make the obvious calls
   yourself. Where you had to assume something, put it under Open questions with the assumption
   you made, so it reads as a decision he can overturn rather than a question he must answer.
3. Number it: next free 3-digit id. Write `<project>/features/<NNN>-<kebab-slug>.md` with
   `status: specced`.
4. Reply with the acceptance criteria only, plus any assumption worth challenging, in a few
   lines. Not the whole spec — it's on disk.
5. Commit `factory: spec <project>/<NNN>-<slug>`.

Only stop and ask first if the idea is too vague to draft anything honest, or if it's really
two features and the split changes what you'd write.
