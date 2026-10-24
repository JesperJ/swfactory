import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Store, isJobCommand, JOB_COMMANDS } from "./db.ts";
import { parseHook } from "./hooks.ts";
import { linkSession } from "./match.ts";
import { featureAction, lifecycleCounts, rankNext } from "./next.ts";
import { loadProjects, renderDoc } from "./specs.ts";
import { checkPassword, isLoggedIn, logIn, logOut, requireBearer, requireUi } from "./auth.ts";
import { gitSync, watchDir } from "./sync.ts";
import { Notifier, fromEnv as notifierFromEnv } from "./notify.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PUBLIC = join(ROOT, "public");

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
  app.get("/", ui, (c) => c.html(readFileSync(join(PUBLIC, "index.html"), "utf8")));
  // Everything under /api needs the UI cookie except the two machine entrypoints, which carry
  // their own bearer tokens: the hooks, and the runner's claim/report pair under /api/jobs/.
  // POST /api/jobs itself is the UI queueing work, so it stays behind the cookie.
  const machineRoute = (path: string) => path === "/api/hooks" || path.startsWith("/api/jobs/");
  app.use("/api/*", async (c, next) => (machineRoute(c.req.path) ? next() : ui(c, next)));

  app.get("/api/state", (c) => {
    const projects = loadProjects(cfg.specsDir);
    const sessions = cfg.store.list().map((s) => ({ ...s, ...linkSession(s, projects) }));
    // Each feature carries what it needs next, so every view can offer the same button without
    // re-deriving the rules. One mapping, server-side; the UI is told, not left to work it out.
    const annotated = projects.map((p) => ({
      ...p,
      features: p.features.map((f) => ({ ...f, next: featureAction(f) })),
    }));
    return c.json({
      projects: annotated,
      sessions,
      jobs: cfg.store.listJobs(),
      next: rankNext(projects, sessions),
      lifecycle: lifecycleCounts(projects),
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
      await stream.writeSSE({ event: "hello", data: "ok" });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

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
