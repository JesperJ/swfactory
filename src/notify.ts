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
  // A narrow projection, and the call site is expected to build it field by field rather than
  // hand over the whole row: a `Pick` is a compile-time shape, so `prompt`, `message` and `cwd`
  // would otherwise still be sitting on the object at runtime, one careless edit from the body.
  session: Pick<Session, "id" | "status" | "host" | "repo" | "cwd" | "dismissed">;
  statusChanged: boolean;
  // Resolved lazily, and only once every cheap rule — including the cooldown — has passed:
  // matching a session to a feature reads every spec off disk, and almost no hook sends.
  link: () => { project: string | null; feature: string | null };
}

export interface JobEvent {
  kind: "job";
  job: Pick<Job, "project" | "feature" | "command" | "status">;
  previousStatus: JobStatus;
}

export type FactoryEvent = SessionEvent | JobEvent;

// A lock screen shows roughly 30-35 characters of a title before clipping, so what varies — the
// feature — goes in the body, and this cap is a backstop against a hostile header rather than a
// claim that everything below it is visible.
const MAX_TEXT = 60;

// Host, repo and cwd arrive from the X-Factory-* headers, so they are as trustworthy as
// whatever ran the hook; and an ntfy title has to stay on one line either way.
function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

// A repo is normally a remote URL and a cwd is always a path, so only the last segment of
// either is ever used. That names the thing without putting a path in the notification, and it
// is the same reduction `sessionCard` does in the UI.
// Split first, clip second. The other order clips the whole path to MAX_TEXT and then pops the
// last segment *of the truncated prefix*, so a deep path gets named after a middle directory —
// or, once the cap falls inside the first component, after nothing at all.
function lastSegment(v: string | null | undefined): string | null {
  if (!v) return null;
  const whole = v.replace(/\s+/g, " ").trim();
  if (!whole) return null;
  const last = whole
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

function dashboardUrl(baseUrl: string | null | undefined, hash: string): string | undefined {
  const base = trimmed(baseUrl)?.replace(/\/+$/, "");
  return base ? `${base}/#/${hash}` : undefined;
}

// Joined with the title, never repeating it, and never empty.
function body(what: string | null, where: string, tail: string | null, fallback: string): string {
  const parts = [what === where ? null : what, tail].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : fallback;
}

// The rules that need nothing but the session row. Split out so the cooldown can sit behind
// them and in front of the specs read; `notificationFor` applies it too, so there is one copy.
export function sessionWouldNotify(e: SessionEvent): boolean {
  // Claude Code repeats idle notifications while a session waits. Those restate the status
  // rather than reporting anything new, so they are not an event.
  if (!e.statusChanged) return false;
  if (e.session.status !== "needs_you") return false;
  // `upsert` clears `dismissed` on a real status change, so in practice this never fires on the
  // hook path — a dismissed session that genuinely blocks again is a new thing needing you, and
  // notifies. The rule still belongs where the rules are.
  if (e.session.dismissed) return false;
  return true;
}

// The job half of the same split, so the cooldown and the rate limit can both gate on "would
// this send anything" without building the text first. `forJob` calls it, so there is one copy.
export function jobWouldNotify(e: JobEvent): boolean {
  if (e.job.status !== "failed") return false;
  // Re-reporting a status the job already had is not a new failure.
  if (e.previousStatus === "failed") return false;
  return true;
}

export function wouldNotify(event: FactoryEvent): boolean {
  return event.kind === "session" ? sessionWouldNotify(event) : jobWouldNotify(event);
}

export function notificationFor(event: FactoryEvent, baseUrl?: string | null): Notification | null {
  return event.kind === "session" ? forSession(event, baseUrl) : forJob(event, baseUrl);
}

function forSession(e: SessionEvent, baseUrl?: string | null): Notification | null {
  if (!sessionWouldNotify(e)) return null;

  const { project, feature } = e.link();
  // Same fallback chain the dashboard's own session card uses, so a session outside a known
  // project is named the same way in both places instead of reading "unknown work" here.
  const label = lastSegment(e.session.repo) ?? lastSegment(e.session.cwd) ?? "unknown work";
  const where = clean(project) ?? label;
  return {
    title: `Needs you: ${where}`,
    body: body(clean(feature) ?? label, where, clean(e.session.host), "Claude is blocked on you"),
    click: dashboardUrl(baseUrl, "inbox"),
  };
}

function forJob(e: JobEvent, baseUrl?: string | null): Notification | null {
  if (!jobWouldNotify(e)) return null;
  const project = clean(e.job.project) ?? "unknown project";
  const feature = clean(e.job.feature);
  // Not the Inbox: it renders sessions, never jobs, so a tap would land on "All quiet" seconds
  // after this said something failed. The doc sheet shows the failed job and its retry button.
  const enc = encodeURIComponent;
  const hash = e.job.feature ? `next/doc/${enc(e.job.project)}/${enc(e.job.feature)}` : "next";
  // The job's `error` is deliberately left out: it is runner output and can carry paths.
  return {
    title: `Job failed: ${project}`,
    body: body(feature, project, `/factory ${e.job.command}`, `/factory ${e.job.command}`),
    click: dashboardUrl(baseUrl, hash),
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
const NTFY_PRIORITY = 4;

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
          // High, for both triggers: each one means go and look now. Sent in the body rather
          // than left to a per-subscription setting, which only the Android app has.
          priority: NTFY_PRIORITY,
        }),
        // The sender carries its own deadline. Nothing upstream is waiting on it, but a socket
        // that never closes would otherwise leak one handle per notification.
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Released rather than left to the deadline or the GC: an unconsumed body pins the
      // keep-alive socket, which is the leak the timeout above was reasoned about but does not
      // promptly close.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    },
  };
}

