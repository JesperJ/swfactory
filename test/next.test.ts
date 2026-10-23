import { test } from "node:test";
import assert from "node:assert/strict";
import { rankNext, STALE_DAYS, type LinkedSession } from "../src/next.ts";
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

test("an unlinked session is named after its repo, not 'a session'", () => {
  const s = session({ id: "s1", status: "needs_you", repo: "github.com:you/nixos-config.git" });
  const [top] = rankNext([], [s], NOW);
  assert.equal(top.title, "nixos-config");
  assert.equal(top.project, "Unlinked");
});
