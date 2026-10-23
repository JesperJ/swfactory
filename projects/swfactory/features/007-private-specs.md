---
title: Keep the tool public, keep specs private
status: idea
priority: P2
summary: Split specs into a private repo so future projects' specs aren't published with the tool.
---

# Keep the tool public, keep specs private

## Why
This repo is public, and the factory keeps every project's specs inside it under `projects/`.
Specs are the most revealing thing here — vision, constraints, commercial reasoning — more so
than the code. That is fine for this project, which is the tool itself, and probably wrong for
anything client-related or commercial.

The cost of leaving it is paid later: moving specs after several projects exist means rewriting
paths, references and history, rather than changing one mount today.

## What
Keep `swfactory` public as a tool other people can use. Keep specs somewhere private — plausibly
the Obsidian vault, which is where this idea started.

No code change is needed. The server already takes `SPECS_DIR`, and `SPECS_GIT_URL` pulls specs
from any repo, so this is a bind-mount or environment change plus moving files.

## Acceptance criteria
- [ ] Specs for private projects live outside this public repo
- [ ] The dashboard reads them without code changes
- [ ] This project's own specs stay public, as a worked example of the workflow
- [ ] `README.md` says where specs are expected to live, so the split isn't folklore

## Open questions
- Does the Obsidian vault become the specs repo, or does a separate private repo?
- Does `swfactory`'s own project stay in this repo, or move with the rest and get replaced here
  by an example project?

## Out of scope
- Making the dashboard serve several spec sources at once.
