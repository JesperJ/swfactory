// Starts Claude sessions for jobs queued on the dashboard.
//
//   FACTORY_URL=http://localhost:8088 FACTORY_RUNNER_TOKEN=... node scripts/runner.ts
//
// This process is the privileged part of the factory: it holds the user's git credentials and
// ~/.claude, and it starts real sessions. Everything it does is therefore pulled, never pushed
// — it polls the dashboard and nothing listens on the host. A job it receives names a project,
// a feature and one of three commands; the command line is rebuilt here from that enum, so no
// string from the dashboard is ever executed.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { loadProjects, normalizeRepo, type Project } from "../src/specs.ts";
import { JOB_COMMANDS, type IdleSession, type Job, type Session } from "../src/db.ts";
import { linkSession } from "../src/match.ts";

const run = promisify(execFile);

const BASE = (process.env.FACTORY_URL ?? "http://localhost:8088").replace(/\/+$/, "");
const TOKEN = process.env.FACTORY_RUNNER_TOKEN ?? "";
const REPO_ROOT = resolve(process.env.FACTORY_REPO_ROOT ?? join(homedir(), "code", "repos"));
const SPECS_DIR = resolve(process.env.SPECS_DIR ?? join(REPO_ROOT, "swfactory", "projects"));
const POLL_MS = Number(process.env.FACTORY_POLL_SECONDS ?? 10) * 1000;

// How long a session may sit at `your_turn` before the runner ends it. Deliberately not the
// same number as `NEXT_FINISHED_HOURS` (2), which only decides whether a row shows in Next:
// hiding a row and destroying a session are different acts. Tightening the display rule must
// never quietly become a more aggressive kill rule.
const SESSION_IDLE_HOURS = Number(process.env.FACTORY_SESSION_IDLE_HOURS ?? 8);

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

class JobError extends Error {}

// Where the runner keeps its worktrees. Never inside a repository: a tree in there would show
// up in `git status`, in the specs bind mount, and in every editor's file list.
const WORKTREE_ROOT = resolve(
  process.env.FACTORY_WORKTREE_ROOT ?? join(homedir(), ".cache", "factory", "worktrees"),
);

const safe = (s: string) => s.replace(/[^\w.-]/g, "-");

export interface WorktreePlan {
  dir: string;
  branch: string;
  /** Check out the commit, not the branch: a branch can live in only one worktree, and the
   *  default branch lives in the human's checkout. */
  detached?: boolean;
}

// Where a job's work belongs: one tree per feature, on that feature's branch. Per feature
// rather than per job, so a second build continues where an interrupted one stopped instead of
// throwing its uncommitted work away.
//
// Only `build` produces code that belongs on a feature branch. `spec`, `plan` and `review`
// produce specs and findings, which belong on the default branch's content — but they cannot
// *check out* the default branch: it is checked out in the human's own repo, and git allows a
// branch in one worktree only. Sending them to `main` made every non-build job fail with
// "'main' is already used by worktree at ...", which is three of the four commands.
//
// So they get a detached tree at the default branch's commit. Specs are written and committed
// in `$FACTORY_HOME` anyway — the shared checkout the dashboard reads — so this tree is only
// ever somewhere to stand and read the code from. Nothing commits to it.
export function worktreeFor(job: Job, root = WORKTREE_ROOT, defaultBranch = "main"): WorktreePlan {
  if (job.command !== "build" || !job.feature)
    return { dir: join(root, `${safe(job.project)}-base`), branch: defaultBranch, detached: true };
  return {
    dir: join(root, `${safe(job.project)}-${safe(job.feature)}`),
    branch: `feature/${safe(job.feature)}`,
  };
}

