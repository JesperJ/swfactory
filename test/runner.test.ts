import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFor, defaultBranch, ensureWorktree, findCheckout, pruneWorktree, sessionName, sweepWorktrees, worktreeFor } from "../scripts/runner.ts";
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

// --- worktrees ---------------------------------------------------------------
// Real repositories, not mocks: git's own rules about which branch may be checked out where
// are the thing under test, and a mock would simply agree with whatever I assumed.

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-repo-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x");
  g("add", "README.md");
  g("commit", "-qm", "init");
  return dir;
}

const wtRoot = () => mkdtempSync(join(tmpdir(), "factory-wt-"));
const branchOf = (dir: string) =>
  execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

test("a job's worktree is named for its feature and sits outside the repo", () => {
  const plan = worktreeFor(job(), "/wt", "main");
  assert.equal(plan.dir, "/wt/swfactory-005-start-session");
  assert.equal(plan.branch, "feature/005-start-session");
});

test("a job with no feature gets the default branch, not a feature branch", () => {
  const plan = worktreeFor(job({ feature: null }), "/wt", "trunk");
  assert.equal(plan.branch, "trunk");
  assert.equal(plan.dir, "/wt/swfactory-base");
});

test("two features get separate trees on separate branches, and neither is the checkout", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const a = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const b = ensureWorktree(repo, worktreeFor(job({ feature: "002-b" }), root, base), base);

  assert.notEqual(a, b);
  assert.notEqual(a, repo, "a job must never run in the shared checkout");
  assert.equal(branchOf(a), "feature/001-a");
  assert.equal(branchOf(b), "feature/002-b");
  assert.equal(branchOf(repo), base, "the checkout stays on the branch it was on");
});

test("uncommitted work in the checkout is neither seen nor disturbed", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  writeFileSync(join(repo, "mine.txt"), "work in progress");
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);

  assert.equal(existsSync(join(wt, "mine.txt")), false, "the worktree must not see it");
  assert.equal(readFileSync(join(repo, "mine.txt"), "utf8"), "work in progress");
});

test("a second job for the same feature reuses the tree, keeping its uncommitted work", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const plan = worktreeFor(job({ feature: "001-a" }), root, base);
  const first = ensureWorktree(repo, plan, base);
  writeFileSync(join(first, "half-done.txt"), "interrupted");

  const second = ensureWorktree(repo, plan, base);
  assert.equal(second, first);
  assert.equal(readFileSync(join(second, "half-done.txt"), "utf8"), "interrupted");
});

test("a branch already checked out elsewhere fails the job instead of borrowing a tree", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  // Same branch, different directory: git refuses, and so must we.
  const clash = { dir: join(root, "somewhere-else"), branch: "feature/001-a" };
  assert.throws(() => ensureWorktree(repo, clash, base), /could not create worktree/);
});

test("a directory that is not a worktree fails rather than being used", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const dir = join(root, "not-a-worktree");
  mkdirSync(dir, { recursive: true });
  assert.throws(() => ensureWorktree(repo, { dir, branch: "feature/001-a" }, "main"), /not a git worktree/);
});

test("commits made in a worktree are visible from the main repo", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const g = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "from the worktree");

  const log = execFileSync("git", ["-C", repo, "log", "--oneline", "feature/001-a"], { encoding: "utf8" });
  assert.match(log, /from the worktree/, "the object store is shared, so no extra step is needed");
});

test("defaultBranch finds the branch without a network call", () => {
  const repo = repoWithCommit();
  assert.equal(defaultBranch(repo), "main");
});

test("cleanup keeps a worktree with uncommitted work", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  writeFileSync(join(wt, "unsaved.txt"), "do not delete this");

  assert.equal(pruneWorktree(repo, wt), "kept");
  assert.equal(existsSync(wt), true);
});

test("cleanup keeps a worktree whose branch is not merged", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const g = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "work not yet merged");

  assert.equal(pruneWorktree(repo, wt), "kept", "unmerged work must survive");
  assert.equal(existsSync(wt), true);
});

test("cleanup removes a clean, merged worktree", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const g = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "finished");
  execFileSync("git", ["-C", repo, "merge", "-q", "feature/001-a"], { stdio: "ignore" });

  assert.equal(pruneWorktree(repo, wt), "removed");
  assert.equal(existsSync(wt), false);
});

test("cleanup refuses a path git does not list as a worktree", () => {
  const repo = repoWithCommit();
  const stray = mkdtempSync(join(tmpdir(), "factory-stray-"));
  writeFileSync(join(stray, "someone-elses-file.txt"), "important");

  assert.equal(pruneWorktree(repo, stray), "kept");
  assert.equal(existsSync(stray), true, "a computed path is not evidence enough to delete");
});

test("only a build gets a feature branch; spec, plan and review stay on the default", () => {
  // Round 1: all four commands landed on a feature branch, which the What table never said.
  for (const command of ["spec", "plan", "review"] as const) {
    const plan = worktreeFor(job({ command, feature: "001-a" }), "/wt", "main");
    assert.equal(plan.branch, "main", `${command} must not take a feature branch`);
    assert.equal(plan.dir, "/wt/swfactory-base");
  }
  const build = worktreeFor(job({ command: "build", feature: "001-a" }), "/wt", "main");
  assert.equal(build.branch, "feature/001-a");
});

test("the sweep collects a merged worktree without needing the job that made it", () => {
  // Round 1: cleanup only ran in the tick a session ended — always before a human merges, so
  // nothing was ever collectable. The sweep runs every tick instead.
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ command: "build", feature: "001-a" }), root, base), base);
  const g = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "finished");

  sweepWorktrees(root);
  assert.equal(existsSync(wt), true, "not merged yet, so it stays");

  execFileSync("git", ["-C", repo, "merge", "-q", "feature/001-a"], { stdio: "ignore" });
  sweepWorktrees(root);
  assert.equal(existsSync(wt), false, "merged, so the next sweep collects it");
});

test("the sweep leaves alone anything that is not a worktree", () => {
  const root = wtRoot();
  const stray = join(root, "just-a-directory");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "keep.txt"), "x");
  sweepWorktrees(root);
  assert.equal(existsSync(stray), true);
});
