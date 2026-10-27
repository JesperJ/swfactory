# Software factory

This repo is two things:

1. **The specs** for every project: `projects/<slug>/project.md` and
   `projects/<slug>/features/<NNN>-<slug>.md`. Templates are in `templates/`.
2. **The dashboard** (`src/`, `public/`): a small web app that shows projects, features and live
   Claude Code sessions. Sessions report in through the hook in `hooks/factory-report.sh`.

## The workflow

Features move `idea → specced → planned → building → reviewing → done`, recorded in the
frontmatter `status:`. One command runs the line:

| Command | Does | Leaves the feature |
| --- | --- | --- |
| `/factory next` | does the top thing the dashboard recommends | |
| `/factory project` | interviews, writes project.md | |
| `/factory spec` | drafts why/what/acceptance criteria | `specced` |
| `/factory plan` | writes plan + tasks from the code | `planned` |
| `/factory build` | implements task by task on `feature/<NNN>-<slug>` | `reviewing` |
| `/factory review` | three reviewers in parallel, findings to `reviews/` | `reviewing` |
| `/factory approve` | passes, reworks, or escalates one question | `done`, `building`, or `reviewing` + `question:` |
| `/factory rework` | sends back with a note | `building` |
| `/factory status` | overview, and proposes a diff for stale specs | |

Rules:
- No code without a spec. No build without a plan. Only `approve` may set `done`.
- If the plan turns out wrong, update the spec first, then the code.
- Keep the spec's Tasks and Log current; they are what the dashboard and `/factory status` show.
- Frontmatter is machine-read: keep `status`, `title`, `priority`, `summary`, `repo` valid YAML.
- An escalation leaves the feature at `reviewing` and writes its one question to `question:`.
  Pass and rework clear it. The dashboard reads that field to tell "waiting on you" apart from
  "nobody has looked at this yet".

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

## How to work with Jesper

He operates at customer / project-lead level across several projects. Protect his attention.

**Decide, don't ask.** Make the call yourself and state it in one line. Escalate only when it is
expensive, hard to reverse, a matter of taste, or commercial. Anything else, choose the sensible
default and say which you chose. A question he could answer with "whatever you think" should
never have been asked.

**Propose, don't interview.** Draft the thing from what you already know — the repo, the other
specs, the conversation — then show it and ask for corrections. Never open with a list of
questions. One question is a nudge; four is an interrogation.

**Be short.** Lead with the answer or the recommendation. Detail goes in the spec file, not the
reply. If a reply is longer than a short screen, it belongs in a document. No restating what he
just said, no narrating what you are about to do.

**Always name the next action.** End anything status-shaped with the single most useful next
thing, not a menu.
