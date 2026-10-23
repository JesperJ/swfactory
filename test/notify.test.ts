import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notificationFor,
  sessionWouldNotify,
  Notifier,
  ntfySender,
  fromEnv,
  COOLDOWN_MS,
  type SessionEvent,
  type JobEvent,
  type Sender,
  type Notification,
} from "../src/notify.ts";
import type { SessionStatus } from "../src/db.ts";

const BASE = "http://factory.local:3000";

// Delivery is deferred off the request path with setImmediate, so every assertion about what
// was sent has to let one turn of the loop pass first.
const flush = () => new Promise((r) => setImmediate(r));

function session(over: Partial<SessionEvent["session"]> = {}, rest: Partial<SessionEvent> = {}): SessionEvent {
  return {
    kind: "session",
    session: {
      id: "s1",
      status: "needs_you",
      host: "thinkpad",
      repo: "https://github.com/JesperJ/swfactory",
      cwd: "/home/jesper/code/repos/swfactory",
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

// --- the rules --------------------------------------------------------------

test("a session becoming needs_you names the project, the feature and the host", () => {
  const n = notificationFor(session(), BASE);
  assert.ok(n, "needs_you must notify");
  // The title is what a lock screen clips, so the part that varies between two blocked
  // sessions — the feature — lives in the body where it survives.
  assert.equal(n.title, "Needs you: swfactory");
  assert.equal(n.body, "006-push-notifications · thinkpad");
});

test("the notification links to the dashboard's inbox", () => {
  assert.equal(notificationFor(session(), BASE)?.click, `${BASE}/#/inbox`);
  assert.equal(notificationFor(session(), `${BASE}/`)?.click, `${BASE}/#/inbox`, "a trailing slash must not double up");
  assert.equal(notificationFor(session())?.click, undefined, "no public URL configured means no click target");
});

test("an event that leaves the status unchanged is not an event", () => {
  // A repeated idle Notification hook restates needs_you without anything having happened.
  assert.equal(notificationFor(session({}, { statusChanged: false }), BASE), null);
  assert.equal(sessionWouldNotify(session({}, { statusChanged: false })), false);
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
  const n = notificationFor(
    session({ repo: "/home/jesper/code/repos/swfactory" }, { link: () => ({ project: null, feature: null }) }),
    BASE,
  );
  assert.ok(n);
  assert.equal(n.title, "Needs you: swfactory");
  assert.ok(!`${n.title} ${n.body}`.includes("/home/jesper"), "an absolute path must never reach the body");
  assert.equal(n.body, "thinkpad", "the body must not repeat what the title already said");
});

test("with no repo either, the cwd's last segment names it — the same rung the UI uses", () => {
  const n = notificationFor(
    session({ repo: null, cwd: "/home/jesper/scratch/experiment" }, { link: () => ({ project: null, feature: null }) }),
    BASE,
  );
  assert.ok(n);
  assert.equal(n.title, "Needs you: experiment");
  assert.ok(!`${n.title} ${n.body}`.includes("/home/jesper"));
});

test("with nothing to name it at all, it still says something", () => {
  const n = notificationFor(
    session({ repo: null, cwd: null, host: null }, { link: () => ({ project: null, feature: null }) }),
    BASE,
  );
  assert.ok(n);
  assert.equal(n.title, "Needs you: unknown work");
  assert.equal(n.body, "Claude is blocked on you", "the body is never empty");
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
  const n = notificationFor(session(), BASE);
  assert.ok(n);
  const text = `${n.title} ${n.body}`;
  assert.ok(!text.includes("/"), `no path separator may appear: ${text}`);
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
  assert.equal(n.title, "Job failed: swfactory");
  assert.equal(n.body, "006-push-notifications · /factory build");
});

test("a failed job links to the doc sheet, which shows the job — not the inbox, which never does", () => {
  assert.equal(
    notificationFor(job(), BASE)?.click,
    `${BASE}/#/next/doc/swfactory/006-push-notifications`,
    "the inbox renders sessions only; a tap there lands on 'All quiet' right after saying something failed",
  );
  assert.equal(notificationFor(job({ feature: null }), BASE)?.click, `${BASE}/#/next`);
});

test("a project or feature with a slash in it cannot break out of the click URL", () => {
  const n = notificationFor(job({ project: "a/b", feature: "c d/e" }), BASE);
  assert.equal(n?.click, `${BASE}/#/next/doc/a%2Fb/c%20d%2Fe`);
});

test("a failed job with no feature still names the project", () => {
  const n = notificationFor(job({ feature: null }), BASE);
  assert.ok(n);
  assert.equal(n.title, "Job failed: swfactory");
  assert.equal(n.body, "/factory build");
});

test("done, running and a re-reported failure produce nothing", () => {
  assert.equal(notificationFor(job({ status: "done" }), BASE), null);
  assert.equal(notificationFor(job({ status: "running" }), BASE), null);
  assert.equal(notificationFor(job({}, "failed"), BASE), null, "a status it already had is not a new failure");
});

// --- sending ----------------------------------------------------------------
// Everything below injects `fetch` or a stub sender; no test here opens a socket.

function spy(): Sender & { sent: Notification[] } {
  const sent: Notification[] = [];
  return { sent, async send(n) { sent.push(n); } };
}

function fetchSpy(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fn };
}

test("unconfigured, fromEnv sends nothing", () => {
  assert.equal(fromEnv({}, () => {}).enabled, false);
  assert.equal(fromEnv({ NTFY_TOPIC: "   " }, () => {}).enabled, false, "whitespace is not a topic");
  assert.equal(fromEnv({ NTFY_TOPIC: "swf-abc123" }, () => {}).enabled, true);
});

test("a topic with no public URL is called out at startup, not left to be discovered on the phone", () => {
  const logged: string[] = [];
  fromEnv({ NTFY_TOPIC: "t" }, (m) => logged.push(m));
  assert.match(logged.join(" "), /FACTORY_PUBLIC_URL/);

  logged.length = 0;
  fromEnv({ NTFY_TOPIC: "t", FACTORY_PUBLIC_URL: BASE }, (m) => logged.push(m));
  fromEnv({ FACTORY_PUBLIC_URL: BASE }, (m) => logged.push(m));
  assert.deepEqual(logged, [], "fully configured, and not configured at all, are both quiet");
});

test("the ntfy payload carries the topic, the text, the click target and a high priority", async () => {
  const { calls, fn } = fetchSpy();
  new Notifier({ sender: ntfySender({ topic: "swf-abc123", fetch: fn }), baseUrl: BASE }).maybeSend(session());
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ntfy.sh", "the default server is hosted ntfy.sh");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.topic, "swf-abc123");
  assert.equal(body.click, `${BASE}/#/inbox`);
  assert.equal(body.title, "Needs you: swfactory");
  // In the message, so iOS gets it too — only the Android app has a per-subscription setting.
  assert.equal(body.priority, 4);
  assert.ok(calls[0].init.signal, "the sender must carry its own deadline");
});

test("NTFY_SERVER overrides the host, trailing slash and all", async () => {
  const { calls, fn } = fetchSpy();
  await ntfySender({ topic: "t", server: "https://ntfy.example.com/", fetch: fn }).send({ title: "t", body: "b" });
  assert.equal(calls[0].url, "https://ntfy.example.com");
});

test("the response body is released rather than left pinning the socket", async () => {
  let cancelled = false;
  const fn = (async () => {
    const res = new Response("ok");
    const original = res.body!.cancel.bind(res.body);
    Object.defineProperty(res.body, "cancel", {
      value: (reason?: unknown) => { cancelled = true; return original(reason); },
    });
    return res;
  }) as unknown as typeof globalThis.fetch;
  await ntfySender({ topic: "t", fetch: fn }).send({ title: "t", body: "b" });
  assert.equal(cancelled, true);
});

test("a non-2xx from ntfy is an error the sender raises, for the notifier to log", async () => {
  const { fn } = fetchSpy(429);
  await assert.rejects(() => ntfySender({ topic: "t", fetch: fn }).send({ title: "t", body: "b" }), /429/);
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

test("maybeSend returns before it does any work at all", () => {
  let touched = false;
  const n = new Notifier({ sender: spy(), baseUrl: BASE });
  n.maybeSend(session({}, { link: () => { touched = true; return { project: null, feature: null }; } }));
  assert.equal(touched, false, "the specs read must not happen inside the caller's turn");
});

test("maybeSend never throws, however the sender fails", async () => {
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);

  const throws: Sender = { send() { throw new Error("sync boom"); } };
  new Notifier({ sender: throws, baseUrl: BASE, log }).maybeSend(session());

  const rejects: Sender = { send: async () => { throw new Error("async boom"); } };
  new Notifier({ sender: rejects, baseUrl: BASE, log }).maybeSend(session());
  await flush();
  await flush();

  assert.equal(logged.length, 2, `both failures must be logged, not raised: ${logged.join(" | ")}`);
  assert.match(logged.join(" "), /sync boom/);
  assert.match(logged.join(" "), /async boom/);
});

test("a thunk that throws is logged, not left to take the process down from a detached callback", async () => {
  const logged: string[] = [];
  const s = spy();
  new Notifier({ sender: s, baseUrl: BASE, log: (m) => logged.push(m) }).maybeSend(
    session({}, { link: () => { throw new Error("unreadable specs"); } }),
  );
  await flush();
  assert.equal(s.sent.length, 0);
  assert.match(logged.join(" "), /unreadable specs/);
});

test("the notifier applies the same rules as notificationFor", async () => {
  const s = spy();
  const n = new Notifier({ sender: s, baseUrl: BASE });
  n.maybeSend(session({ status: "your_turn" }));
  n.maybeSend(session({}, { statusChanged: false }));
  n.maybeSend(job({ status: "done" }));
  await flush();
  assert.equal(s.sent.length, 0);
  n.maybeSend(job());
  await flush();
  assert.equal(s.sent.length, 1);
});

// --- cooldown ---------------------------------------------------------------

function cooled(start = 0) {
  const clock = { t: start };
  const s = spy();
  return { clock, sent: s.sent, n: new Notifier({ sender: s, baseUrl: BASE, now: () => clock.t }) };
}

test("a session flapping needs_you → working → needs_you notifies once, not twice", async () => {
  const { clock, sent, n } = cooled();
  n.maybeSend(session());
  await flush();
  clock.t += 30_000;
  n.maybeSend(session({ status: "working" }));
  await flush();
  clock.t += 30_000;
  n.maybeSend(session());
  await flush();
  assert.equal(sent.length, 1, "the same stuck session is not a second thing to know about");
});

test("a cooled session does not pay for the specs read it would throw away", async () => {
  let looked = 0;
  const link = () => {
    looked++;
    return { project: "swfactory", feature: "006-push-notifications" };
  };
  const { n } = cooled();
  n.maybeSend(session({}, { link }));
  await flush();
  assert.equal(looked, 1);
  n.maybeSend(session({}, { link }));
  await flush();
  assert.equal(looked, 1, "the cooldown must gate before notificationFor, not after it");
});

test("past the cooldown the same session can notify again", async () => {
  const { clock, sent, n } = cooled();
  n.maybeSend(session());
  await flush();
  clock.t += COOLDOWN_MS - 1;
  n.maybeSend(session());
  await flush();
  assert.equal(sent.length, 1);
  clock.t += 1;
  n.maybeSend(session());
  await flush();
  assert.equal(sent.length, 2);
});

test("the cooldown is per session, so two sessions blocking at once both notify", async () => {
  // Deliberate, and the risk the plan names: these are two things needing you. If a busy
  // moment buzzes too much, the fix is a global rate limit, not a longer per-session cooldown.
  const { sent, n } = cooled();
  n.maybeSend(session({ id: "s1" }));
  n.maybeSend(session({ id: "s2" }));
  await flush();
  assert.equal(sent.length, 2);
});

test("failed jobs are not cooled; each failure is its own", async () => {
  const { sent, n } = cooled();
  n.maybeSend(job({ feature: "006-push-notifications" }));
  n.maybeSend(job({ feature: "007-private-specs" }));
  await flush();
  assert.equal(sent.length, 2);
});
