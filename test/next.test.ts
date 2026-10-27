import { test } from "node:test";
import assert from "node:assert/strict";
import { featureAction, lifecycleCounts, NEXT_FINISHED_HOURS, rankNext, STALE_DAYS, type LinkedSession } from "../src/next.ts";
import { isJobCommand } from "../src/db.ts";
import type { Feature, Project } from "../src/specs.ts";

const NOW = new Date("2026-10-23T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString().slice(0, 10);

function feature(over: Partial<Feature> & { slug: string }): Feature {
  return {
    id: over.slug.slice(0, 3),
    title: over.slug,
    status: "planned",
    priority: "P2",
    summary: null,
    blocked: null,
    lastLog: null,
    criteria: { ticked: 0, total: 0 },
    rounds: [],
    prUrl: null,
    question: null,
    vcs: null,
    file: `${over.slug}.md`,
    ...over,
  };
}

function project(slug: string, features: Feature[], status = "active"): Project {
  return { slug, name: slug, status, summary: null, repo: null, repoUrl: null, features, file: "" };
}

function session(over: Partial<LinkedSession> & { id: string }): LinkedSession {
  return {
    status: "your_turn",
    url: null,
    cwd: null,
    repo: null,
    branch: null,
    host: null,
    feature_hint: null,
    prompt: null,
    message: null,
    last_event: "Stop",
    started_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    dismissed: 0,
    status_since: NOW.toISOString(),
    project: null,
    feature: null,
    ...over,
  };
}

test("a blocked session outranks everything else", () => {
  const projects = [project("shop", [feature({ slug: "001-a", status: "planned", priority: "P1" })])];
  const sessions = [session({ id: "s1", status: "needs_you", project: "shop" })];
  const [top] = rankNext(projects, sessions, NOW);
  assert.equal(top.kind, "answer");
  assert.equal(top.action, "Answer");
});

test("a stalled build outranks a ready-to-build feature", () => {
  const projects = [
    project("shop", [
      feature({ slug: "001-stalled", status: "building", lastLog: daysAgo(STALE_DAYS + 2) }),
      feature({ slug: "002-ready", status: "planned", priority: "P1" }),
    ]),
  ];
  const ranked = rankNext(projects, [], NOW);
  assert.equal(ranked[0].feature, "001-stalled");
  assert.match(ranked[0].reason, /no activity for 9 days/);
  assert.equal(ranked[1].feature, "002-ready");
});

test("a recently active build is not treated as stalled", () => {
  const projects = [project("shop", [feature({ slug: "001-a", status: "building", lastLog: daysAgo(1) })])];
  const [top] = rankNext(projects, [], NOW);
  assert.equal(top.action, "Continue");
  assert.equal(top.reason, "in progress, nothing running");
});

test("priority orders features of equal urgency, P1 first", () => {
  const projects = [
    project("shop", [
      feature({ slug: "001-p3", status: "planned", priority: "P3" }),
      feature({ slug: "002-p1", status: "planned", priority: "P1" }),
    ]),
  ];
  const ranked = rankNext(projects, [], NOW);
  assert.deepEqual(ranked.map((r) => r.feature), ["002-p1", "001-p3"]);
});

test("blocked features sink below everything actionable, keeping their reason", () => {
  const projects = [
    project("shop", [
      feature({ slug: "001-blocked", status: "planned", priority: "P1", blocked: "waiting on a domain" }),
      feature({ slug: "002-idea", status: "idea", priority: "P3" }),
    ]),
  ];
  const ranked = rankNext(projects, [], NOW);
  assert.equal(ranked[0].feature, "002-idea");
  assert.equal(ranked.at(-1)!.feature, "001-blocked");
  assert.equal(ranked.at(-1)!.blocked, true);
  assert.equal(ranked.at(-1)!.reason, "waiting on a domain");
});

test("a feature with a session actively working is not offered as a next action", () => {
  const projects = [project("shop", [feature({ slug: "001-a", status: "building", lastLog: daysAgo(30) })])];
  const s = session({ id: "s1", status: "working", project: "shop", feature: "001-a" });
  assert.equal(rankNext(projects, [s], NOW).length, 0);
});

test("paused projects and done features are skipped", () => {
  const projects = [
    project("old", [feature({ slug: "001-a", status: "planned" })], "paused"),
    project("shop", [feature({ slug: "002-done", status: "done" })]),
  ];
  assert.deepEqual(rankNext(projects, [], NOW), []);
});

test("a long-finished session stops being urgent", () => {
  const old = new Date(NOW.getTime() - 72 * 3600_000).toISOString();
  const s = session({ id: "s1", status: "your_turn", project: "shop", updated_at: old, status_since: old });
  assert.deepEqual(rankNext([project("shop", [])], [s], NOW), []);
});

test("a session in a repo the factory does not track never reaches Next", () => {
  // It is still visible in the Inbox; it is just not a factory decision.
  const s = session({ id: "s1", status: "needs_you", repo: "github.com:you/nixos-config.git" });
  assert.deepEqual(rankNext([project("shop", [])], [s], NOW), []);
});

test("a blocked session still ranks even with no feature attached", () => {
  const s = session({ id: "s1", status: "needs_you", project: "shop" });
  const [top] = rankNext([project("shop", [])], [s], NOW);
  assert.equal(top.title, "shop session");
  assert.equal(top.action, "Answer");
});

test("a finished session with no feature is left to the Inbox", () => {
  // Usually the session you are currently typing in; recommending it is noise.
  const s = session({ id: "s1", status: "your_turn", project: "shop" });
  assert.deepEqual(rankNext([project("shop", [])], [s], NOW), []);
});

test("review work outranks starting anything new", () => {
  const projects = [
    project("shop", [
      feature({ slug: "001-review", status: "reviewing", priority: "P3" }),
      feature({ slug: "002-ready", status: "planned", priority: "P1" }),
      feature({ slug: "003-going", status: "building", priority: "P1", lastLog: daysAgo(1) }),
    ]),
  ];
  const ranked = rankNext(projects, [], NOW);
  assert.equal(ranked[0].feature, "001-review", "finishing beats widening the work");
  assert.equal(ranked[0].action, "Review");
  assert.equal(ranked[0].reason, "built, waiting on review");
});

test("each kind carries the command it actually queues", () => {
  // Round 1 of 005: the UI kept a second copy of this mapping and sent `approve` to `build`,
  // so the hero's "Review it" queued a build that dead-ended on build's own status guard.
  const statuses = { reviewing: "review", planned: "build", specced: "plan", idea: "spec" };
  for (const [status, command] of Object.entries(statuses)) {
    const a = featureAction(feature({ slug: "001-x", status }), NOW);
    assert.equal(a?.command, command, `${status} must queue ${command}`);
  }
  const building = featureAction(feature({ slug: "001-x", status: "building", lastLog: daysAgo(1) }), NOW);
  assert.equal(building?.command, "build");
  assert.equal(featureAction(feature({ slug: "001-x", status: "done" }), NOW), null);
});

test("a reviewing feature's ranked item queues a review, not a build", () => {
  const projects = [project("shop", [feature({ slug: "001-r", status: "reviewing" })])];
  const [top] = rankNext(projects, [], NOW);
  assert.equal(top.action, "Review");
  assert.equal(top.command, "review", "the verb and the command must agree");
});

test("a session item carries no command, because no command can answer a session", () => {
  const s = session({ id: "s1", status: "needs_you", project: "shop" });
  const [top] = rankNext([project("shop", [])], [s], NOW);
  assert.equal(top.kind, "answer");
  assert.equal(top.command, null);
});

test("every command a feature can queue is one the API accepts", () => {
  for (const status of ["reviewing", "building", "planned", "specced", "idea"]) {
    const a = featureAction(feature({ slug: "001-x", status }), NOW);
    if (a?.command) assert.ok(isJobCommand(a.command), `${status} queues ${a.command}, which the API would reject`);
  }
});

test("a ranked feature carries the priority and status its spec has", () => {
  // The table needs both as columns. Round 1 of 005 found the UI deriving what the server
  // should hand it; these come from the server for the same reason.
  const projects = [project("shop", [feature({ slug: "001-a", status: "planned", priority: "P1" })])];
  const [top] = rankNext(projects, [], NOW);
  assert.equal(top.priority, "P1");
  assert.equal(top.status, "planned");
});

test("a session row carries no priority or status", () => {
  const s = session({ id: "s1", status: "needs_you", project: "shop" });
  const [top] = rankNext([project("shop", [])], [s], NOW);
  assert.equal(top.priority, null);
  assert.equal(top.status, null, "a session is not at a lifecycle stage");
});

test("lifecycleCounts returns every stage in order, including empty ones", () => {
  const projects = [
    project("shop", [
      feature({ slug: "001-a", status: "idea" }),
      feature({ slug: "002-b", status: "idea" }),
      feature({ slug: "003-c", status: "reviewing" }),
      feature({ slug: "004-d", status: "done" }),
    ]),
  ];
  const stages = lifecycleCounts(projects);
  assert.deepEqual(stages.map((s) => s.status), ["idea", "specced", "planned", "building", "reviewing", "done"]);
  assert.deepEqual(stages.map((s) => s.count), [2, 0, 0, 0, 1, 1]);
});

test("lifecycleCounts counts only active projects, and the counts sum to their features", () => {
  const projects = [
    project("shop", [feature({ slug: "001-a", status: "idea" }), feature({ slug: "002-b", status: "done" })]),
    project("old", [feature({ slug: "003-c", status: "idea" })], "paused"),
  ];
  const total = lifecycleCounts(projects).reduce((n, s) => n + s.count, 0);
  assert.equal(total, 2, "a paused project's features are not in the strip");
});

test("a status outside the lifecycle is shown last rather than silently dropped", () => {
  const projects = [project("shop", [feature({ slug: "001-a", status: "wat" })])];
  const stages = lifecycleCounts(projects);
  assert.equal(stages.at(-1)!.status, "wat");
  assert.equal(stages.at(-1)!.count, 1);
});

// --- which sessions still count as work ---------------------------------------------------
//
// Next showed four unactionable session rows out of eight: one on a feature that was done and
// merged, two whose specs had been read hours earlier. These three rules are what stop that.

const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3600_000).toISOString();

