---
description: Write a feature spec (why, what, acceptance criteria) for a project
argument-hint: <project-slug> <feature idea>
---

Write a feature spec. Input: $ARGUMENTS

1. Find the specs folder and the project (ask if the project is ambiguous). Read its
   `project.md` and the titles and statuses of its existing features, so you don't duplicate one.
2. Ask the user only what you need to write testable acceptance criteria (at most 4 questions,
   one message). Push back if the feature is really two features.
3. Number it: next free 3-digit id in `<project>/features/`. Create
   `<project>/features/<NNN>-<kebab-slug>.md` from `templates/feature.md` with `status: specced`.
   Fill Why, What, Acceptance criteria (observable and testable), Out of scope and Open questions.
   Leave Plan, Tasks and Log empty.
4. Show the user the acceptance criteria and ask them to approve or change them. A spec isn't
   ready for `/plan` until they approve.
5. Commit with message `factory: spec <project>/<NNN>-<slug>`.
