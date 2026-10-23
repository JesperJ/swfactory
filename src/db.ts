// Session state reported by Claude Code hooks, stored in SQLite.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// working:    you sent a prompt, Claude is on it
// your_turn:  Claude finished its turn (Stop hook)
// needs_you:  Claude is blocked on a permission or question (Notification hook)
// ended:      the session closed
export type SessionStatus = "working" | "your_turn" | "needs_you" | "ended";

export interface Session {
  id: string;
  status: SessionStatus;
  status_since: string; // when it last *changed* status — idle nudges don't move this
  url: string | null;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  host: string | null;
  feature_hint: string | null;
  prompt: string | null;
  message: string | null;
  last_event: string;
  started_at: string;
  updated_at: string;
  dismissed: number;
}

export interface SessionUpdate {
  id: string;
  event: string;
  status?: SessionStatus;
  url?: string | null;
  cwd?: string | null;
  repo?: string | null;
  branch?: string | null;
  host?: string | null;
  featureHint?: string | null;
  prompt?: string | null;
  message?: string | null;
}

// What a job may ask for. The runner rebuilds the command from this, so a job never carries a
// shell string, a path, or anything else free-form. Adding to this list widens what a
// compromised dashboard can cause to run on the host, so it is deliberately short.
export const JOB_COMMANDS = ["plan", "build", "spec", "review"] as const;
export type JobCommand = (typeof JOB_COMMANDS)[number];

// queued -> claimed -> running -> done | failed
export type JobStatus = "queued" | "claimed" | "running" | "failed" | "done";
const UNFINISHED: JobStatus[] = ["queued", "claimed", "running"];

// A job that has not reached a terminal state in this long has lost its runner — it was never
// claimed, or the session died without reporting. Round 2 found that an unfinished job blocked
// every future tap for its feature forever, turning "two taps don't start two sessions" into
// "no tap ever starts one again". Past this age a job stops blocking and the UI offers the
// action again. This is the backstop; the runner reconciling against tmux is the real fix, and
// neither covers the other's failure.
export const STALE_JOB_HOURS = 6;

export interface Job {
  id: number;
  project: string;
  feature: string | null;
  command: JobCommand;
  status: JobStatus;
  error: string | null;
  session_id: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}