test("a session on a done feature never ranks, in either sort order", () => {
  const projects = [project("shop", [feature({ slug: "006-ntfy", status: "done" })])];
  const sessions = [session({ id: "s1", project: "shop", feature: "006-ntfy", status_since: hoursAgo(1) })];
  // Finished and merged — nothing the session could say changes that. Both sort orders are
  // covered by one assertion: the view sorts whatever rankNext returns, so a row that is never
  // produced cannot appear under either.
  assert.deepEqual(rankNext(projects, sessions, NOW).filter((i) => i.sessionId), []);
});

test("a your_turn session ages out after two hours, a blocked session never does", () => {
  const projects = [project("shop", [feature({ slug: "001-a", status: "building" })])];
  const fresh = session({ id: "fresh", project: "shop", feature: "001-a", status_since: hoursAgo(1) });
  const stale = session({ id: "stale", project: "shop", feature: "001-a", status_since: hoursAgo(3) });
  // "It stopped and wants a read" stops being true once it has sat there unread for hours.
  assert.equal(rankNext(projects, [fresh], NOW).some((i) => i.sessionId === "fresh"), true);
  assert.equal(rankNext(projects, [stale], NOW).some((i) => i.sessionId === "stale"), false);

  // Blocked is blocked however long it has waited. Round 1 caught a 48-hour cutoff added here
  // under a comment claiming nothing had changed — this test asserted the regression as if it
  // were the status quo. The weekend case is the one that matters: a session blocked on a
  // permission prompt on Friday must still be the top row on Monday.
  for (const h of [40, 60, 24 * 14]) {
    const blocked = session({ id: `b${h}`, project: "shop", feature: "001-a", status: "needs_you", status_since: hoursAgo(h) });
    assert.equal(
      rankNext(projects, [blocked], NOW).some((i) => i.sessionId === `b${h}`),
      true,
      `a session blocked ${h}h ago must still rank`,
    );
  }
});

test("the two windows are separate numbers, so tightening one does not move the other", () => {
  // A regression guard with a reason: reusing one constant would mean a change to what Next
  // displays silently became a change to what the runner destroys.
  assert.equal(NEXT_FINISHED_HOURS, 2);
  assert.notEqual(NEXT_FINISHED_HOURS, 48);
});
