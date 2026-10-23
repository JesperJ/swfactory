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
    `);
  }

  // Merges an update into the session row. Fields left undefined keep their stored value;
  // a new prompt clears the previous turn's message.
  upsert(u: SessionUpdate, now = new Date().toISOString()): void {
    const existing = this.get(u.id);
    const pick = <T>(next: T | undefined, prev: T | null | undefined): T | null =>
      next !== undefined && next !== null && next !== "" ? next : (prev ?? null);
    const row = {
      id: u.id,
      status: u.status ?? existing?.status ?? "your_turn",
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
      // Any new activity brings a dismissed session back.
      dismissed: 0,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
         (id, status, url, cwd, repo, branch, host, feature_hint, prompt, message, last_event, started_at, updated_at, dismissed)
         VALUES (:id, :status, :url, :cwd, :repo, :branch, :host, :feature_hint, :prompt, :message, :last_event, :started_at, :updated_at, :dismissed)`,
      )
      .run(row);
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
}
