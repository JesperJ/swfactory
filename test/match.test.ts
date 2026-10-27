import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFeature, matchProject } from "../src/match.ts";
import type { Feature, Project } from "../src/specs.ts";

const feature = (id: string, slug: string): Feature => ({
  id, slug, title: slug, status: "planned", priority: null, summary: null, blocked: null, lastLog: null,
  criteria: { ticked: 0, total: 0 }, rounds: [], prUrl: null, question: null, vcs: null, file: `${slug}.md`,
});
const features = [feature("003", "003-login"), feature("012", "012-export-csv")];
const projects: Project[] = [
  { slug: "shop", name: "Shop", status: "active", summary: null, repo: "github.com/acme/shop", repoUrl: null, features, file: "" },
  { slug: "blog", name: "Blog", status: "active", summary: null, repo: null, repoUrl: null, features: [], file: "" },
];

test("project matches by git remote, then by folder name", () => {
  assert.equal(matchProject({ repo: "git@github.com:Acme/shop.git", cwd: "/x/whatever" }, projects)?.slug, "shop");
  assert.equal(matchProject({ repo: null, cwd: "/home/me/code/blog" }, projects)?.slug, "blog");
  assert.equal(matchProject({ repo: "github.com/other/thing", cwd: "/tmp/x" }, projects), null);
});

test("feature matches by explicit hint, branch slug, or branch number", () => {
  assert.equal(matchFeature({ feature_hint: "12", branch: null }, features)?.slug, "012-export-csv");
  assert.equal(matchFeature({ feature_hint: "003-login", branch: null }, features)?.slug, "003-login");
  assert.equal(matchFeature({ feature_hint: null, branch: "feature/003-login" }, features)?.slug, "003-login");
  assert.equal(matchFeature({ feature_hint: null, branch: "feat/12-csv" }, features)?.slug, "012-export-csv");
  assert.equal(matchFeature({ feature_hint: null, branch: "main" }, features), null);
  assert.equal(matchFeature({ feature_hint: null, branch: "fix-v2" }, features), null);
});
