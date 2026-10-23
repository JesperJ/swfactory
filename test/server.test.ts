import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { Store } from "../src/db.ts";
import { Notifier, type Notification, type Sender } from "../src/notify.ts";
import { mergeHooks, EVENTS } from "../scripts/install-hooks.ts";

const SPECS = join(import.meta.dirname, "..", "projects");

function setup() {
  const { app } = createApp({ specsDir: SPECS, store: new Store(":memory:"), password: "pw", hookToken: "tok", runnerToken: "run" });
  return app;
}

async function login(app: ReturnType<typeof setup>) {
  const res = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ password: "pw" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.status, 302);
  return res.headers.get("set-cookie")!.split(";")[0];
}

function hook(app: ReturnType<typeof setup>, body: object, headers: Record<string, string> = {}) {
  return app.request("/api/hooks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { authorization: "Bearer tok", "content-type": "application/json", ...headers },
  });
}

test("API requires login; wrong password is rejected", async () => {
  const app = setup();
  assert.equal((await app.request("/api/state")).status, 401);
  assert.equal((await app.request("/")).status, 302);
  const bad = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ password: "nope" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(bad.headers.get("location"), "/login?error=1");
});

test("hooks need the hook token, not the UI cookie", async () => {
  const app = setup();
  const res = await app.request("/api/hooks", { method: "POST", body: "{}", headers: { authorization: "Bearer pw" } });
  assert.equal(res.status, 401);
});