export function isJobCommand(v: unknown): v is JobCommand {
  return typeof v === "string" && (JOB_COMMANDS as readonly string[]).includes(v);
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        url TEXT, cwd TEXT, repo TEXT, branch TEXT, host TEXT, feature_hint TEXT,
        prompt TEXT, message TEXT,
        last_event TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        feature TEXT,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
    `);
    // Added later; older databases backfill from updated_at.
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "status_since")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN status_since TEXT");
      this.db.exec("UPDATE sessions SET status_since = updated_at WHERE status_since IS NULL");
    }
  }

  // Merges an update into the session row. Fields left undefined keep their stored value;
  // a new prompt clears the previous turn's message.
  //
  // Returns the merged row and whether the status actually changed, because that distinction is
  // computed here and nowhere else — the notifier needs it to tell a real event from a repeated
  // idle nudge.
  upsert(u: SessionUpdate, now = new Date().toISOString()): { session: Session; statusChanged: boolean } {
    const existing = this.get(u.id);
    const pick = <T>(next: T | undefined, prev: T | null | undefined): T | null =>
      next !== undefined && next !== null && next !== "" ? next : (prev ?? null);
    const status = u.status ?? existing?.status ?? "your_turn";
    // Claude Code repeats idle notifications while a session waits. Those restate the same
    // status rather than reporting anything new, so they must not revive a dismissed session
    // or reset the clock that ages it out of the inbox. Only a real change does that.
    const changed = !existing || existing.status !== status;
    const row = {
      id: u.id,
      status,
      status_since: changed ? now : existing.status_since,
      url: pick(u.url, existing?.url),
      cwd: pick(u.cwd, existing?.cwd),
      repo: pick(u.repo, existing?.repo),
      branch: pick(u.branch, existing?.branch),
      host: pick(u.host, existing?.host),
      feature_hint: pick(u.featureHint, existing?.feature_hint),
      prompt: pick(u.prompt, existing?.prompt),
      message: u.prompt ? null : pick(u.message, existing?.message),
      last_event: u.event,
      started_at: existing?.started_at ?? now,
      updated_at: now,
      // A real status change brings a dismissed session back; a repeated nudge does not.
      dismissed: changed ? 0 : (existing?.dismissed ?? 0),
      // `satisfies`, not an annotation: the statement below needs the inferred object type to
      // bind it as SQL parameters.
    } satisfies Session;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
         (id, status, status_since, url, cwd, repo, branch, host, feature_hint, prompt, message, last_event, started_at, updated_at, dismissed)
         VALUES (:id, :status, :status_since, :url, :cwd, :repo, :branch, :host, :feature_hint, :prompt, :message, :last_event, :started_at, :updated_at, :dismissed)`,
      )
      .run(row);
    return { session: row, statusChanged: changed };
  }

  get(id: string): Session | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
  }

  // Everything not dismissed, plus anything touched in the last `days`.
  list(days = 14): Session[] {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db
      .prepare("SELECT * FROM sessions WHERE dismissed = 0 AND updated_at >= ? ORDER BY updated_at DESC")
      .all(since) as unknown as Session[];
  }

  dismiss(id: string): boolean {
    return this.db.prepare("UPDATE sessions SET dismissed = 1 WHERE id = ?").run(id).changes > 0;
  }

  // --- jobs ------------------------------------------------------------------

  // Returns the existing job instead of a new one when this feature already has unfinished
  // work queued. The guard lives here rather than in the UI because the UI is the thing that
  // gets tapped twice on a slow connection.
  enqueue(job: { project: string; feature: string | null; command: JobCommand }, now = new Date().toISOString()): { job: Job; created: boolean } {
    const fresh = new Date(new Date(now).getTime() - STALE_JOB_HOURS * 3600_000).toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM jobs WHERE project = ? AND feature IS ? AND status IN (${UNFINISHED.map(() => "?").join(",")})
         AND created_at >= ? ORDER BY created_at LIMIT 1`,
      )
      .get(job.project, job.feature, ...UNFINISHED, fresh) as Job | undefined;
    if (existing) return { job: existing, created: false };

    const id = this.db
      .prepare("INSERT INTO jobs (project, feature, command, status, created_at) VALUES (?, ?, ?, 'queued', ?)")
      .run(job.project, job.feature, job.command, now).lastInsertRowid;
    return { job: this.job(Number(id))!, created: true };
  }

  // Compare-and-swap, so two runners can never claim the same job.
  claimNext(now = new Date().toISOString()): Job | undefined {
    const next = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      .get() as Job | undefined;
    if (!next) return undefined;
    const claimed = this.db
      .prepare("UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'queued'")
      .run(now, next.id).changes;
    return claimed ? this.job(next.id) : undefined;
  }

  // `running` is not terminal, so it leaves finished_at alone and keeps blocking duplicates.
  setJobStatus(
    id: number,
    status: JobStatus,
    extra: { error?: string | null; sessionId?: string | null } = {},
    now = new Date().toISOString(),
  ): Job | undefined {
    const terminal = status === "done" || status === "failed";
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, error = COALESCE(?, error), session_id = COALESCE(?, session_id),
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      )
      .run(status, extra.error ?? null, extra.sessionId ?? null, terminal ? 1 : 0, now, id);
    return this.job(id);
  }

  job(id: number): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
  }

  // Jobs the runner believes it started. It reconciles these against tmux each tick, because
  // nothing else ever tells a job it finished: the session ends without reporting back.
  listRunning(): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY claimed_at")
      .all() as unknown as Job[];
  }

  // Everything unfinished, plus anything that finished in the last `hours` — so a failure stays
  // visible long enough to be read rather than vanishing the moment it happens.
  // `stale` is derived, not stored: it is the same age rule `enqueue` applies, so the UI can
  // offer the action again on exactly the jobs that have stopped blocking it.
  listJobs(hours = 24, now = new Date()): (Job & { stale: boolean })[] {
    const since = new Date(now.getTime() - hours * 3600_000).toISOString();
    const fresh = new Date(now.getTime() - STALE_JOB_HOURS * 3600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN (${UNFINISHED.map(() => "?").join(",")}) OR finished_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(...UNFINISHED, since) as unknown as Job[];
    return rows.map((j) => ({
      ...j,
      stale: (UNFINISHED as string[]).includes(j.status) && j.created_at < fresh,
    }));
  }
}
