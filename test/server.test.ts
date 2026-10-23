import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { Store } from "../src/db.ts";
import { mergeHooks, EVENTS } from "../scripts/install-hooks.ts";

const SPECS = join(import.meta.dirname, "..", "projects");

function setup() {
  const { app } = createApp({ specsDir: SPECS, store: new Store(":memory:"), password: "pw", hookToken: "tok" });
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
  const { app } = createApp({ specsDir: SPECS, store, password: "pw", hookToken: "tok" });
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