test("a session's lifecycle shows up in state, linked to project and feature", async () => {
  const app = setup();
  const cookie = await login(app);
  const headers = {
    "x-factory-repo": "https://github.com/JesperJ/swfactory",
    "x-factory-branch": "feature/002-session-hooks",
    "x-factory-session-url": "https://claude.ai/code/session_abc",
  };
  const base = { session_id: "s1", cwd: "/work/swfactory" };
  assert.equal((await hook(app, { ...base, hook_event_name: "SessionStart" }, headers)).status, 200);
  await hook(app, { ...base, hook_event_name: "UserPromptSubmit", prompt: "Build the thing" });
  let s = (await (await app.request("/api/state", { headers: { cookie } })).json()).sessions[0];
  assert.equal(s.status, "working");
  assert.equal(s.prompt, "Build the thing");
  assert.equal(s.project, "swfactory");
  assert.equal(s.feature, "002-session-hooks");
  assert.equal(s.url, "https://claude.ai/code/session_abc");

  await hook(app, { ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" });
  s = (await (await app.request("/api/state", { headers: { cookie } })).json()).sessions[0];
  assert.equal(s.status, "needs_you");
  assert.match(s.message, /permission/);

  await hook(app, { ...base, hook_event_name: "Stop", last_assistant_message: "Done, tests pass." });
  s = (await (await app.request("/api/state", { headers: { cookie } })).json()).sessions[0];
  assert.equal(s.status, "your_turn");
  assert.equal(s.message, "Done, tests pass.");

  await app.request("/api/sessions/s1/dismiss", { method: "POST", headers: { cookie } });
  const state = await (await app.request("/api/state", { headers: { cookie } })).json();
  assert.equal(state.sessions.length, 0);
});

test("feature docs are served to logged-in users", async () => {
  const app = setup();
  const cookie = await login(app);
  const res = await app.request("/api/docs/swfactory/001-dashboard", { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match((await res.json()).html, /Acceptance criteria/);
});

test("install-hooks merges idempotently and keeps unrelated hooks", () => {
  const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "x" };
  const once = mergeHooks(existing, '"$HOME/.claude/hooks/factory-report.sh"');
  const twice = mergeHooks(once, '"$HOME/.claude/hooks/factory-report.sh"');
  assert.deepEqual(once, twice);
  assert.equal(twice.hooks!.Stop.length, 2);
  for (const e of EVENTS) assert.ok(twice.hooks![e].some((h) => h.hooks[0].command.includes("factory-report.sh")));
  assert.equal(twice.model, "x");
});

test("a repeated idle nudge neither revives a dismissed session nor resets its clock", async () => {
  const store = new Store(":memory:");
  const { app } = createApp({ specsDir: SPECS, store, password: "pw", hookToken: "tok", runnerToken: "run" });
  const cookie = await login(app);
  const idle = {
    session_id: "s9",
    hook_event_name: "Notification",
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  };

  await hook(app, idle);
  const first = store.get("s9")!;
  assert.equal(first.status, "your_turn");

  // You deal with it and dismiss the card.
  await app.request("/api/sessions/s9/dismiss", { method: "POST", headers: { cookie } });
  assert.equal(store.get("s9")!.dismissed, 1);

  // Claude nudges again a minute later. The card must stay gone and the clock must not move.
  await hook(app, idle);
  const after = store.get("s9")!;
  assert.equal(after.dismissed, 1, "an idle nudge must not revive a dismissed session");
  assert.equal(after.status_since, first.status_since, "an idle nudge must not reset the clock");
  assert.equal((await (await app.request("/api/state", { headers: { cookie } })).json()).sessions.length, 0);

  // Real new activity does bring it back.
  await hook(app, { session_id: "s9", hook_event_name: "UserPromptSubmit", prompt: "carry on" });
  assert.equal(store.get("s9")!.dismissed, 0);
  assert.notEqual(store.get("s9")!.status_since, first.status_since);
});

function runner(app: ReturnType<typeof setup>, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: "Bearer run", "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

test("queueing a job needs the UI cookie, and the command must be one of the allowed three", async () => {
  const app = setup();
  const cookie = await login(app);
  const post = (body: object, headers: Record<string, string> = { cookie }) =>
    app.request("/api/jobs", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  assert.equal((await post({ project: "swfactory", command: "build" }, {})).status, 401, "no cookie, no job");

  const ok = await post({ project: "swfactory", feature: "005-start-session", command: "build" });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).job.command, "build");

  for (const command of ["approve", "rm -rf /", "", "BUILD", 7, null]) {
    const res = await post({ project: "swfactory", feature: "008-what-next", command });
    assert.equal(res.status, 400, `command ${String(command)} must be refused`);
  }
  // A job can only ever name work that exists.
  assert.equal((await post({ project: "nope", command: "build" })).status, 404);
  assert.equal((await post({ project: "swfactory", feature: "999-ghost", command: "build" })).status, 404);
});

test("the hook token cannot claim jobs, and the runner token cannot queue them", async () => {
  const app = setup();
  const asHook = await app.request("/api/jobs/next", { headers: { authorization: "Bearer tok" } });
  assert.equal(asHook.status, 401, "a leaked hook token must not reach the runner endpoints");

  const asRunner = await runner(app, "/api/jobs", {
    method: "POST",
    body: JSON.stringify({ project: "swfactory", command: "build" }),
  });
  assert.equal(asRunner.status, 401, "the runner token is not a login");
});

test("a job is claimed once, then reports its outcome", async () => {
  const app = setup();
  const cookie = await login(app);
  await app.request("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ project: "swfactory", feature: "005-start-session", command: "build" }),
    headers: { cookie, "content-type": "application/json" },
  });

  const claimed = (await (await runner(app, "/api/jobs/next")).json()).job;
  assert.equal(claimed.status, "claimed");
  assert.equal((await (await runner(app, "/api/jobs/next")).json()).job, null, "claimed only once");

  const bad = await runner(app, `/api/jobs/${claimed.id}/status`, { method: "POST", body: JSON.stringify({ status: "exploded" }) });
  assert.equal(bad.status, 400);
  assert.equal((await runner(app, "/api/jobs/9999/status", { method: "POST", body: JSON.stringify({ status: "done" }) })).status, 404);

  const failed = await runner(app, `/api/jobs/${claimed.id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "failed", error: "no checkout matching github.com/jesperj/swfactory" }),
  });
  assert.equal((await failed.json()).job.status, "failed");

  const state = await (await app.request("/api/state", { headers: { cookie } })).json();
  assert.equal(state.jobs.length, 1, "a failed job stays visible on the dashboard");
  assert.match(state.jobs[0].error, /no checkout matching/);
});

// --- notifications ----------------------------------------------------------
// The rules themselves live in notify.test.ts. These cover the wiring: that the endpoints feed
// the notifier the right event, and that a broken notifier cannot affect a response.

function withNotifier() {
  const sent: Notification[] = [];
  const sender: Sender = { async send(n) { sent.push(n); } };
  const { app } = createApp({
    specsDir: SPECS,
    store: new Store(":memory:"),
    password: "pw",
    hookToken: "tok",
    runnerToken: "run",
    notifier: new Notifier({ sender, baseUrl: "http://factory.local:3000" }),
  });
  return { app, sent };
}

test("a session blocking on a permission prompt notifies once, naming the feature", async () => {
  const { app, sent } = withNotifier();
  const headers = {
    "x-factory-repo": "https://github.com/JesperJ/swfactory",
    "x-factory-branch": "feature/002-session-hooks",
    "x-factory-host": "thinkpad",
  };
  const base = { session_id: "s1", cwd: "/work/swfactory" };
  await hook(app, { ...base, hook_event_name: "UserPromptSubmit", prompt: "do the thing" }, headers);
  assert.equal(sent.length, 0, "working must not notify");

  await hook(app, { ...base, hook_event_name: "Notification", message: "Claude needs your permission to run rm" }, headers);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /swfactory/);
  assert.match(sent[0].title, /002-session-hooks/);
  assert.match(sent[0].body, /thinkpad/);
  assert.equal(sent[0].click, "http://factory.local:3000/#/inbox");

  // The one thing an ntfy topic holder must never see.
  const text = `${sent[0].title} ${sent[0].body}`;
  assert.ok(!text.includes("rm"), `the prompt text must not reach the notification: ${text}`);
  assert.ok(!text.includes("do the thing"));
  assert.ok(!text.includes("/work/swfactory"));

  // Claude Code repeats the idle nudge while a session waits; it restates needs_you.
  await hook(app, { ...base, hook_event_name: "Notification", message: "Claude needs your permission to run rm" }, headers);
  assert.equal(sent.length, 1, "a repeated event that changes nothing is not a second event");
});

test("Stop and SessionEnd notify nothing", async () => {
  const { app, sent } = withNotifier();
  const base = { session_id: "s2", cwd: "/work/swfactory" };
  await hook(app, { ...base, hook_event_name: "Stop", last_assistant_message: "done" });
  await hook(app, { ...base, hook_event_name: "SessionEnd" });
  assert.equal(sent.length, 0);
});

test("a job reported failed notifies, naming the project, feature and command", async () => {
  const store = new Store(":memory:");
  const sent: Notification[] = [];
  const { app } = createApp({
    specsDir: SPECS,
    store,
    password: "pw",
    hookToken: "tok",
    runnerToken: "run",
    notifier: new Notifier({ sender: { async send(n) { sent.push(n); } } }),
  });
  const { job } = store.enqueue({ project: "swfactory", feature: "006-push-notifications", command: "build" });

  const report = (status: string) =>
    app.request(`/api/jobs/${job.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
      headers: { authorization: "Bearer run", "content-type": "application/json" },
    });

  assert.equal((await report("running")).status, 200);
  assert.equal(sent.length, 0, "running is not a failure");
  assert.equal((await report("failed")).status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /swfactory/);
  assert.match(sent[0].title, /006-push-notifications/);
  assert.match(sent[0].body, /build/);
  assert.equal((await report("failed")).status, 200);
  assert.equal(sent.length, 1, "re-reporting a status it already had is not a new failure");
});

test("a notifier that hangs or throws changes neither response nor timing", async () => {
  const store = new Store(":memory:");
  const hangs: Sender = { send: () => new Promise(() => {}) };
  const { app } = createApp({
    specsDir: SPECS,
    store,
    password: "pw",
    hookToken: "tok",
    runnerToken: "run",
    notifier: new Notifier({ sender: hangs, log: () => {} }),
  });
  const { job } = store.enqueue({ project: "swfactory", feature: "006-push-notifications", command: "build" });

  const started = Date.now();
  const h = await hook(app, { session_id: "s9", hook_event_name: "Notification", message: "blocked" });
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  const j = await app.request(`/api/jobs/${job.id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "failed" }),
    headers: { authorization: "Bearer run", "content-type": "application/json" },
  });
  assert.equal(j.status, 200);
  assert.equal((await j.json() as { job: { status: string } }).job.status, "failed");
  assert.ok(Date.now() - started < 1_000, "a hanging notifier must not be in the request path");
});

test("a notifier whose sender throws still leaves the endpoints at 200", async () => {
  const logged: string[] = [];
  const { app } = createApp({
    specsDir: SPECS,
    store: new Store(":memory:"),
    password: "pw",
    hookToken: "tok",
    runnerToken: "run",
    notifier: new Notifier({
      sender: { send() { throw new Error("unreachable"); } },
      log: (m) => logged.push(m),
    }),
  });
  const res = await hook(app, { session_id: "s8", hook_event_name: "Notification", message: "blocked" });
  assert.equal(res.status, 200);
  assert.match(logged.join(" "), /unreachable/, "the failure is logged, not raised");
});
