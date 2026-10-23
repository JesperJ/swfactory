import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationFor, type SessionEvent, type JobEvent } from "../src/notify.ts";
import type { SessionStatus } from "../src/db.ts";

const BASE = "http://factory.local:3000";

function session(over: Partial<SessionEvent["session"]> = {}, rest: Partial<SessionEvent> = {}): SessionEvent {
  return {
    kind: "session",
    session: {
      id: "s1",
      status: "needs_you",
      host: "thinkpad",
      repo: "https://github.com/JesperJ/swfactory",
      dismissed: 0,
      ...over,
    },
    statusChanged: true,
    link: () => ({ project: "swfactory", feature: "006-push-notifications" }),
    ...rest,
  };
}

function job(over: Partial<JobEvent["job"]> = {}, previousStatus: JobEvent["previousStatus"] = "running"): JobEvent {
  return {
    kind: "job",
    job: { project: "swfactory", feature: "006-push-notifications", command: "build", status: "failed", ...over },
    previousStatus,
  };
}

test("a session becoming needs_you names the project, the feature and the host", () => {
  const n = notificationFor(session(), BASE);
  assert.ok(n, "needs_you must notify");
  assert.match(n.title, /swfactory/);
  assert.match(n.title, /006-push-notifications/);
  assert.match(n.body, /thinkpad/);
});

test("the notification links to the dashboard's inbox", () => {
  assert.equal(notificationFor(session(), BASE)?.click, `${BASE}/#/inbox`);
  assert.equal(notificationFor(session(), `${BASE}/`)?.click, `${BASE}/#/inbox`, "a trailing slash must not double up");
  assert.equal(notificationFor(session())?.click, undefined, "no public URL configured means no click target");
});

test("an event that leaves the status unchanged is not an event", () => {
  // A repeated idle Notification hook restates needs_you without anything having happened.
  assert.equal(notificationFor(session({}, { statusChanged: false }), BASE), null);
});

test("your_turn, working and ended produce nothing", () => {
  for (const status of ["your_turn", "working", "ended"] as SessionStatus[]) {
    assert.equal(notificationFor(session({ status }), BASE), null, `${status} must not notify`);
  }
});

test("a dismissed session produces nothing", () => {
  assert.equal(notificationFor(session({ dismissed: 1 }), BASE), null);
});

test("with no feature matched the repo names the work, and never as a path", () => {
  const n = notificationFor(session({ repo: "/home/jesper/code/repos/swfactory" }, { link: () => ({ project: null, feature: null }) }), BASE);
  assert.ok(n);
  assert.match(n.title, /swfactory/);
  assert.ok(!`${n.title} ${n.body}`.includes("/home/jesper"), "an absolute path must never reach the body");
});

test("the specs are not read unless the cheap rules pass", () => {
  let looked = 0;
  const link = () => {
    looked++;
    return { project: "swfactory", feature: "006-push-notifications" };
  };
  notificationFor(session({ status: "your_turn" }, { link }), BASE);
  notificationFor(session({}, { statusChanged: false, link }), BASE);
  assert.equal(looked, 0, "matching a session to a feature reads every spec; skip it when nothing will be sent");
  notificationFor(session({}, { link }), BASE);
  assert.equal(looked, 1);
});

