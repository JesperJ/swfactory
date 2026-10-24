import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId } from "../src/build-id.ts";

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "factory-build-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(d, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return d;
}

test("the id changes when a served file's content changes", () => {
  const a = dirWith({ "app.js": "one", "styles.css": "x" });
  const b = dirWith({ "app.js": "two", "styles.css": "x" });
  assert.notEqual(buildId(a), buildId(b));
});

test("the id does not change when only a timestamp changes", () => {
  // A container rebuild rewrites every mtime. A page must not reload because a file was copied.
  const d = dirWith({ "app.js": "same", "styles.css": "x" });
  const before = buildId(d);
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(d, "app.js"), future, future);
  assert.equal(buildId(d), before);
});

test("the id changes when a file is renamed, even with identical content", () => {
  const a = dirWith({ "app.js": "same" });
  const b = dirWith({ "other.js": "same" });
  assert.notEqual(buildId(a), buildId(b), "paths are part of what the page is running");
});

test("the id is stable across calls and short enough to read", () => {
  const d = dirWith({ "app.js": "x", "sub/deep.css": "y" });
  assert.equal(buildId(d), buildId(d));
  assert.match(buildId(d), /^[0-9a-f]{8}$/);
});

test("a missing directory yields an id rather than throwing", () => {
  assert.match(buildId("/does/not/exist"), /^[0-9a-f]{8}$/);
});

test("an unreadable entry does not stop the server booting", () => {
  // buildId runs inside createApp, so throwing here means nothing serves at all. A dangling
  // symlink under public/ is enough to cause it.
  const dir = mkdtempSync(join(tmpdir(), "buildid-"));
  writeFileSync(join(dir, "app.js"), "ok");
  symlinkSync(join(dir, "does-not-exist"), join(dir, "broken.js"));
  const id = buildId(dir);
  assert.match(id, /^[0-9a-f]{8}$/);
  // And the broken entry still counts: it appearing or vanishing is a real change.
  rmSync(join(dir, "broken.js"));
  assert.notEqual(buildId(dir), id);
  rmSync(dir, { recursive: true, force: true });
});
