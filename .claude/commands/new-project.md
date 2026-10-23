---
description: Start a new project in the factory (interview, then write project.md)
argument-hint: <project name or one-line idea>
---

Create a new project in the software factory. Idea from the user: $ARGUMENTS

1. Find the specs folder (see "Finding the specs" in the factory's CLAUDE.md).
2. Interview the user before writing anything. Ask at most 5 short questions, in one message,
   covering only what you can't infer: who it's for, the core problem, constraints (stack,
   hosting, deadlines), what's explicitly out of scope, and the code repo URL if one exists.
3. Pick a short kebab-case slug. Create `<specs>/<slug>/project.md` from `templates/project.md`.
   Fill every section; delete placeholder text you can't fill and list it under "Open questions".
4. Propose 3 to 7 first features as one-liners (don't create files yet) and ask which to spec.
5. Commit with message `factory: new project <slug>` and tell the user the next step is
   `/new-feature`.
