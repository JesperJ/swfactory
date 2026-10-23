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