// One stuck session must not be able to buzz the phone every time it restates itself.
export const COOLDOWN_MS = 10 * 60_000;

// And nothing at all may buzz it more than this, whatever the per-session cooldown says.
// Ten in ten minutes is well above a normal day — two or three sessions blocking at once is
// the busy case the spec describes — and well below the point where you stop reading them.
export const GLOBAL_LIMIT = 10;
export const GLOBAL_WINDOW_MS = 10 * 60_000;

export interface NotifierOptions {
  sender?: Sender | null;
  baseUrl?: string | null;
  log?: (msg: string) => void;
  now?: () => number;
}

// What the endpoints hold. Unconfigured, it has no sender and sends nothing — which is how
// "unconfigured behaves exactly as today" is achieved, rather than by scattering `if (enabled)`
// through the endpoints.
export class Notifier {
  private readonly sender: Sender | null;
  private readonly baseUrl: string | null;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  // In memory on purpose: a restart can at most allow one extra notification, which is a far
  // smaller cost than a schema change and a migration for state that is worthless after ten
  // minutes. Expired entries are pruned on use, so the map holds roughly the sessions that
  // blocked in the last ten minutes.
  private readonly lastSent = new Map<string, number>();
  // Timestamps of everything sent inside the global window, oldest first.
  private recent: number[] = [];
  private limiting = false;

  constructor(opts: NotifierOptions = {}) {
    this.sender = opts.sender ?? null;
    this.baseUrl = opts.baseUrl ?? null;
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.now = opts.now ?? Date.now;
  }

  // The backstop the per-session cooldown cannot be: that cooldown gives N buckets to N session
  // ids, and nothing cools jobs at all, so anything holding a token can mint ids or cycle a job
  // through `failed` and buzz the phone without limit. A spec that worries about training you to
  // ignore the channel needs a ceiling, not just a per-session gap — and `priority: 4` on every
  // message means each one costs more attention than it did when this was first skipped.
  //
  // Drops rather than queues: a notification you get ten minutes late is worse than one you
  // never got, because by then the dashboard already tells you.
  private rateLimited(): boolean {
    const now = this.now();
    while (this.recent.length && now - this.recent[0] >= GLOBAL_WINDOW_MS) this.recent.shift();
    if (this.recent.length >= GLOBAL_LIMIT) {
      // Once per burst, not once per drop: the log is the thing you read when the phone went
      // quiet, and it should say so rather than bury it.
      if (!this.limiting) {
        this.limiting = true;
        this.log(
          `[notify] ${GLOBAL_LIMIT} notifications in ${GLOBAL_WINDOW_MS / 60_000} minutes; dropping further ones until the window clears.`,
        );
      }
      return true;
    }
    this.limiting = false;
    this.recent.push(now);
    return false;
  }

  private cooling(sessionId: string): boolean {
    const now = this.now();
    for (const [id, at] of this.lastSent) if (now - at >= COOLDOWN_MS) this.lastSent.delete(id);
    const at = this.lastSent.get(sessionId);
    if (at !== undefined && now - at < COOLDOWN_MS) return true;
    // Recorded on the attempt, not on success: a push that failed is not worth retrying ten
    // minutes later, and the next real status change will notify anyway.
    this.lastSent.set(sessionId, now);
    return false;
  }

  get enabled(): boolean {
    return this.sender !== null;
  }

  // Fire and forget: returns immediately, and never throws. Round 1 found this was only half
  // true — everything below is synchronous up to the `send()` call, and the link thunk reads
  // every spec off disk, so it was blocking the event loop before the handler could respond.
  // `setImmediate`, not `queueMicrotask`: a microtask would still run before the response is
  // written. Nothing upstream can observe any of it, which is the point.
  maybeSend(event: FactoryEvent): void {
    if (!this.sender) return;
    setImmediate(() => this.deliver(event));
  }

  private deliver(event: FactoryEvent): void {
    const sender = this.sender;
    if (!sender) return;
    try {
      // Every gate runs before `notificationFor`, because that is what reads the specs, and
      // because the rate limit must only spend budget on something that would really be sent.
      if (!wouldNotify(event)) return;
      // A session that flaps needs_you → working → needs_you is the same stuck session, not a
      // second thing to know about, and it should not pay for a spec read it will discard.
      // Jobs are not cooled: `failed` is terminal so there is only ever one per job, and two
      // jobs failing at once are two things to know about.
      if (event.kind === "session" && this.cooling(event.session.id)) return;
      // After the per-session gate, so one stuck session cannot eat the global budget.
      if (this.rateLimited()) return;
      const n = notificationFor(event, this.baseUrl);
      if (!n) return;
      void sender
        .send(n)
        .catch((err: unknown) => this.log(`[notify] send failed: ${(err as Error).message}`));
    } catch (err) {
      // Reached only from a detached callback now, where an escaping throw would take the
      // process down rather than merely fail a request.
      this.log(`[notify] failed: ${(err as Error).message}`);
    }
  }
}

export function fromEnv(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (msg) => console.error(msg),
): Notifier {
  const topic = trimmed(env.NTFY_TOPIC);
  const baseUrl = trimmed(env.FACTORY_PUBLIC_URL);
  // The two are independent env vars and both optional, so half-configured is easy to reach and
  // invisible from the phone: the notification arrives and tapping it does nothing. Say so once
  // at startup rather than sending dead notifications in silence.
  if (topic && !baseUrl)
    log("[notify] NTFY_TOPIC is set but FACTORY_PUBLIC_URL is not; notifications will not be tappable.");
  return new Notifier({
    sender: topic ? ntfySender({ topic, server: env.NTFY_SERVER }) : null,
    baseUrl,
    log,
  });
}
