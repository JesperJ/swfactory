import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Store } from "./db.ts";
import { parseHook } from "./hooks.ts";
import { linkSession } from "./match.ts";
import { rankNext } from "./next.ts";
import { loadProjects, renderDoc } from "./specs.ts";
import { checkPassword, isLoggedIn, logIn, logOut, requireHookToken, requireUi } from "./auth.ts";
import { gitSync, watchDir } from "./sync.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PUBLIC = join(ROOT, "public");

export interface Config {
  specsDir: string;
  store: Store;
  password: string;
  hookToken: string;
  sync?: () => Promise<boolean>;
}

export function createApp(cfg: Config) {
  const app = new Hono();
  const listeners = new Set<(event: string) => void>();
  const notify = (event: string) => listeners.forEach((fn) => fn(event));

  app.get("/healthz", (c) => c.text("ok"));

  // --- Hooks (bearer token) ---------------------------------------------------
  app.post("/api/hooks", requireHookToken(cfg.hookToken), async (c) => {
    let payload: Record<string, unknown>;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const update = parseHook(payload, (name) => c.req.header(name));
    if (!update) return c.json({ error: "missing session_id or hook_event_name" }, 400);
    cfg.store.upsert(update);
    notify("sessions");
    return c.json({ ok: true });
  });

  // --- Login ------------------------------------------------------------------
  app.get("/login", (c) => {
    if (isLoggedIn(c, cfg.password)) return c.redirect("/");
    return c.html(readFileSync(join(PUBLIC, "login.html"), "utf8"));
  });
  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    if (typeof form.password === "string" && checkPassword(form.password, cfg.password)) {
      logIn(c, cfg.password);
      return c.redirect("/");
    }
    return c.redirect("/login?error=1");
  });
  app.post("/logout", (c) => {
    logOut(c);
    return c.redirect("/login");
  });

  // --- Dashboard (logged in) --------------------------------------------------
  const ui = requireUi(cfg.password);
  app.get("/", ui, (c) => c.html(readFileSync(join(PUBLIC, "index.html"), "utf8")));
  app.use("/api/*", async (c, next) => (c.req.path === "/api/hooks" ? next() : ui(c, next)));

  app.get("/api/state", (c) => {
    const projects = loadProjects(cfg.specsDir);
    const sessions = cfg.store.list().map((s) => ({ ...s, ...linkSession(s, projects) }));
    return c.json({ projects, sessions, next: rankNext(projects, sessions), now: new Date().toISOString() });
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
    sync,
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
