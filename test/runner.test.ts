import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchHasOwnCommits, commandFor, defaultBranch, ensureWorktree, findCheckout, idleCandidates, parseTmuxSession, pruneWorktree, samePath, sessionName, sweepWorktrees, worktreeAge, worktreeFor } from "../scripts/runner.ts";
import type { IdleSession, Job } from "../src/db.ts";
import type { Feature, Project } from "../src/specs.ts";

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

// Ages a worktree past the grace period. The tests that assert collection all create a tree
// seconds before checking it, which is precisely what the grace period is there to protect, so
// they have to say out loud that the tree is old.
function backdate(dir: string, minutes = 60) {
  const when = new Date(Date.now() - minutes * 60_000);
  utimesSync(dir, when, when);
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

  backdate(wt);
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

  backdate(wt);
  sweepWorktrees(root);
  assert.equal(existsSync(wt), true, "not merged yet, so it stays");

  execFileSync("git", ["-C", repo, "merge", "-q", "feature/001-a"], { stdio: "ignore" });
  backdate(wt);
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

test("a non-build job gets a detached tree, because the default branch is already checked out", () => {
  // The 013 rework sent spec/plan/review to the default branch. git allows a branch in one
  // worktree only, and the human's checkout has it — so every non-build job failed with
  // "'main' is already used by worktree at ...". Three of the four commands, broken by a fix.
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  for (const command of ["spec", "plan", "review"] as const) {
    const plan = worktreeFor(job({ command, feature: "001-a" }), root, base);
    assert.equal(plan.detached, true, `${command} must not try to check out ${base}`);
    const dir = ensureWorktree(repo, plan, base);
    assert.equal(
      execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
      "HEAD",
      "a detached tree reports HEAD, not a branch",
    );
    // The human's checkout keeps the branch.
    assert.equal(branchOf(repo), base);
  }
});

test("a build still takes the feature branch, not a detached tree", () => {
  const plan = worktreeFor(job({ command: "build", feature: "001-a" }), "/wt", "main");
  assert.equal(plan.branch, "feature/001-a");
  assert.ok(!plan.detached);
});

test("the sweep never collects the detached base tree", () => {
  // It belongs to no feature and has no branch to merge, so "merged" is meaningless for it.
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const dir = ensureWorktree(repo, worktreeFor(job({ command: "spec", feature: null }), root, base), base);
  sweepWorktrees(root);
  assert.equal(existsSync(dir), true, "the shared base tree must survive every sweep");
});

// --- which idle sessions may be ended -----------------------------------------------------
//
// Ending a session destroys work in progress and cannot be undone, so the guards are tested
// before anything else about this path.

const idleFeatures: Feature[] = [
  { id: "006", slug: "006-ntfy", title: "ntfy", status: "done", priority: null, summary: null, blocked: null, lastLog: null, file: "006-ntfy.md" },
  { id: "015", slug: "015-finished-sessions", title: "x", status: "building", priority: null, summary: null, blocked: null, lastLog: null, file: "015.md" },
];
const idleProjects: Project[] = [
  { slug: "swfactory", name: "swfactory", status: "active", summary: null, repo: "github.com/jesper/swfactory", repoUrl: null, features: idleFeatures, file: "" },
];

const IDLE_NOW = new Date("2026-10-24T14:00:00.000Z");
const IDLE_HOURS = 8;
const hoursBefore = (h: number) => new Date(IDLE_NOW.getTime() - h * 3600_000).toISOString();

function session(over: Partial<IdleSession> = {}): IdleSession {
  return {
    id: "s1",
    status: "your_turn",
    status_since: hoursBefore(20),
    cwd: "/home/me/code/repos/swfactory",
    repo: "github.com/jesper/swfactory",
    branch: "feature/015-finished-sessions",
    feature_hint: null,
    ...over,
  };
}

const candidates = (ss: IdleSession[]) => idleCandidates(ss, idleProjects, IDLE_HOURS, IDLE_NOW);

test("an idle your_turn session is a candidate, named the way the runner names its own", () => {
  const out = candidates([session()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "factory-swfactory-015-finished-sessions");
});

test("a needs_you session is never a candidate, however long it has waited", () => {
  // The endpoint filters these out too. This is the second lock on the same door: a
  // destructive act must not depend on one component's filter being right.
  assert.deepEqual(candidates([session({ status: "needs_you" })]), []);
  assert.deepEqual(candidates([session({ status: "working" })]), []);
  assert.deepEqual(candidates([session({ status: "ended" })]), []);
});

test("the age is re-checked here, not taken from the dashboard", () => {
  // Round 1: the cheap guard was doubled and the load-bearing one was taken on faith. A
  // compromised or simply buggy dashboard returning a session that stopped one second ago
  // would have had the runner kill every live factory session on the next tick.
  assert.deepEqual(candidates([session({ status_since: hoursBefore(1) })]), []);
  assert.deepEqual(candidates([session({ status_since: hoursBefore(7.9) })]), []);
  assert.equal(candidates([session({ status_since: hoursBefore(8.1) })]).length, 1);
  // Garbage and futures are not evidence of idleness.
  assert.deepEqual(candidates([session({ status_since: "not a date" })]), []);
  assert.deepEqual(candidates([session({ status_since: hoursBefore(-5) })]), []);
});

test("a session the runner could not have named is left alone", () => {
  // No project: nothing ties it to this factory at all.
  assert.deepEqual(candidates([session({ repo: null, cwd: "/tmp/elsewhere" })]), []);
  // A project but no feature — a session started by hand in the repo, as happened for real.
  // There is no tmux name to act on, and guessing one risks killing something else.
  assert.deepEqual(candidates([session({ branch: "main" })]), []);
});

test("a row that does not say where it ran cannot authorise a kill", () => {
  // The kill is bound to the session's directory, so a row with no cwd has nothing to bind to.
  assert.deepEqual(candidates([session({ cwd: null })]), []);
});

test("a done feature's session is still a candidate — done is what makes it endable", () => {
  // The 006 session alive since the previous evening is exactly the case this exists for.
  const out = candidates([session({ branch: "feature/006-ntfy" })]);
  assert.equal(out[0]?.name, "factory-swfactory-006-ntfy");
});

// --- the identity bind ---------------------------------------------------------------------
//
// Round 2: comparing only creation time refused sessions *newer* than the row and let every
// older one through — and long-lived detached sessions are what this feature targets, so the
// attack and the feature shared a target class. Both reviewers reproduced a retarget against
// the real 006 session: one hook POST rewriting `branch` keeps the old clock, and the check
// passed because that session predated the row.

test("a tmux session living somewhere else is not the session that went idle", () => {
  assert.equal(samePath("/home/me/code/repos/swfactory", "/home/me/code/repos/swfactory"), true);
  // Same place, spelled differently, is still the same place.
  assert.equal(samePath("/home/me/code/repos/swfactory/", "/home/me/code/repos/swfactory"), true);
  assert.equal(samePath("/home/me/code/repos/./swfactory", "/home/me/code/repos/swfactory"), true);
  // The retarget: the attacker's row claims a feature branch, but reports its own cwd.
  assert.equal(samePath("/home/jesper/.cache/factory/worktrees/swfactory-006", "/home/me/elsewhere"), false);
  // Nothing to compare is never a match. A missing path must not read as agreement.
  assert.equal(samePath(null, "/x"), false);
  assert.equal(samePath("/x", null), false);
  assert.equal(samePath(null, null), false);
});

test("tmux output is parsed, and anything unreadable refuses rather than proceeds", () => {
  const ok = parseTmuxSession("0 1761250901 /home/me/code/repos/swfactory\n");
  assert.equal(ok?.attached, false);
  assert.equal(ok?.created.toISOString(), new Date(1761250901_000).toISOString());
  assert.equal(ok?.path, "/home/me/code/repos/swfactory");
  assert.equal(ok?.unreachable, false);

  assert.equal(parseTmuxSession("1 1761250901 /x")?.attached, true);
  // A directory may contain spaces; the two numeric fields may not, so the path is the rest.
  assert.equal(parseTmuxSession("0 1761250901 /home/me/my code/repo")?.path, "/home/me/my code/repo");
  // No session by that name.
  assert.equal(parseTmuxSession("   "), null);
  // Output we cannot read is not evidence of anything: refuse, as if tmux were unreachable.
  const junk = parseTmuxSession("something unexpected");
  assert.equal(junk?.unreachable, true);
  assert.equal(junk?.attached, true, "an unreadable answer must not be read as detached");
  assert.equal(junk?.path, null, "and must not match any cwd");
});

// --- the sweep must not eat a worktree nobody has used yet -----------------------------------
//
// `git worktree add -b feature/x <dir> main` and the directory was gone about twenty seconds
// later. Not a race: `git branch --no-merged main --list <branch>` prints nothing both for a
// branch whose work has landed and for a branch that was never written to, so a tree created
// seconds ago read as finished.

test("a worktree on a branch with no commits of its own is never collected", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "016-new" }), root, base), base);

  // The reported bug, exactly: old enough that the grace period has expired, and still kept.
  backdate(wt, 60 * 24);
  assert.equal(branchHasOwnCommits(repo, "feature/016-new"), false);
  assert.equal(pruneWorktree(repo, wt), "kept", "nothing was ever committed here");
  assert.equal(existsSync(wt), true);

  // And it survives the base moving on underneath it, which is what made the tip of the branch
  // an unreliable signal in the first place.
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "later work"], { stdio: "ignore" });
  backdate(wt, 60 * 24);
  sweepWorktrees(root);
  assert.equal(existsSync(wt), true, "the base moved; the empty tree is still not finished work");
});