test("the text carries no prompt, no assistant message and no path", () => {
  // Whatever a session is holding, only these four fields can ever reach the notification.
  const n = notificationFor(
    session({ host: "thinkpad", repo: "https://github.com/JesperJ/swfactory" }),
    BASE,
  );
  assert.ok(n);
  const text = `${n.title} ${n.body}`;
  assert.ok(!/\//.test(n.body), `the body must not contain a path separator: ${n.body}`);
  assert.ok(!text.includes("github.com"), "the repo URL itself is not needed, only its name");
  assert.equal(text.includes("\n"), false);
});

test("a host or feature with newlines cannot break the title onto two lines", () => {
  const n = notificationFor(session({ host: "box\nX-Injected: 1" }), BASE);
  assert.ok(n);
  assert.ok(!n.body.includes("\n"));
  assert.match(n.body, /box X-Injected: 1/);
});

test("a job reaching failed names the project, the feature and the command", () => {
  const n = notificationFor(job(), BASE);
  assert.ok(n, "a failed job must notify");
  assert.match(n.title, /swfactory/);
  assert.match(n.title, /006-push-notifications/);
  assert.match(n.body, /build/);
  assert.equal(n.click, `${BASE}/#/inbox`);
});

test("a failed job with no feature still names the project", () => {
  const n = notificationFor(job({ feature: null }), BASE);
  assert.ok(n);
  assert.match(n.title, /swfactory/);
});

test("done, running and a re-reported failure produce nothing", () => {
  assert.equal(notificationFor(job({ status: "done" }), BASE), null);
  assert.equal(notificationFor(job({ status: "running" }), BASE), null);
  assert.equal(notificationFor(job({}, "failed"), BASE), null, "a status it already had is not a new failure");
});

// --- sending ----------------------------------------------------------------
// Everything below injects `fetch` or a stub sender; no test here opens a socket.

import { Notifier, ntfySender, fromEnv, type Sender, type Notification } from "../src/notify.ts";

function spy(): Sender & { sent: Notification[] } {
  const sent: Notification[] = [];
  return { sent, async send(n) { sent.push(n); } };
}

test("unconfigured, fromEnv sends nothing", () => {
  assert.equal(fromEnv({}).enabled, false);
  assert.equal(fromEnv({ NTFY_TOPIC: "   " }).enabled, false, "whitespace is not a topic");
  assert.equal(fromEnv({ NTFY_TOPIC: "swf-abc123" }).enabled, true);
});

test("fromEnv takes the click target from FACTORY_PUBLIC_URL", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const topic = "swf-abc123";
  const sender = ntfySender({
    topic,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });
  new Notifier({ sender, baseUrl: BASE }).maybeSend(session());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ntfy.sh", "the default server is hosted ntfy.sh");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.topic, topic);
  assert.equal(body.click, `${BASE}/#/inbox`);
  assert.match(body.title, /swfactory/);
  assert.ok(calls[0].init.signal, "the sender must carry its own deadline");
});

test("NTFY_SERVER overrides the host, trailing slash and all", async () => {
  let seen = "";
  const sender = ntfySender({
    topic: "t",
    server: "https://ntfy.example.com/",
    fetch: (async (url: string) => {
      seen = url;
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch,
  });
  await sender.send({ title: "t", body: "b" });
  assert.equal(seen, "https://ntfy.example.com");
});

test("a non-2xx from ntfy is an error the sender raises, for the notifier to log", async () => {
  const sender = ntfySender({
    topic: "t",
    fetch: (async () => new Response("nope", { status: 429 })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => sender.send({ title: "t", body: "b" }), /429/);
});

test("the sender gives up rather than holding a socket open forever", async () => {
  // AbortSignal.timeout uses an unref'd timer, so with nothing else pending the test runner's
  // event loop drains before it can fire.
  const keepAlive = setTimeout(() => {}, 1_000);
  const sender = ntfySender({
    topic: "t",
    timeoutMs: 20,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => sender.send({ title: "t", body: "b" }));
  clearTimeout(keepAlive);
});

test("maybeSend never throws, however the sender fails", async () => {
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);

  const throws: Sender = { send() { throw new Error("sync boom"); } };
  new Notifier({ sender: throws, baseUrl: BASE, log }).maybeSend(session());

  const rejects: Sender = { send: async () => { throw new Error("async boom"); } };
  new Notifier({ sender: rejects, baseUrl: BASE, log }).maybeSend(session());
  await new Promise((r) => setImmediate(r));

  assert.equal(logged.length, 2, `both failures must be logged, not raised: ${logged.join(" | ")}`);
  assert.match(logged.join(" "), /sync boom/);
  assert.match(logged.join(" "), /async boom/);
});

test("the notifier applies the same rules as notificationFor", () => {
  const s = spy();
  const n = new Notifier({ sender: s, baseUrl: BASE });
  n.maybeSend(session({ status: "your_turn" }));
  n.maybeSend(session({}, { statusChanged: false }));
  n.maybeSend(job({ status: "done" }));
  assert.equal(s.sent.length, 0);
  n.maybeSend(job());
  assert.equal(s.sent.length, 1);
});
