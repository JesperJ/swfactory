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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadProjects, normalizeRepo } from "../src/specs.ts";
import { JOB_COMMANDS, type Job } from "../src/db.ts";

const run = promisify(execFile);

const BASE = (process.env.FACTORY_URL ?? "http://localhost:8088").replace(/\/+$/, "");
const TOKEN = process.env.FACTORY_RUNNER_TOKEN ?? "";
const REPO_ROOT = resolve(process.env.FACTORY_REPO_ROOT ?? join(homedir(), "code", "repos"));
const SPECS_DIR = resolve(process.env.SPECS_DIR ?? join(REPO_ROOT, "swfactory", "projects"));
const POLL_MS = Number(process.env.FACTORY_POLL_SECONDS ?? 10) * 1000;

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

class JobError extends Error {}

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

  const cwd = findCheckout(REPO_ROOT, project.repoUrl);
  const name = sessionName(job);

  // Detached tmux, so a session that stops for a permission prompt is attachable rather than
  // stuck and invisible. Arguments are passed as an array; nothing goes through a shell.
  await run("tmux", ["new-session", "-d", "-s", name, "-c", cwd, "claude", commandFor(job)], {
    timeout: 20_000,
  });
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
