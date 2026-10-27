import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Store, isJobCommand, JOB_COMMANDS } from "./db.ts";
import { parseHook } from "./hooks.ts";
import { linkSession } from "./match.ts";
import { featureAction, featureFacts, featureOptions, lifecycleCounts, rankNext } from "./next.ts";
import { loadProjects, renderDoc, type Project } from "./specs.ts";
import { checkPassword, isLoggedIn, logIn, logOut, requireBearer, requireUi } from "./auth.ts";
import { gitSync, watchDir } from "./sync.ts";
import { buildId } from "./build-id.ts";
import { Notifier, fromEnv as notifierFromEnv } from "./notify.ts";

// Features as loaded from disk, plus whatever the runner has reported about their branches.
function withVcs(projects: Project[], store: Store): Project[] {
  return projects.map((p) => ({ ...p, features: p.features.map((f) => ({ ...f, vcs: store.getVcs(p.slug, f.slug) })) }));
}

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PUBLIC = join(ROOT, "public");
// The files whose staleness this is all about. index.html is served by its own route, which
// sets the same headers, so it is deliberately not in here.
const ASSET_RE = /\.(js|css|webmanifest)$/;

// A floor, not a default. `hours=0.0001` made every finished session a kill candidate at once,
// so the one parameter on the path that ends processes is clamped rather than merely validated.
// The runner's own threshold lives in the runner; this is the smallest window the dashboard will
// answer for at all.
const MIN_IDLE_HOURS = 1;
// A floor and a default are different numbers. Round 2 found the floor doing double duty, so a
// caller that omitted `hours` silently got a 1-hour window where it used to get 8.
const DEFAULT_IDLE_HOURS = 8;

export interface Config {
  specsDir: string;
  store: Store;
  password: string;
  hookToken: string;
  runnerToken: string;
  sync?: () => Promise<boolean>;
  // Absent means a notifier with no sender: every endpoint behaves exactly as it did before
  // notifications existed.
  notifier?: Notifier;
}

