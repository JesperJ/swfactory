// Decides whether something that just happened is worth a push notification, and sends it.
//
// Two triggers only: a session that just became `needs_you`, and a job that just failed.
// Everything else is noise — `your_turn` fires on every turn of normal work and would train
// you to ignore the channel.
//
// The notification text is built here and only here, from project, feature, host and command.
// An ntfy topic is effectively a bearer secret that anyone holding it can subscribe to, so
// prompt text, Claude's messages and filesystem paths must never reach it. Keeping the text in
// one function makes that a property of the code rather than a rule each call site remembers.

import type { Job, JobStatus, Session } from "./db.ts";

export interface Notification {
  title: string;
  body: string;
  click?: string;
}

export interface SessionEvent {
  kind: "session";
  session: Pick<Session, "id" | "status" | "host" | "repo" | "dismissed">;
  statusChanged: boolean;
  // Resolved lazily, and only once the cheap rules have passed: matching a session to a feature
  // means reading every spec, and the overwhelming majority of hooks are not worth that.
  link: () => { project: string | null; feature: string | null };
}

export interface JobEvent {
  kind: "job";
  job: Pick<Job, "project" | "feature" | "command" | "status">;
  previousStatus: JobStatus;
}

export type FactoryEvent = SessionEvent | JobEvent;

// Long enough to name the work, short enough that a phone shows all of it.
const MAX_TEXT = 120;

// Host and repo arrive from the X-Factory-* headers, so they are as trustworthy as whatever
// ran the hook; and an ntfy title has to stay on one line either way.
function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

// A repo is normally a remote URL, but it can be a local path, so only its last segment is
// ever used. That names the thing without putting a filesystem path in the body.
function repoLabel(repo: string | null | undefined): string | null {
  const s = clean(repo);
  if (!s) return null;
  const last = s
    .replace(/\.git$/i, "")
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop();
  return clean(last);
}

// Config, not notification text, so it is trimmed rather than clipped to a phone-sized length.
function trimmed(v: string | null | undefined): string | null {
  const s = v?.trim();
  return s ? s : null;
}

function inboxUrl(baseUrl: string | null | undefined): string | undefined {
  const base = trimmed(baseUrl)?.replace(/\/+$/, "");
  return base ? `${base}/#/inbox` : undefined;
}

export function notificationFor(event: FactoryEvent, baseUrl?: string | null): Notification | null {
  return event.kind === "session" ? forSession(event, baseUrl) : forJob(event, baseUrl);
}

function forSession(e: SessionEvent, baseUrl?: string | null): Notification | null {
  // Claude Code repeats idle notifications while a session waits. Those restate the status
  // rather than reporting anything new, so they are not an event.
  if (!e.statusChanged) return null;
  if (e.session.status !== "needs_you") return null;
  // `upsert` clears `dismissed` on a real status change, so this is belt and braces — but the
  // rule belongs where the rules are, not inferred from another module's behaviour.
  if (e.session.dismissed) return null;

  const { project, feature } = e.link();
  const what = clean(feature) ?? repoLabel(e.session.repo) ?? "unknown work";
  const where = clean(project);
  const host = clean(e.session.host);
  return {
    title: `Needs you: ${where ? `${where} / ${what}` : what}`,
    body: host ? `Claude is blocked on you · ${host}` : "Claude is blocked on you",
    click: inboxUrl(baseUrl),
  };
}

function forJob(e: JobEvent, baseUrl?: string | null): Notification | null {
  if (e.job.status !== "failed") return null;
  // Re-reporting a status the job already had is not a new failure.
  if (e.previousStatus === "failed") return null;
  const project = clean(e.job.project) ?? "unknown project";
  const feature = clean(e.job.feature);
  // The job's `error` is deliberately left out: it is runner output and can carry paths.
  return {
    title: `Job failed: ${feature ? `${project} / ${feature}` : project}`,
    body: `/factory ${e.job.command} did not finish`,
    click: inboxUrl(baseUrl),
  };
}

// --- sending ----------------------------------------------------------------

// One method, so a Web Push sender can sit beside the ntfy one later without any of the rules
// above changing. (The plan called this interface `Notifier`; that name went to the thing the
// endpoints hold, below, because the two need separate names.)
export interface Sender {
  send(n: Notification): Promise<void>;
}

const NTFY_SERVER = "https://ntfy.sh";
const NTFY_TIMEOUT_MS = 5_000;

// ntfy's JSON publish endpoint rather than its header-per-field form: a project or host name
// with a non-ASCII character in it would need RFC 2047 encoding in a header, and needs nothing
// here. `fetch` is injectable so the request shape can be tested without a network.
export function ntfySender(cfg: {
  topic: string;
  server?: string | null;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Sender {
  const server = (trimmed(cfg.server) ?? NTFY_SERVER).replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? NTFY_TIMEOUT_MS;
  const doFetch = cfg.fetch ?? globalThis.fetch;
  return {
    async send(n) {
      const res = await doFetch(server, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: cfg.topic,
          title: n.title,
          message: n.body,
          ...(n.click ? { click: n.click } : {}),
        }),
        // The sender carries its own deadline. Nothing upstream is waiting on it, but a socket
        // that never closes would otherwise leak one handle per notification.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    },
  };
}

export interface NotifierOptions {
  sender?: Sender | null;
  baseUrl?: string | null;
  log?: (msg: string) => void;
}

// What the endpoints hold. Unconfigured, it has no sender and sends nothing — which is how
// "unconfigured behaves exactly as today" is achieved, rather than by scattering `if (enabled)`
// through the endpoints.
export class Notifier {
  private readonly sender: Sender | null;
  private readonly baseUrl: string | null;
  private readonly log: (msg: string) => void;

  constructor(opts: NotifierOptions = {}) {
    this.sender = opts.sender ?? null;
    this.baseUrl = opts.baseUrl ?? null;
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  get enabled(): boolean {
    return this.sender !== null;
  }

  // Fire and forget: returns nothing a request path could await, and never throws. A push to a
  // third party must not be able to slow down, fail, or change the response of an endpoint.
  maybeSend(event: FactoryEvent): void {
    if (!this.sender) return;
    try {
      const n = notificationFor(event, this.baseUrl);
      if (!n) return;
      void this.sender
        .send(n)
        .catch((err: unknown) => this.log(`[notify] send failed: ${(err as Error).message}`));
    } catch (err) {
      this.log(`[notify] failed: ${(err as Error).message}`);
    }
  }
}

export function fromEnv(env: Record<string, string | undefined> = process.env): Notifier {
  const topic = trimmed(env.NTFY_TOPIC);
  return new Notifier({
    sender: topic ? ntfySender({ topic, server: env.NTFY_SERVER }) : null,
    baseUrl: env.FACTORY_PUBLIC_URL,
  });
}