// The repository's default branch, without a network call: a runner that needs the network to
// start a job stops working when the network does.
export function defaultBranch(repoPath: string): string {
  const head = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const remote = head(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote.replace(/^origin\//, "");
  if (head(["rev-parse", "--verify", "--quiet", "main"])) return "main";
  return head(["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Returns the worktree a job should run in, creating it when it does not exist and adopting it
// when it does. Anything it cannot make sense of throws, because the alternative — falling back
// to the shared checkout — is exactly the bug this feature exists to remove.
export function ensureWorktree(repoPath: string, plan: WorktreePlan, base: string): string {
  if (existsSync(plan.dir)) {
    let onBranch: string;
    try {
      onBranch = git(plan.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      throw new JobError(`${plan.dir} exists but is not a git worktree; remove it or set FACTORY_WORKTREE_ROOT`);
    }
    // A detached tree reports HEAD rather than a branch name, and is refreshed to the current
    // base so a reused one is never reading last week's code.
    if (plan.detached) {
      if (onBranch !== "HEAD") throw new JobError(`worktree ${plan.dir} is on ${onBranch}, expected a detached checkout`);
      try {
        git(plan.dir, ["checkout", "--detach", "-f", base]);
      } catch {
        throw new JobError(`worktree ${plan.dir} could not be refreshed to ${base}`);
      }
      return plan.dir;
    }
    if (onBranch !== plan.branch)
      throw new JobError(`worktree ${plan.dir} is on ${onBranch}, expected ${plan.branch}`);
    return plan.dir;
  }

  mkdirSync(dirname(plan.dir), { recursive: true });
  const exists = (() => {
    try {
      git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`]);
      return true;
    } catch {
      return false;
    }
  })();
  // An existing branch is checked out; a new one is created from the base. git refuses either
  // way if the branch is already checked out somewhere, which is a failure worth surfacing.
  const args = plan.detached
    ? ["worktree", "add", "--detach", plan.dir, base]
    : exists
      ? ["worktree", "add", plan.dir, plan.branch]
      : ["worktree", "add", "-b", plan.branch, plan.dir, base];
  try {
    git(repoPath, args);
  } catch (err) {
    const why = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new JobError(`could not create worktree for ${plan.branch}: ${why}`);
  }
  return plan.dir;
}

// Removes a worktree only when it is finished with: its branch merged into base, nothing
// uncommitted in it, and git itself listing it as a worktree of this repository.
//
// Every guard here exists because this is the only code in the factory that deletes a directory
// outside the repository. It never passes --force: an interrupted build's unsaved work is worth
// more than a tidy cache, so a dirty tree is kept and simply tried again next time.
// How long a worktree is left alone regardless of how its branch looks. Covers the case the
// reflog check cannot: an empty branch whose reflog has expired, which then reads as merged
// while still being brand new. It also matches the situation the bug came from — someone just
// made that directory and is about to type in it.
const WORKTREE_GRACE_DEFAULT_MINUTES = 30;

// `Number("")` is 0 and `Number("30m")` is NaN, and `age < NaN` is false — so the plain
// `Number(process.env...)` this started as meant that a blank `Environment=` line in the unit
// file, or minutes written the way every other tool spells a duration, switched the grace guard
// off in complete silence. That is one typo away from the bug this feature exists to fix, on the
// only code in the factory that deletes a directory outside the repository, so it is worth the
// eight lines: anything that is not a positive, finite number of minutes is refused out loud and
// the default stands. `warn` is a parameter so the tests can read the complaint instead of
// printing it.
export function graceMinutes(
  raw: string | undefined,
  warn: (message: string) => void = console.error,
): number {
  if (raw === undefined) return WORKTREE_GRACE_DEFAULT_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    warn(
      `[runner] ignoring FACTORY_WORKTREE_GRACE_MINUTES=${JSON.stringify(raw)}: ` +
        `not a positive number of minutes, keeping ${WORKTREE_GRACE_DEFAULT_MINUTES}`,
    );
    return WORKTREE_GRACE_DEFAULT_MINUTES;
  }
  return minutes;
}

const WORKTREE_GRACE_MINUTES = graceMinutes(process.env.FACTORY_WORKTREE_GRACE_MINUTES);

// Minutes since the directory last changed. The plan said birth time falling back to mtime;
// building it showed that was both untestable and pointless. `utimes` cannot move a birth time,
// so the guard could never be exercised without waiting out the real clock — and a tree created
// a minute ago always has a fresh mtime anyway, so mtime alone already answers "was this made
// just now". What it answers better is the question actually being asked: when did anything last
// happen here. A tree created months ago but written to a minute ago should be kept, and mtime
// says so while a birth time does not.
export function worktreeAge(dir: string, now = new Date()): number {
  try {
    return (now.getTime() - statSync(dir).mtimeMs) / 60_000;
  } catch {
    return 0; // cannot tell how old it is, so treat it as new and leave it alone
  }
}

// Has anything ever been committed on this branch, as opposed to it merely existing?
//
// The plan proposed comparing the branch tip against the base tip. Building it showed that is
// not only insufficient but backwards: a fast-forward merge leaves the *used* branch sitting
// exactly at the base, while a fresh branch is left behind as the base moves on. The tip test
// would have kept finished trees and collected untouched ones — the opposite of the intent, and
// a quiet reintroduction of the bug 013 existed to fix.
//
// The reflog answers the real question. A branch created and never written to has one entry,
// "branch: Created from <base>"; a branch that was worked on has commit entries above it.
export function branchHasOwnCommits(repoPath: string, branch: string): boolean {
  let log: string;
  try {
    log = git(repoPath, ["reflog", "show", branch, "--format=%gs"]);
  } catch {
    return true; // no reflog to read: fall through to the merge check rather than keep forever
  }
  const lines = log.split("\n").filter((l) => l.trim() !== "");
  // Reflogs can be disabled or expired. Nothing to read is not evidence of nothing happening,
  // so defer to the checks below rather than keeping the tree for ever.
  if (lines.length === 0) return true;
  return lines.some((l) => !/^branch: Created from /.test(l));
}

export function pruneWorktree(repoPath: string, dir: string): "removed" | "kept" {
  let listed: string;
  try {
    listed = git(repoPath, ["worktree", "list", "--porcelain"]);
  } catch {
    return "kept";
  }
  // Only ever act on a path git reports. A path we merely computed is not evidence enough.
  if (!listed.split("\n").some((l) => l === `worktree ${dir}`)) return "kept";

  try {
    if (git(dir, ["status", "--porcelain"]) !== "") return "kept"; // uncommitted work
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const base = defaultBranch(repoPath);
    if (branch === base) return "kept"; // the base tree is not ours to remove
    // A detached tree reports "HEAD". It is the shared scratch space non-build jobs stand in,
    // belongs to no feature, and has no branch to be merged — so it is never collectable.
    if (branch === "HEAD") return "kept";
    // A branch holding no commit of its own has not landed — it has not started. Without this
    // the merge check below cannot tell the two apart: `--no-merged` prints nothing for a branch
    // whose work is merged *and* for a branch that was never written to, so a worktree created
    // seconds ago read as finished and was deleted about twenty seconds into its life.
    if (!branchHasOwnCommits(repoPath, branch)) return "kept";
    // Young enough that somebody is probably still using it.
    if (worktreeAge(dir) < WORKTREE_GRACE_MINUTES) return "kept";
    const unmerged = git(repoPath, ["branch", "--no-merged", base, "--list", branch]);
    if (unmerged !== "") return "kept"; // work not yet in the base branch
    git(repoPath, ["worktree", "remove", dir]);
    return "removed";
  } catch {
    return "kept";
  }
}

// Finds the checkout by git remote rather than by directory name: a renamed or wrong directory
// then fails closed instead of running a build somewhere unintended.
export function findCheckout(repoRoot: string, wantRepo: string): string {
  const want = normalizeRepo(wantRepo);
  if (!want) throw new JobError("the project has no usable repo: in project.md");
  if (!existsSync(repoRoot)) throw new JobError(`repo root ${repoRoot} does not exist`);

  const matches: string[] = [];
  for (const name of readdirSync(repoRoot)) {
    const dir = join(repoRoot, name);
    if (!existsSync(join(dir, ".git"))) continue;
    let origin: string;
    try {
      origin = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue; // no origin; not a candidate
    }
    if (normalizeRepo(origin) === want) matches.push(dir);
  }

  if (!matches.length) throw new JobError(`no checkout under ${repoRoot} has origin ${want}`);
  if (matches.length > 1) throw new JobError(`${matches.length} checkouts have origin ${want}: ${matches.join(", ")}`);
  return matches[0];
}

// `/factory build swfactory/005-start-session` — built here from the enum, never sent to us.
export function commandFor(job: Job): string {
  if (!(JOB_COMMANDS as readonly string[]).includes(job.command))
    throw new JobError(`refusing unknown command ${job.command}`);
  const target = job.feature ? `${job.project}/${job.feature}` : job.project;
  return `/factory ${job.command} ${target}`;
}

export function sessionName(job: Job): string {
  return `factory-${job.project}-${job.feature ?? job.command}`.replace(/[^\w.-]/g, "-");
}

async function report(id: number, status: "running" | "done" | "failed", error?: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/jobs/${id}/status`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status, error: error ?? null }),
    });
  } catch (err) {
    console.error(`[runner] could not report job ${id}:`, (err as Error).message);
  }
}

async function start(job: Job): Promise<void> {
  const projects = loadProjects(SPECS_DIR);
  const project = projects.find((p) => p.slug === job.project);
  if (!project) throw new JobError(`unknown project ${job.project} in ${SPECS_DIR}`);
  if (!project.repoUrl) throw new JobError(`project ${job.project} has no repo: in project.md`);

  const name = sessionName(job);
  // A feature already has a live session: its tmux name is taken and its worktree is in use.
  // Found by dogfooding — without this the job got as far as creating a worktree and then
  // failed on a raw tmux "duplicate session" error, leaving the tree behind with nothing in it.
  if (await tmuxSessionExists(name))
    throw new JobError(`a session for ${job.feature ?? job.project} is already running (tmux ${name}); attach to it or let it finish`);

  const repoPath = findCheckout(REPO_ROOT, project.repoUrl);
  // The shared checkout is what a worktree is made FROM, never what a session runs IN.
  // See decisions/2026-10-24-the-runner-never-touches-my-checkout.md — there is deliberately
  // no fallback here: a job that cannot get a clean tree fails rather than borrowing one.
  const base = defaultBranch(repoPath);
  const cwd = ensureWorktree(repoPath, worktreeFor(job, WORKTREE_ROOT, base), base);

  // Detached tmux, so a session that stops for a permission prompt is attachable rather than
  // stuck and invisible. Arguments are passed as an array; nothing goes through a shell.
  // FACTORY_HOME tells the session where the shared specs live. Code work happens in the
  // worktree; specs are the factory's shared state and are written and committed in the one
  // checkout the dashboard reads. Round 1 found specs written to an unmerged branch the
  // dashboard never sees, so it kept recommending work that had already been done.
  await run(
    "tmux",
    [
      "new-session", "-d", "-s", name,
      "-e", `FACTORY_HOME=${repoPath}`,
      // The hook reads this and sends it as X-Factory-Feature, which is how the dashboard links
      // a session to its feature. Branch name alone cannot: a non-build job runs in a detached
      // tree and reports no branch at all, so every spec, plan and review session showed up
      // unlinked. The runner knows the feature; it should say so rather than leave it inferred.
      "-e", `FACTORY_FEATURE=${job.feature ?? ""}`,
      "-c", cwd, "claude", commandFor(job),
    ],
    { timeout: 20_000 },
  );
  console.log(`[runner] job ${job.id}: ${commandFor(job)} in ${cwd} (tmux ${name})`);
}

// Does a tmux session by that name exist? `has-session` exits non-zero when it does not.
export async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await run("tmux", ["has-session", "-t", `=${name}`], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Nothing else ever closes a job: the session it started just ends. So each tick we ask the
// dashboard which jobs it believes are running and check whether their tmux sessions are still
// there. State lives on the dashboard rather than in this process, so a runner restart loses
// nothing and picks the work straight back up.
async function reconcile(): Promise<void> {
  let running: Job[] = [];
  try {
    const res = await fetch(`${BASE}/api/jobs/running`, { headers: auth });
    if (!res.ok) {
      // Never silent: a reconcile that quietly does nothing leaves jobs stuck at `running`
      // forever, which is the exact defect this function exists to prevent.
      console.error(`[runner] reconcile: dashboard returned ${res.status}`);
      return;
    }
    running = (await res.json()).jobs ?? [];
  } catch (err) {
    console.error("[runner] reconcile failed:", (err as Error).message);
    return;
  }
  for (const job of running) {
    if (await tmuxSessionExists(sessionName(job))) continue;
    console.log(`[runner] job ${job.id}: tmux session gone, marking done`);
    await report(job.id, "done");
  }
  sweepWorktrees();
  await endIdleSessions();
}

// A session that finished its turn and was never closed sits in tmux forever. Nothing ends one
// when its work ends — `/factory build` says "ready for review" and the session waits at a
// prompt. In one day that left four alive, the oldest since the previous evening, each holding
// a worktree and a window.
//
// Which sessions are candidates is decided here, away from tmux, because it is the part worth
// testing hardest: ending a session is destructive and unrecoverable.
//
// Round 1 found the guards were the wrong ones. They were cheap to check and did not carry the
// weight: the status was verified twice while the *age* — the only condition that makes a kill
// safe — was taken from the dashboard on faith, and the target was a tmux **name** rather than
// the session the row described. A name is many-to-one and a row is never retired, so a stale
// `your_turn` row became a standing kill order: tap Build on that feature a week later and the
// fresh, actively-working session died within a tick. The dry run in the spec had already shown
// three different rows resolving to one name; nobody read it as the defect it was.
//
// Round 2 found the replacement half-built. The identity check only refused a tmux session
// created *after* the row went idle, so anything older stayed reachable — and long-lived
// detached sessions are exactly what this feature exists to kill, which meant the attack and
// the feature shared a target class. Both reviewers reproduced it against the live 006 session:
// one hook POST rewriting `branch` keeps the old clock and acquires a new target, and the check
// passes because that session predates the row. The kill is now bound to `#{session_path}`
// instead, which a retargeting hook would also have to fake.
//
// So, in order:
//   - Only `your_turn`. A `needs_you` session is blocked on a person, which is the entire
//     reason tmux was chosen over headless.
//   - Only past the threshold, re-checked here. The dashboard filters too; a destructive act
//     must not rest on one component's filter being right.
//   - Only a session the runner could have named itself, and that said where it was running.
//   - Only a tmux session living in that same directory, and not newer than the row.
export function idleCandidates(
  sessions: IdleSession[],
  projects: Project[],
  hours: number,
  now = new Date(),
): { session: IdleSession; name: string }[] {
  const cutoff = now.getTime() - hours * 3600_000;
  const out: { session: IdleSession; name: string }[] = [];
  // Round 2 removed a `busy` set here that skipped a name another live row claimed. It could
  // never fire: `idleSessions` returns only `your_turn` rows and the set was built by skipping
  // `your_turn` rows, so it was empty on every tick. The test that covered it handed in a
  // `working` row by hand — input the endpoint cannot produce — so it passed while proving
  // nothing, and the task describing it was ticked.
  //
  // Round 3 correction: removing it was right, and the claim made for the removal was wrong.
  // The path bind does **not** cover the case it was reaching for — two claude sessions started
  // in one tmux session report the same directory, so comparing directories cannot tell them
  // apart. That gap is as old as the feature and is still open: a second session opened in a
  // finished session's tmux window can be killed along with it. It needs an identity the runner
  // wrote itself, which is a separate piece of work.
  for (const s of sessions) {
    if (s.status !== "your_turn") continue;
    const since = new Date(s.status_since ?? "").getTime();
    // An unparseable or future timestamp is not evidence of idleness.
    if (!Number.isFinite(since) || since > cutoff) continue;
    // A row that does not say where it was running cannot be matched to a session, and an
    // unmatched row must not authorise a kill.
    if (!s.cwd) continue;
    const { project, feature } = linkSession(s as Session, projects);
    if (!project || !feature) continue;
    out.push({ session: s, name: sessionName({ project, feature } as Job) });
  }
  return out;
}

// A skip that repeats unchanged every ten seconds is not an event. Round 2 measured 53,623 of
// the runner's 53,687 journal lines as one repeated "but attached" line about a single session,
// against three real kills. The reason is logged when it changes, and then not again.
const lastSkip = new Map<string, string>();
function logSkip(name: string, reason: string): void {
  if (lastSkip.get(name) === reason) return;
  lastSkip.set(name, reason);
  console.log(`[runner] ${reason}`);
}

async function endIdleSessions(): Promise<void> {
  let sessions: IdleSession[] = [];
  try {
    const res = await fetch(`${BASE}/api/sessions/idle?hours=${SESSION_IDLE_HOURS}`, { headers: auth });
    if (!res.ok) {
      console.error(`[runner] idle sessions: dashboard returned ${res.status}`);
      return;
    }
    sessions = ((await res.json()) as { sessions?: IdleSession[] }).sessions ?? [];
  } catch (err) {
    console.error("[runner] idle sessions failed:", (err as Error).message);
    return;
  }
  if (!sessions.length) return;

  const now = new Date();
  for (const { session, name } of idleCandidates(sessions, loadProjects(SPECS_DIR), SESSION_IDLE_HOURS, now)) {
    const info = await tmuxSession(name);
    if (!info) continue; // no session by that name, and nothing to say about it
    if (info.unreachable) {
      logSkip(name, `cannot reach tmux to ask about ${name} — ending nothing`);
      continue;
    }
    if (info.attached) {
      logSkip(name, `${name} (session ${session.id}) idle since ${session.status_since} but attached — leaving it alone`);
      continue;
    }
    // Where the row says it was running. Round 2 added this as "an identity the reporter does
    // not control"; round 3 established that it is nothing of the kind — `cwd` arrives in the
    // same POST as `branch`, from `payload.cwd`, with no validation. It stops a session that
    // is genuinely somewhere else, which is worth having, and it stops no attacker on its own.
    // What makes a redirected kill expensive is that retargeting now restarts the idle clock in
    // `Store.upsert`, so a rewritten row has to wait out the whole window again.
    if (!samePath(info.path, session.cwd)) {
      logSkip(
        name,
        `${name} lives in ${info.path}, but session ${session.id} reported ${session.cwd} — not the same session, leaving it alone`,
      );
      continue;
    }
    // And it still cannot be newer than the row that says it went idle. `NaN` refuses: round 2
    // found this was the one guard on the path that failed open on unparseable input.
    const createdAt = info.created.getTime();
    const idleAt = new Date(session.status_since ?? "").getTime();
    if (!Number.isFinite(createdAt) || !Number.isFinite(idleAt) || createdAt > idleAt) {
      logSkip(
        name,
        `${name} started ${info.created.toISOString()}, after session ${session.id} went idle at ${session.status_since} — not the same session, leaving it alone`,
      );
      continue;
    }
    try {
      await run("tmux", ["kill-session", "-t", `=${name}`], { timeout: 10_000 });
      lastSkip.delete(name);
      console.log(
        `[runner] ended ${name} (session ${session.id}): your_turn since ${session.status_since}, over ${SESSION_IDLE_HOURS}h, in ${info.path}, nothing pending`,
      );
    } catch (err) {
      console.error(`[runner] could not end ${name} (session ${session.id}):`, (err as Error).message);
    }
  }
}

// Two paths are the same session's home if they name the same place. `normalize`, not
// `resolve`: round 3 measured `samePath("/home/jesper/code/repos/swfactory", ".")` returning
// true, because `resolve` completes a relative path against the *runner's* working directory —
// so a reporter could match the shared checkout by sending `cwd: "."`, without knowing any path
// at all. That is arithmetic, not identity.
//
// Both sides must be absolute. Symlinks are deliberately not followed, because the comparison
// must not depend on a filesystem the reporter could arrange.
export function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (!isAbsolute(a) || !isAbsolute(b)) return false;
  // Trailing slashes and `.`/`..` segments are spelling, not a different directory.
  const tidy = (p: string) => normalize(p).replace(/\/+$/, "");
  return tidy(a) === tidy(b);
}

export interface TmuxSession {
  attached: boolean;
  created: Date;
  path: string | null;
  /** tmux could not be asked at all — every guard must refuse rather than proceed. */
  unreachable: boolean;
}

// Parsing kept separate from running tmux so it can be tested, which round 2 pointed out this
// function was not: it owns the format string and the catch-all, on the path that ends
// processes, and had no test of any kind.
//
// The path is last in the format and taken as the whole remainder, because a directory may
// contain spaces while the two numeric fields may not.
export function parseTmuxSession(stdout: string): TmuxSession | null {
  const line = stdout.trim();
  if (!line) return null; // no session by that name
  const m = line.match(/^(\d+)\s+(\d+)\s*(.*)$/);
  // Output we cannot read is not evidence of anything. Refuse, as if tmux were unreachable.
  if (!m) return { attached: true, created: new Date(8640000000000000), path: null, unreachable: true };
  return {
    attached: m[1] !== "0",
    created: new Date(Number(m[2]) * 1000),
    path: m[3] || null,
    unreachable: false,
  };
}

// What tmux knows about a session, or null if there is none by that name. One call rather than
// three: round 1 pointed out that existence, attachment and the kill were separate invocations,
// so attaching in the gap between them got your terminal killed — the exact scenario the attach
// guard exists to prevent. One gap remains, before the kill itself.
export async function tmuxSession(name: string): Promise<TmuxSession | null> {
  try {
    const out = await run(
      "tmux",
      ["list-sessions", "-F", "#{session_attached} #{session_created} #{session_path}", "-f", `#{==:#{session_name},${name}}`],
      { timeout: 10_000 },
    );
    return parseTmuxSession(out.stdout);
  } catch {
    // tmux exits 1 when there is no server at all, which is not the same as "no such session".
    // Round 2 found this logged "but attached" about sessions that did not exist — safe, but a
    // falsehood on the path whose criterion is that the log says why.
    return { attached: true, created: new Date(8640000000000000), path: null, unreachable: true };
  }
}

// Round 1 found cleanup firing only in the tick a session ended — always *before* a human
// merges the branch, so nothing was ever mergeable yet and worktrees accumulated forever.
// It now runs every tick over every worktree git lists, so a tree becomes collectable the
// moment its branch lands rather than at the one instant it could never be.
export function sweepWorktrees(root = WORKTREE_ROOT): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!existsSync(join(dir, ".git"))) continue;
    try {
      // The worktree knows its own repository, so cleanup needs no job and no project lookup.
      const repoPath = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).replace(/\/\.git\/?$/, "");
      if (pruneWorktree(repoPath, dir) === "removed") console.log(`[runner] removed worktree ${dir}`);
    } catch {
      // A tree we cannot reason about is left alone, which is the safe direction.
    }
  }
}

async function tick(): Promise<void> {
  await reconcile();

  let job: Job | null = null;
  try {
    const res = await fetch(`${BASE}/api/jobs/next`, { headers: auth });
    if (res.status === 401) throw new Error("FACTORY_RUNNER_TOKEN rejected");
    if (!res.ok) throw new Error(`dashboard returned ${res.status}`);
    job = (await res.json()).job;
  } catch (err) {
    // The dashboard being down is normal and temporary; say so once per tick and keep polling.
    console.error("[runner] poll failed:", (err as Error).message);
    return;
  }
  if (!job) return;

  try {
    await start(job);
    await report(job.id, "running");
  } catch (err) {
    const why = err instanceof JobError ? err.message : `could not start: ${(err as Error).message}`;
    console.error(`[runner] job ${job.id} failed: ${why}`);
    await report(job.id, "failed", why);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (!TOKEN) {
    console.error("FACTORY_RUNNER_TOKEN is not set.");
    process.exit(1);
  }
  console.log(`[runner] watching ${BASE}, repos under ${REPO_ROOT}, specs ${SPECS_DIR}`);
  await tick();
  setInterval(() => void tick(), POLL_MS);
}
