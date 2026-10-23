# Software factory

This repo is two things:

1. **The specs** for every project: `projects/<slug>/project.md` and
   `projects/<slug>/features/<NNN>-<slug>.md`. Templates are in `templates/`.
2. **The dashboard** (`src/`, `public/`): a small web app that shows projects, features and live
   Claude Code sessions. Sessions report in through the hook in `hooks/factory-report.sh`.

## The workflow

Features move `idea → specced → planned → building → done`, recorded in the frontmatter `status:`.
Use the slash commands; each one moves a feature one step and stops for the user to approve:

| Command | Does | Leaves the feature |
| --- | --- | --- |
| `/new-project` | interviews, writes project.md | |
| `/new-feature` | writes why/what/acceptance criteria | `specced` |
| `/plan` | writes plan + tasks from the code | `planned` |
| `/build` | implements task by task on `feature/<NNN>-<slug>` | `building`, then `done` |
| `/status` | overview of everything | |

Rules:
- No code without a spec the user approved. No `/build` without a plan.
- If the plan turns out wrong, update the spec first, then the code.
- Keep the spec's Tasks and Log current; they are what the dashboard and `/status` show.
- Frontmatter is machine-read: keep `status`, `title`, `priority`, `summary`, `repo` valid YAML.

## Finding the specs

The specs folder is `projects/` in this repo. When working from a project's own code repo, find
it at `$FACTORY_HOME/projects`, else a sibling checkout `../swfactory/projects`; if neither exists,
ask the user where the factory repo is.

## Working on the dashboard itself

- Node >= 22.18, TypeScript run directly (type stripping), no build step. Frontend is plain
  ES modules and CSS in `public/`.
- `npm test`, `npm run typecheck` before every commit.
- Run locally: `FACTORY_PASSWORD=dev FACTORY_HOOK_TOKEN=dev npm run dev`.
- The UI must work equally well on a phone and a desktop: check both widths (375px and 1280px),
  light and dark mode.
