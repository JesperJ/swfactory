import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCriteria, FEATURE_STATUSES, loadProjects, loadRounds, normalizeRepo, prUrlFrom, renderDoc } from "../src/specs.ts";

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

// --- the facts the dashboard could never see -------------------------------------------------

test("acceptance criteria are counted, and tasks are not mistaken for them", () => {
  // Tasks are checkboxes too. Counting both would let a feature look finished because its work
  // was done rather than because its criteria were met — the confusion 017 exists to remove.
  const body = `
## Acceptance criteria
- [x] one
- [ ] two
- [x] three

## Tasks
- [x] a task
- [x] another task
`;
  assert.deepEqual(countCriteria(body), { ticked: 2, total: 3 });
});

test("a spec with no criteria section counts as nothing, never as finished", () => {
  assert.deepEqual(countCriteria("# Just a title\n\nsome prose"), { ticked: 0, total: 0 });
  assert.deepEqual(countCriteria(""), { ticked: 0, total: 0 });
  // A half-written criterion marked `[~]` is present but not ticked.
  assert.deepEqual(countCriteria("## Acceptance criteria\n- [~] half done\n"), { ticked: 0, total: 1 });
});

test("the newest pull request link is taken from the Log", () => {
  const body = `
## Log
- 2026-10-01 PR: https://github.com/JesperJ/swfactory/pull/5
- 2026-10-02 reworked, PR: https://github.com/JesperJ/swfactory/pull/19
`;
  assert.equal(prUrlFrom(body), "https://github.com/JesperJ/swfactory/pull/19");
  assert.equal(prUrlFrom("no links here"), null);
});

test("review rounds are found for the right feature only", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-reviews-"));
  writeFileSync(join(dir, "015-round-1.md"), "# r1\n\nDate: 2026-10-24\n");
  writeFileSync(join(dir, "015-round-2.md"), "# r2\n\nDate: 2026-10-26\n");
  writeFileSync(join(dir, "015-round-3.md"), "# r3 with no date line\n");
  writeFileSync(join(dir, "016-round-1.md"), "# other feature\n\nDate: 2026-10-26\n");
  writeFileSync(join(dir, "notes.md"), "not a round file");

  const rounds = loadRounds(dir, "015");
  assert.deepEqual(rounds.map((r) => r.n), [1, 2, 3], "numerically ordered, and only 015's");
  assert.equal(rounds[1].date, "2026-10-26");
  assert.equal(rounds[2].date, null, "a round file without a Date still counts as a round");
  assert.deepEqual(loadRounds(dir, "011"), []);
  assert.deepEqual(loadRounds(join(dir, "nope"), "015"), [], "a missing directory is not an error");
  rmSync(dir, { recursive: true, force: true });
});

test("the real specs load with their new facts attached", () => {
  // Against this repo's own projects/, so the parsers are exercised on files nobody wrote for
  // a test — including every half-finished spec currently on disk.
  const [project] = loadProjects(join(import.meta.dirname, "..", "projects"));
  const byId = Object.fromEntries(project.features.map((f) => [f.id, f]));
  assert.ok(byId["015"].rounds.length >= 3, "015 has been reviewed three times");
  assert.ok(byId["015"].criteria.total > 0, "and its criteria were counted");
  assert.ok(byId["015"].prUrl?.startsWith("https://github.com/"), "and a PR link was found");
  assert.equal(byId["001"].rounds.length, 0, "a feature never reviewed has no rounds");
  for (const f of project.features) {
    assert.ok(f.criteria.ticked <= f.criteria.total, `${f.slug}: ticked cannot exceed total`);
    assert.equal(f.vcs, null, "nothing has reported version control state yet");
  }
});