export function createApp(cfg: Config) {
  const app = new Hono();
  // Computed once: the files cannot change under a running container, so hashing per request
  // would be real work for an answer that never varies.
  const build = buildId(PUBLIC);
  // One etag for the whole build rather than per file: a change anywhere in public/ invalidates
  // every asset. Over-invalidating costs a refetch; under-invalidating is the bug this feature
  // exists to kill.
  const etag = `W/"${build}"`;

  // The page's own build id travels with the document that carried its code. Round 1 found
  // the structural hole in taking it from the first id the server reports instead: if a
  // rebuild lands between the browser fetching app.js and that page's first hello, the page
  // adopts the *new* id as its baseline and never reloads — running superseded code while
  // believing it is current, which is the one failure this feature exists to prevent.
  //
  // Read once: the files cannot change under a running container.
  const indexHtml = readFileSync(join(PUBLIC, "index.html"), "utf8").replace(
    "</head>",
    `  <meta name="build" content="${build}">\n</head>`,
  );
  const serveIndex = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    c.header("ETag", etag);
    return c.html(indexHtml);
  };

  const listeners = new Set<(event: string) => void>();
  // `notify` fans out to the browsers watching the SSE stream; `notifier` pushes to the phone.
  const notify = (event: string) => listeners.forEach((fn) => fn(event));
  const notifier = cfg.notifier ?? new Notifier();

  app.get("/healthz", (c) => c.text("ok"));

  // --- Hooks (bearer token) ---------------------------------------------------
  app.post("/api/hooks", requireBearer(cfg.hookToken), async (c) => {
    let payload: Record<string, unknown>;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const update = parseHook(payload, (name) => c.req.header(name));
    if (!update) return c.json({ error: "missing session_id or hook_event_name" }, 400);
    const { session, statusChanged } = cfg.store.upsert(update);
    notify("sessions");
    // Fire and forget, deliberately not awaited: the hook's response must not depend on a
    // third party being reachable. `link` is a thunk because resolving a session to a feature
    // reads every spec, and almost no hook will send anything.
    notifier.maybeSend({
      kind: "session",
      // Built field by field, not handed the row: the notifier's parameter type is a `Pick`,
      // which is a compile-time shape only, so passing `session` whole would leave `prompt`,
      // `message` and `cwd`'s full path sitting on the object one careless edit from the body.
      session: {
        id: session.id,
        status: session.status,
        host: session.host,
        repo: session.repo,
        cwd: session.cwd,
        dismissed: session.dismissed,
      },
      statusChanged,
      link: () => linkSession(session, loadProjects(cfg.specsDir)),
    });
    return c.json({ ok: true });
  });

  // --- Login ------------------------------------------------------------------
  app.get("/login", (c) => {
    if (isLoggedIn(c, cfg.password)) return c.redirect("/");
    return c.html(readFileSync(join(PUBLIC, "login.html"), "utf8"));
  });
  // Only ever a fragment of our own routing shape, so the redirect target is always this origin
  // at "/" — `next` cannot name a host, a scheme, or a path. Anything else is dropped silently
  // rather than echoed back.
  const safeNext = (v: string | undefined): string => (v && /^#\/[\w\-./~%]*$/.test(v) ? v : "");

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    if (typeof form.password === "string" && checkPassword(form.password, cfg.password)) {
      logIn(c, cfg.password);
      return c.redirect(`/${safeNext(c.req.query("next"))}`);
    }
    // Keep it across a wrong password too, or the second attempt is the one that loses it.
    const next = safeNext(c.req.query("next"));
    return c.redirect(`/login?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  });
  app.post("/logout", (c) => {
    logOut(c);
    return c.redirect("/login");
  });

  // --- Dashboard (logged in) --------------------------------------------------
  const ui = requireUi(cfg.password);
  app.get("/", ui, serveIndex);
  app.get("/index.html", ui, serveIndex);
  // Everything under /api needs the UI cookie except the two machine entrypoints, which carry
  // their own bearer tokens: the hooks, and the runner's claim/report pair under /api/jobs/.
  // POST /api/jobs itself is the UI queueing work, so it stays behind the cookie.
  const machineRoute = (path: string) =>
    path === "/api/hooks" ||
    path.startsWith("/api/jobs/") ||
    path === "/api/sessions/idle" ||
    path.startsWith("/api/vcs/");
  app.use("/api/*", async (c, next) => (machineRoute(c.req.path) ? next() : ui(c, next)));

  app.get("/api/state", (c) => {
    const projects = withVcs(loadProjects(cfg.specsDir), cfg.store);
    const sessions = cfg.store.list().map((s) => ({ ...s, ...linkSession(s, projects) }));
    // Each feature carries what it needs next, so every view can offer the same button without
    // re-deriving the rules. One mapping, server-side; the UI is told, not left to work it out.
    const annotated = projects.map((p) => ({
      ...p,
      // `options` is what the view renders; `next` stays as the recommended one so nothing that
      // reads it has to change at once. 005: the rules live here, never in a second copy.
      features: p.features.map((f) => {
        const withVcs = { ...f, vcs: cfg.store.getVcs(p.slug, f.slug) };
        const next = featureAction(withVcs);
        return { ...withVcs, next, options: featureOptions(withVcs), facts: featureFacts(withVcs, next?.reason ?? null) };
      }),
    }));
    return c.json({
      projects: annotated,
      sessions,
      jobs: cfg.store.listJobs(),
      next: rankNext(projects, sessions),
      lifecycle: lifecycleCounts(projects),
      build,
      now: new Date().toISOString(),
    });
  });

  app.get("/api/docs/:project/:feature?", (c) => {
    const doc = renderDoc(cfg.specsDir, c.req.param("project"), c.req.param("feature"));
    return doc ? c.json(doc) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/sessions/:id/dismiss", (c) => {
    const ok = cfg.store.dismiss(c.req.param("id"));
    if (ok) notify("sessions");
    return c.json({ ok });
  });

  // --- Jobs -------------------------------------------------------------------
  // Queued by the UI, claimed by the host-side runner. The dashboard never executes anything;
  // a job carries a project, a feature and one of three commands, never a shell string.
  app.post("/api/jobs", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const project = typeof body.project === "string" ? body.project : "";
    const feature = typeof body.feature === "string" && body.feature ? body.feature : null;
    if (!project) return c.json({ error: "project is required" }, 400);
    if (!isJobCommand(body.command))
      return c.json({ error: `command must be one of ${JOB_COMMANDS.join(", ")}` }, 400);
    // Refuse work for something that isn't in the specs, so a job can only ever name real work.
    const projects = loadProjects(cfg.specsDir);
    const p = projects.find((x) => x.slug === project);
    if (!p) return c.json({ error: `unknown project ${project}` }, 404);
    if (feature && !p.features.some((f) => f.slug === feature))
      return c.json({ error: `unknown feature ${feature}` }, 404);

    const { job, created } = cfg.store.enqueue({ project, feature, command: body.command });
    notify("jobs");
    return c.json({ job, created }, created ? 201 : 200);
  });

  app.get("/api/jobs/running", requireBearer(cfg.runnerToken), (c) => c.json({ jobs: cfg.store.listRunning() }));

  // The runner asks which sessions are idle rather than deciding for itself: the dashboard owns
  // session state, and a second opinion about what counts as idle is how two components drift.
  // It re-checks the age anyway before acting — this answer authorises destroying a process.
  app.get("/api/sessions/idle", requireBearer(cfg.runnerToken), (c) => {
    const raw = c.req.query("hours");
    const hours = raw === undefined ? DEFAULT_IDLE_HOURS : Number(raw);
    if (!Number.isFinite(hours) || hours < MIN_IDLE_HOURS)
      return c.json({ error: `hours must be a number >= ${MIN_IDLE_HOURS}` }, 400);
    return c.json({ sessions: cfg.store.idleSessions(hours) });
  });

  // The runner tells the dashboard what only a repository can know. Behind the runner token
  // because it writes state the UI renders; the shape is fixed and nothing here is executed.
  app.post("/api/vcs/:project", requireBearer(cfg.runnerToken), async (c) => {
    const project = c.req.param("project");
    if (!/^[\w.-]+$/.test(project)) return c.json({ error: "bad project" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.features)) return c.json({ error: "features must be an array" }, 400);
    const rows = body.features
      .filter((f: unknown): f is Record<string, unknown> => !!f && typeof f === "object")
      .filter((f: Record<string, unknown>) => typeof f.feature === "string" && /^[\w.-]+$/.test(f.feature))
      .map((f: Record<string, unknown>) => ({
        feature: String(f.feature),
        branch: typeof f.branch === "string" ? f.branch : null,
        exists: f.exists === true,
        merged: f.merged === true,
      }));
    cfg.store.setVcs(project, rows);
    notify("specs");
    return c.json({ ok: true, features: rows.length });
  });

  app.get("/api/jobs/next", requireBearer(cfg.runnerToken), (c) => {
    const job = cfg.store.claimNext();
    return c.json({ job: job ?? null });
  });

  app.post("/api/jobs/:id/status", requireBearer(cfg.runnerToken), async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const id = Number(c.req.param("id"));
    // Bound rather than discarded: the 404 check already has to read the row, and its status is
    // the previous status the notifier needs to tell a new failure from a re-reported one.
    const before = Number.isInteger(id) ? cfg.store.job(id) : undefined;
    if (!before) return c.json({ error: "no such job" }, 404);
    const status = body.status;
    if (status !== "running" && status !== "done" && status !== "failed")
      return c.json({ error: "status must be running, done or failed" }, 400);
    const job = cfg.store.setJobStatus(id, status, {
      error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
    });
    notify("jobs");
    // Field by field for the same reason the session call site is: `JobEvent.job` is a `Pick`,
    // which is a compile-time shape only, and the row carries `error` — runner output that can
    // hold an absolute path, which is the one thing the notification must never contain.
    if (job)
      notifier.maybeSend({
        kind: "job",
        job: { project: job.project, feature: job.feature, command: job.command, status: job.status },
        previousStatus: before.status,
      });
    return c.json({ job });
  });

  app.post("/api/specs/sync", async (c) => {
    if (!cfg.sync) return c.json({ ok: true, changed: false, note: "git sync not configured" });
    try {
      const changed = await cfg.sync();
      if (changed) notify("specs");
      return c.json({ ok: true, changed });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string) => void stream.writeSSE({ event: "change", data: event });
      listeners.add(send);
      stream.onAbort(() => void listeners.delete(send));
      await stream.writeSSE({ event: "hello", data: build });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

  // Always revalidate, and answer the revalidation. Served with only last-modified, a browser
  // caches on a heuristic and can keep stale JavaScript indefinitely — which is how a fixed
  // bug keeps being reported.
  app.use("/*", async (c, next) => {
    const asset = ASSET_RE.test(c.req.path);
    // Answered here rather than by serveStatic, which does no conditional handling: round 1
    // measured a request carrying the exact etag just issued coming back 200 with the whole
    // 34KB body, so "always ask, but a 304 is fine" was never true of this code.
    if (asset && c.req.header("If-None-Match") === etag) {
      c.header("Cache-Control", "no-cache");
      c.header("ETag", etag);
      return c.body(null, 304);
    }
    await next();
    // Only where the response actually carries the asset. A 404 with a validator advertises a
    // body it does not have — inert today, a cache-poisoning shape the moment anything starts
    // honouring these headers.
    if (asset && c.res.ok) {
      c.header("Cache-Control", "no-cache");
      c.header("ETag", etag);
    }
  });
  app.use("/*", serveStatic({ root: PUBLIC }));

  return { app, notify };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. See README.md → "Run it".`);
    process.exit(1);
  }
  return v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.env.DATA_DIR ?? join(ROOT, "data"));
  const gitUrl = process.env.SPECS_GIT_URL;
  const checkoutDir = join(dataDir, "specs-repo");
  const specsDir = gitUrl
    ? join(checkoutDir, process.env.SPECS_SUBDIR ?? "projects")
    : resolve(process.env.SPECS_DIR ?? join(ROOT, "projects"));
  const sync = gitUrl
    ? () => gitSync({ url: gitUrl, checkoutDir, branch: process.env.SPECS_GIT_BRANCH })
    : undefined;

  const { app, notify } = createApp({
    specsDir,
    store: new Store(join(dataDir, "factory.db")),
    password: required("FACTORY_PASSWORD"),
    hookToken: required("FACTORY_HOOK_TOKEN"),
    runnerToken: required("FACTORY_RUNNER_TOKEN"),
    sync,
    notifier: notifierFromEnv(),
  });

  if (sync) {
    const tick = () =>
      sync()
        .then((changed) => changed && notify("specs"))
        .catch((err) => console.error("[specs] git sync failed:", err.message));
    await tick();
    setInterval(tick, Number(process.env.SPECS_SYNC_SECONDS ?? 60) * 1000);
  } else {
    watchDir(specsDir, () => notify("specs"));
  }

  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, () => console.log(`Factory on http://localhost:${port} (specs: ${specsDir})`));
}
