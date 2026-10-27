import { test } from "node:test";
import assert from "node:assert/strict";
import { featureAction, featureFacts, featureOptions, lifecycleCounts, NEXT_FINISHED_HOURS, rankNext, roundIsStale, STALE_DAYS, type LinkedSession } from "../src/next.ts";
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
  // Was "built, waiting on review" for every reviewing feature alike, which is the wording 017
  // exists to kill: it said the same thing about a feature nobody had read and one on its
  // third round.
  assert.equal(ranked[0].reason, "never reviewed");
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

// --- what a feature could do, and what it should ---------------------------------------------
//
// One button per feature had to be right every time or it taught you to distrust it. It wasn't:
// 011 offered "Review it" for a feature already reviewed twice, whose PR had merged weeks
// earlier, which was sitting on an unanswered question. Pressing it burned three agents on
// unchanged code.

const recommended = (f: Feature) => featureOptions(f, NOW).find((o) => o.recommended);

test("a feature with none of the new facts behaves exactly as it did before", () => {
  // The regression that matters: nothing on the board changes for a plain feature.
  assert.equal(recommended(feature({ slug: "001-a", status: "planned" }))?.action, "Build");
  assert.equal(recommended(feature({ slug: "001-a", status: "specced" }))?.action, "Plan");
  assert.equal(recommended(feature({ slug: "001-a", status: "idea" }))?.action, "Spec");
  assert.equal(recommended(feature({ slug: "001-a", status: "done" })), undefined);
});

test("an unanswered question outranks everything and offers no agent", () => {
  const f = feature({ slug: "015-x", status: "reviewing", question: "Job table, or make a retarget cost the clock?" });
  const opts = featureOptions(f, NOW);
  const top = opts.find((o) => o.recommended)!;
  assert.equal(top.kind, "escalated");
  assert.equal(top.action, "Answer");
  assert.equal(top.reason, "Job table, or make a retarget cost the clock?", "the row shows the question itself");
  assert.equal(top.command, null, "no sub-command can answer it");
  // And nothing else on the row may quietly queue a review instead.
  assert.equal(opts.find((o) => o.recommended && o.command !== null), undefined);
});

test("Mark done is offered only when it would be honest", () => {
  const base = { slug: "001-a", status: "reviewing", rounds: [{ n: 1, date: "2026-10-20" }], lastLog: "2026-10-19" };
  const has = (over: Partial<Feature>) => featureOptions(feature({ ...base, ...over } as Partial<Feature> & { slug: string }), NOW).some((o) => o.kind === "finish");

  assert.equal(has({ criteria: { ticked: 9, total: 9 } }), true, "reviewed and every criterion met");
  // Both of these were ticked while false during 015, which is why they are rules.
  assert.equal(has({ criteria: { ticked: 8, total: 9 } }), false, "a criterion is unticked");
  assert.equal(
    has({ criteria: { ticked: 9, total: 9 }, lastLog: "2026-10-21" }),
    false,
    "built again since the newest round, so the findings predate the code",
  );
  assert.equal(has({ criteria: { ticked: 9, total: 9 }, rounds: [] }), false, "never reviewed at all");
  assert.equal(
    has({ criteria: { ticked: 9, total: 9 }, question: "which one?" }),
    false,
    "an unanswered question is not a finished feature",
  );
});

test("a reviewing feature says which round would be next, and why", () => {
  const fresh = featureOptions(feature({ slug: "016-x", status: "reviewing" }), NOW)[0];
  assert.equal(fresh.action, "Review");
  assert.equal(fresh.reason, "never reviewed");

  const twice = featureOptions(
    feature({ slug: "011-x", status: "reviewing", rounds: [{ n: 1, date: "2026-10-20" }, { n: 2, date: "2026-10-22" }], lastLog: "2026-10-23" }),
    NOW,
  )[0];
  assert.equal(twice.action, "Review again (round 3)", "and not a bare 'Review it'");
  assert.equal(twice.reason, "reviewed, but built again since");
});

test("a blocked feature offers unblocking rather than nothing at all", () => {
  // Rounds 1 and 2 of 015 both found blocked rows rendering with an empty action cell, in a
  // view whose whole premise is that every row can be acted on.
  const opts = featureOptions(feature({ slug: "004-deploy", status: "planned", blocked: "needs a domain" }), NOW);
  const top = opts.find((o) => o.recommended)!;
  assert.equal(top.kind, "unblock");
  assert.equal(top.reason, "needs a domain");
  assert.equal(top.command, null, "no agent can unblock it");
  assert.equal(opts.some((o) => o.kind === "build"), false, "and it does not also offer to build");
});

test("a pull request is a link, never an action", () => {
  const opts = featureOptions(
    feature({ slug: "016-x", status: "reviewing", prUrl: "https://github.com/JesperJ/swfactory/pull/19" }),
    NOW,
  );
  const pr = opts.find((o) => o.kind === "link")!;
  assert.equal(pr.href, "https://github.com/JesperJ/swfactory/pull/19");
  assert.equal(pr.command, null, "the dashboard does not drive git");
  assert.equal(pr.recommended, false, "and a link is never the recommendation");
  assert.equal(pr.action, "Open PR");
  // Once the runner says it merged, the row says so instead of inviting a click to find out.
  const merged = featureOptions(
    feature({ slug: "016-x", status: "reviewing", prUrl: "https://x/pull/1", vcs: { branch: "feature/016-x", exists: true, merged: true } }),
    NOW,
  ).find((o) => o.kind === "link")!;
  assert.equal(merged.action, "PR merged");
});

test("the facts line states facts, not a verdict", () => {
  assert.deepEqual(
    featureFacts(feature({ slug: "015-x", status: "reviewing", rounds: [{ n: 1, date: "2026-10-20" }, { n: 2, date: "2026-10-21" }], lastLog: "2026-10-26", criteria: { ticked: 13, total: 14 } })),
    ["2 rounds", "round 2 predates the last build", "1 of 14 criteria unticked"],
  );
  assert.deepEqual(featureFacts(feature({ slug: "016-x", status: "reviewing" })), ["never reviewed"]);
  assert.deepEqual(featureFacts(feature({ slug: "001-a", status: "planned" })), [], "nothing to say is said as nothing");
});

test("cannot-tell is not evidence of staleness", () => {
  // A round file with no Date, or a spec with no Log, must not make the board claim the
  // findings are stale — it does not know.
  assert.equal(roundIsStale(feature({ slug: "a", status: "reviewing", rounds: [{ n: 1, date: null }], lastLog: "2026-10-26" })), false);
  assert.equal(roundIsStale(feature({ slug: "a", status: "reviewing", rounds: [{ n: 1, date: "2026-10-20" }], lastLog: null })), false);
});
