# swfactory

A structured, spec-driven way to build software with Claude, plus one live overview of every
project, feature and Claude session, on your phone and on your desktop.

- **Specs** are markdown in git (`projects/`), so you can read and edit them in Obsidian.
- **One `/factory` command** moves each feature through `idea → specced → planned → building → reviewing → done`.
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
| Do the next useful thing | `/factory next` |
| Start a project | `/factory project <idea>` |
| Spec a feature | `/factory spec <project> <idea>` |
| Plan it against the code | `/factory plan <project>/<NNN>` |
| Build it | `/factory build <project>/<NNN>` (branch `feature/<NNN>-<slug>`) |
| Review what was built | `/factory review <project>/<NNN>` |
| Accept or send it back | `/factory approve` / `/factory rework <id> <note>` |
| See where everything stands | Open the dashboard, or `/factory status` |

The dashboard has four views:
- **Next:** one recommended action across every project, with a few ranked alternatives.
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

## Checking the UI

```sh
set -a && . ./.env && set +a
FACTORY_URL=http://localhost:8088 nix shell nixpkgs#chromium --command npm run shoot
```

Screenshots phone and desktop widths into `/tmp/factory-shots` and fails on console errors,
horizontal overflow, or a wrapped tab bar. Uses the system Chromium, so there is no browser
download; set `CHROMIUM_PATH` if it isn't on `PATH`.

## Starting work from the dashboard

The dashboard never executes anything. Tapping **Build** on a feature writes a job row; a small
runner on your machine polls for it and starts a real Claude session in that repo, inside tmux.
Every connection goes outward from the host — nothing listens, and the container holds no host
credentials.

```sh
# a third secret, separate from the hook token
openssl rand -hex 24   # -> FACTORY_RUNNER_TOKEN, add it to .env and restart the dashboard

cp contrib/factory-runner.service ~/.config/systemd/user/
printf 'FACTORY_RUNNER_TOKEN=%s\n' "$TOKEN" > ~/.config/factory-runner.env
chmod 600 ~/.config/factory-runner.env
systemctl --user daemon-reload && systemctl --user enable --now factory-runner
```

A job carries a project, a feature and one of three commands (`plan`, `build`, `spec`) — never a
shell string. The runner rebuilds the command itself and finds the checkout by matching its git
remote to the project's `repo:`, so a renamed or wrong directory fails with a visible reason
instead of running somewhere unintended.

Attach to a started session with `tmux attach -t factory-<project>-<feature>`.

## Notifications on your phone

The dashboard pushes to your phone the moment a session blocks on you, or a job you queued
fails. Nothing else notifies — `your_turn` fires on every turn of normal work and would train
you to ignore the channel.

Delivery is an outbound POST to [ntfy](https://ntfy.sh), so the dashboard needs no HTTPS origin,
no certificate and no service worker. Web Push would need all three; see
`projects/swfactory/decisions/2026-10-23-ntfy-over-web-push.md`.

On the dashboard host, if you run it from this checkout:

```sh
# The topic is the only thing protecting the channel, so make it unguessable.
printf 'NTFY_TOPIC=factory-%s\n' "$(openssl rand -hex 16)" >> .env
printf 'FACTORY_PUBLIC_URL=%s\n' 'http://factory.local:3000' >> .env   # as your phone reaches it
# restart the dashboard
```

Deployed on Fly.io, where appending to `.env` does nothing at all:

```sh
fly secrets set \
  NTFY_TOPIC="factory-$(openssl rand -hex 16)" \
  FACTORY_PUBLIC_URL='https://<your app>.fly.dev'
fly secrets list | grep NTFY_TOPIC   # confirm it took; the value is not shown
```

Set `NTFY_TOPIC` without `FACTORY_PUBLIC_URL` and the dashboard says so on startup — the
notifications would arrive with nothing to tap.

On the phone, once:

1. Install the ntfy app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy),
   [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
2. **+** → paste the topic exactly as it is in `.env` (just the topic, not a URL) → Subscribe.
3. Check it end to end: `/factory build` something from the dashboard and let it hit a
   permission prompt. The notification names the project, the feature and the host; tapping it
   opens the inbox. Fail a job and the notification opens that feature, where the Retry button
   is.

Both notifications are sent at high priority, so they wake the screen on either platform
without a per-subscription setting.

A notification never carries prompt text, Claude's message, or a filesystem path — only project,
feature, host and the link. An ntfy topic is a bearer secret in URL form: anyone who learns it
can subscribe, and hosted ntfy.sh can read what passes through, so the body says "go and look"
and nothing more. Treat the topic like the password; rotating it is one line in `.env` and a
re-subscribe on the phone.

Self-hosting is a swap of `NTFY_SERVER`. Leave `NTFY_TOPIC` unset and the dashboard notifies
nothing.