test("a worktree younger than the grace period is left alone however its branch looks", () => {
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const g = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "finished");
  execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "-m", "merge", "feature/001-a"], { stdio: "ignore" });

  // Merged, so collectable on every other count — but someone was in it a moment ago.
  assert.equal(pruneWorktree(repo, wt), "kept", "too young to collect");
  backdate(wt);
  assert.equal(pruneWorktree(repo, wt), "removed", "past the grace period, the work has landed");
});

test("a fast-forward merge still leaves a collectable tree", () => {
  // The case that killed the first fix: after a fast-forward the *used* branch sits exactly at
  // the base while a fresh branch does not, so comparing tips got both answers backwards.
  const repo = repoWithCommit();
  const root = wtRoot();
  const base = defaultBranch(repo);
  const wt = ensureWorktree(repo, worktreeFor(job({ feature: "001-a" }), root, base), base);
  const g = (...a: string[]) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  writeFileSync(join(wt, "done.txt"), "x");
  g("add", "done.txt");
  g("commit", "-qm", "finished");
  execFileSync("git", ["-C", repo, "merge", "-q", "feature/001-a"], { stdio: "ignore" }); // fast-forward

  assert.equal(branchHasOwnCommits(repo, "feature/001-a"), true, "it was committed to, ff or not");
  backdate(wt);
  assert.equal(pruneWorktree(repo, wt), "removed");
});

test("worktree age is measured from the last time anything happened there", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-age-"));
  assert.ok(worktreeAge(dir) < 1, "a directory just made is new");
  backdate(dir, 90);
  assert.ok(Math.abs(worktreeAge(dir) - 90) < 1, "and an hour and a half old after backdating");
  // A path that is not there cannot be judged old, so it is treated as new and left alone.
  assert.equal(worktreeAge(join(dir, "nope")), 0);
});
