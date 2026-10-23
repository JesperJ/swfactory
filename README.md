# swfactory

A structured, spec-driven way to build software with Claude, plus one live overview of every
project, feature and Claude session, on your phone and on your desktop.

- **Specs** are markdown in git (`projects/`), so you can read and edit them in Obsidian.
- **Slash commands** move each feature through `idea → specced → planned → building → done`.
- **The dashboard** shows what needs you right now, every project's progress, and links straight
  into the Claude sessions working on it. Sessions report in automatically through Claude Code hooks.

## How it fits together

```
 projects/*.md  ──(git pull every 60s)──▶  Factory dashboard  ◀──(hook events)──  every Claude session
 (specs, in git)                           (web app, SQLite)                       (local, web, mobile)
                                                  │
                                           phone / desktop
```

## Use it

| You want to | Do |
| --- | --- |
| Start a project | `/new-project <idea>` in Claude, in this repo |
| Spec a feature | `/new-feature <project> <idea>` |
| Plan it against the code | `/plan <project>/<NNN>` |
| Build it | `/build <project>/<NNN>` (works on branch `feature/<NNN>-<slug>`) |
| See where everything stands | Open the dashboard, or `/status` |

The dashboard has three views:
- **Inbox:** sessions that need you (blocked on a permission or question), sessions where it's
  your turn, and sessions still working, each with an **Open session** button.
- **Projects:** each project's features by status, with a progress bar. Tap a feature to read its
  spec and see the sessions working on it.
- **Sessions:** everything recent, including ended sessions.

On a phone, use "Add to Home Screen" to get it as a full-screen app.

## Run it

Locally:

```sh
npm install
FACTORY_PASSWORD=dev FACTORY_HOOK_TOKEN=dev npm run dev   # http://localhost:3000
```

Deployed (reachable from your phone), on Fly.io:

```sh
fly launch --copy-config --no-deploy        # choose an app name; edit `app` in fly.toml
fly volumes create factory_data --size 1
fly secrets set \
  FACTORY_PASSWORD='<a long password>' \
  FACTORY_HOOK_TOKEN="$(openssl rand -hex 24)" \
  SPECS_GIT_URL='https://<read-only token>@github.com/<you>/swfactory.git'
fly deploy
```

`SPECS_GIT_URL` makes the server pull specs from GitHub every 60 seconds (or when you tap the
refresh button). Use a fine-grained GitHub token with read-only access to this one repo. Any host
that runs a Dockerfile with a persistent disk works the same way; see `.env.example`.

## Connect your Claude sessions

Sessions report their status with the hook in `hooks/factory-report.sh`. It sends the session
id, status, your last prompt, Claude's last message or question, the git branch and remote
(credentials stripped), and a link to the session. It runs in the background and never slows down
or breaks a session, even when the dashboard is down.

**Every session on your computer:**

```sh
npm run install-hooks -- --user --url https://<your-app>.fly.dev --token <FACTORY_HOOK_TOKEN>
```

**Claude Code on the web and mobile** doesn't read your computer's `~/.claude`, so install the
hook into each project repo and commit it:

```sh
npm run install-hooks -- ../my-project
```

Then add `FACTORY_URL` and `FACTORY_HOOK_TOKEN` as environment variables in the cloud environment's
settings on claude.ai. Cloud sessions get a working **Open session** link automatically.

**How sessions are matched:** a session belongs to the project whose `repo:` (in project.md)
matches its git remote, or whose folder name matches the project slug. It belongs to a feature when
its branch contains the feature number or slug (`feature/003-login`), or when `FACTORY_FEATURE=003`
is set.

**Known gap:** for local sessions controlled through Remote Control, the hook doesn't know the
session's URL yet, so there's no Open button. Set `FACTORY_SESSION_URL` yourself if you want one.

## Develop

```sh
npm test
npm run typecheck
```

Node ≥ 22.18 runs the TypeScript directly; there is no build step. The frontend is plain ES
modules and CSS in `public/`. See `CLAUDE.md` for conventions.
