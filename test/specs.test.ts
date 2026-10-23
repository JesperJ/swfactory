import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { FEATURE_STATUSES, loadProjects, normalizeRepo, renderDoc } from "../src/specs.ts";

const SPECS = join(import.meta.dirname, "..", "projects");

test("normalizeRepo handles https, ssh, credentials and the cloud git proxy", () => {
  const want = "github.com/jesperj/swfactory";
  assert.equal(normalizeRepo("https://github.com/JesperJ/swfactory.git"), want);
  assert.equal(normalizeRepo("https://x-access-token:abc@github.com/JesperJ/swfactory"), want);
  assert.equal(normalizeRepo("git@github.com:JesperJ/swfactory.git"), want);
  assert.equal(normalizeRepo("ssh://git@github.com/JesperJ/swfactory"), want);
  assert.equal(normalizeRepo("http://local_proxy@127.0.0.1:43123/git/JesperJ/swfactory"), want);
  assert.equal(normalizeRepo(""), null);
});

test("loads the factory's own project and features", () => {
  const [p] = loadProjects(SPECS).filter((x) => x.slug === "swfactory");
  assert.equal(p.name, "Software Factory");
  assert.equal(p.repo, "github.com/jesperj/swfactory");
  const f = p.features.find((x) => x.id === "001");
  assert.equal(f?.slug, "001-dashboard");
  // Not the literal status: these specs are live and their statuses move. Assert that every
  // feature parses into the lifecycle, which is what the dashboard and ranking depend on.
  for (const x of p.features) {
    assert.ok(FEATURE_STATUSES.includes(x.status as (typeof FEATURE_STATUSES)[number]), `${x.slug}: ${x.status}`);
    assert.ok(x.title.length > 0, `${x.slug} has no title`);
  }
});

test("renderDoc renders markdown and refuses path traversal", () => {
  const doc = renderDoc(SPECS, "swfactory", "001-dashboard");
  assert.match(doc!.html, /<h2[^>]*>Acceptance criteria<\/h2>/);
  assert.equal(renderDoc(SPECS, "..", "package"), null);
  assert.equal(renderDoc(SPECS, "swfactory", "../../package"), null);
  assert.equal(loadProjects("/does/not/exist").length, 0);
});
