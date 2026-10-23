---
description: Summarize every project - what's done, in flight, next, and blocked
---

Give the user an overview of the factory.

1. Find the specs folder and read the frontmatter of every `project.md` and feature file.
2. Reply with, per active project: features `building` (with Log's last line), next up (`planned`,
   then `specced`, by priority), and the count of `idea` and `done`.
3. Then list problems: features `building` with no Log entry in 7 days, specs with open questions,
   specs `specced` for more than 14 days, and projects with no `repo:`.
4. End with your recommendation for the single most useful next action.
Keep it short and scannable. Don't modify any files.
