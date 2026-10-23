import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFor, findCheckout, sessionName } from "../scripts/runner.ts";
import type { Job } from "../src/db.ts";

function job(over: Partial<Job> = {}): Job {
  return {
    id: 1,
    project: "swfactory",
    feature: "005-start-session",
    command: "build",
    status: "claimed",
    error: null,
    session_id: null,
    created_at: "2026-10-23T10:00:00.000Z",
    claimed_at: null,
    finished_at: null,
    ...over,
  };
}

// A throwaway repo root with real git checkouts, so the remote matching is exercised for real.
function repoRoot(remotes: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-repos-"));
  for (const [name, origin] of Object.entries(remotes)) {
    const dir = join(root, name);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin], { stdio: "ignore" });
  }
  mkdirSync(join(root, "not-a-repo"));
  writeFileSync(join(root, "loose-file.txt"), "");
  return root;
}

test("the checkout is found by git remote, not by directory name", () => {
  const root = repoRoot({ "some-other-name": "git@github.com:JesperJ/swfactory.git", decoy: null });
  const found = findCheckout(root, "https://github.com/JesperJ/swfactory");
  assert.equal(found, join(root, "some-other-name"));
});

test("a directory named like the project but pointing elsewhere is not used", () => {
  // The failure that matters: running a build in the wrong repo because the name looked right.
  const root = repoRoot({ swfactory: "git@github.com:someone-else/swfactory.git" });
  assert.throws(() => findCheckout(root, "https://github.com/JesperJ/swfactory"), /no checkout under .* has origin/);
});

test("two checkouts of the same repo are refused rather than guessed between", () => {
  const root = repoRoot({
    swfactory: "git@github.com:JesperJ/swfactory.git",
    "swfactory-copy": "https://github.com/JesperJ/swfactory.git",
  });
  assert.throws(() => findCheckout(root, "github.com/jesperj/swfactory"), /2 checkouts have origin/);
});

test("a missing repo root or an unusable repo url fails with a reason", () => {
  assert.throws(() => findCheckout("/does/not/exist", "github.com/a/b"), /does not exist/);
  assert.throws(() => findCheckout(repoRoot({}), ""), /no usable repo/);
});

test("the command line is rebuilt from the enum", () => {
  assert.equal(commandFor(job()), "/factory build swfactory/005-start-session");
  assert.equal(commandFor(job({ command: "plan" })), "/factory plan swfactory/005-start-session");
  assert.equal(commandFor(job({ feature: null, command: "spec" })), "/factory spec swfactory");
});

test("a command outside the allowed set is refused even if it reaches the runner", () => {
  // Defence in depth: the API validates too, but the runner must never trust what it is handed.
  for (const command of ["approve", "build; rm -rf /", "../../etc/passwd"]) {
    assert.throws(() => commandFor(job({ command: command as never })), /refusing unknown command/);
  }
});

test("tmux session names are safe to use as identifiers", () => {
  assert.equal(sessionName(job()), "factory-swfactory-005-start-session");
  assert.equal(sessionName(job({ project: "a b/c", feature: "x:y" })), "factory-a-b-c-x-y");
});
