// Ranks one recommended next action across every project, plus a few alternatives.
//
// The rules are deliberately legible: every item carries the reason it ranks where it does,
// so the list can be argued with. No scoring model.

import type { Session, JobCommand } from "./db.ts";
import type { SessionLink } from "./match.ts";
import { FEATURE_STATUSES, type Feature, type Project } from "./specs.ts";

// A session as /api/state serves it: the stored row plus the project and feature it matched.
export type LinkedSession = Session & SessionLink;

export const STALE_DAYS = 7; // a `building` feature with no Log entry for this long has stalled
// There is deliberately no window for `needs_you`. Round 1 of 015 found a 48-hour cutoff added
// here where none had ever existed, under a comment saying the opposite, with a test whose name
// and comment both claimed nothing had changed. A session blocked on a person is the one row in
// Next that must never go quiet: the user comes back after a weekend to be told what is waiting
// on them, and 49 hours was enough for the answer to be "nothing".
// A finished session means "it stopped and wants a read". After two hours the honest reading is
// that it has been read or stopped mattering. 48h turned Next into a log once the runner made
// finished sessions the common case rather than the rare one.
export const NEXT_FINISHED_HOURS = 2;
const BLOCKED_PENALTY = 100; // blocked work sinks below everything actionable

export type NextKind =
  | "answer"
  | "review"
  | "escalated" // a question approve asked and nobody has answered
  | "approve"
  | "finish" // reviewed, every criterion met — the human sets done
  | "unstick"
  | "build"
  | "plan"
  | "spec"
  | "unblock"
  | "link"; // not an action at all

// What each kind means in terms of work that can actually be started. Round 1 of 005 found the
// UI keeping its own copy of this and disagreeing with the command's dispatch table, so the
// hero's "Review it" button queued a build. There is now exactly one mapping, here, and the UI
// is handed the answer rather than deriving it. Session kinds are null on purpose: no command
// can answer a session for you.
const KIND_COMMAND: Record<NextKind, JobCommand | null> = {
  answer: null,
  review: null,
  // Null on purpose, each for its own reason: an escalation needs a decision, "done" is
  // approve's gate and taking it automatically is how a lifecycle becomes decoration, a block
  // needs a person, and a link is not work.
  escalated: null,
  finish: null,
  unblock: null,
  link: null,
  approve: "review",
  unstick: "build",
  build: "build",
  plan: "plan",
  spec: "spec",
};

export interface NextItem {
  kind: NextKind;
  action: string; // "Answer", "Build" — the verb, for the UI
  command: JobCommand | null; // what tapping it queues, or null when nothing can be queued
  title: string;
  project: string; // display name
  projectSlug: string;
  feature: string | null; // feature slug
  priority: string | null; // "P1" — null for a session, which has no priority of its own
  status: string | null; // the feature's lifecycle status; null for a session
  sessionId: string | null;
  url: string | null; // session link, when there is one
  reason: string; // why it ranks here
  blocked: boolean;
  score: number;
}

// P1 sorts before P2 before unprioritised, without letting priority outrank urgency.
function priorityWeight(priority: string | null): number {
  const m = priority?.match(/P(\d)/i);
  return m ? Number(m[1]) / 10 : 0.35;
}

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / 86400_000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function rankNext(projects: Project[], sessions: LinkedSession[], now = new Date()): NextItem[] {
  const items: NextItem[] = [];
  const liveByFeature = new Map<string, LinkedSession>();

  for (const s of sessions) {
    if (s.status === "ended" || !s.project) continue;
    if (s.feature) liveByFeature.set(`${s.project}/${s.feature}`, s);
  }

  const projectOf = (slug: string | null) => projects.find((p) => p.slug === slug);
  const featureOf = (p: Project | undefined, slug: string | null) =>
    p?.features.find((f) => f.slug === slug);

  // Sessions waiting on a human, but only ones doing factory work. A session in some repo the
  // factory doesn't track is not a project decision — it belongs in the Inbox, not here.
  // Without this the view degenerates into the session list it is supposed to replace.
  for (const s of sessions) {
    if (s.status !== "needs_you" && s.status !== "your_turn") continue;
    const idleMs = now.getTime() - new Date(s.status_since ?? s.updated_at).getTime();
    if (s.status === "your_turn" && idleMs > NEXT_FINISHED_HOURS * 3600_000) continue;
    const p = projectOf(s.project);
    if (!p) continue;
    const f = featureOf(p, s.feature);
    // The feature is finished and merged; nothing this session says changes that. It stays in
    // the Inbox and in Sessions, where history belongs, but it is not work to be chosen.
    if (f?.status === "done") continue;
    // "A session finished" with no feature attached is not a piece of factory work — often it
    // is the session you are typing in. The Inbox lists it; Next should not recommend it.
    // A blocked session still ranks, feature or not, because being stuck is urgent either way.
    if (!f && s.status === "your_turn") continue;
    items.push({
      kind: s.status === "needs_you" ? "answer" : "review",
      action: s.status === "needs_you" ? "Answer" : "Review",
      command: null, // a session needs a person, not a queued command
      title: f?.title ?? `${p.name} session`,
      project: p.name,
      projectSlug: p.slug,
      feature: f?.slug ?? null,
      // A session has no lifecycle status or priority of its own; the table leaves them blank
      // rather than borrowing the feature's and implying the session is at that stage.
      priority: null,
      status: null,
      sessionId: s.id,
      url: s.url,
      reason: s.status === "needs_you" ? "a session is blocked on you" : "a session finished and wants a look",
      blocked: false,
      score: s.status === "needs_you" ? 0 : 1,
    });
  }

  // Features, by what they need next.
  for (const p of projects) {
    if (p.status !== "active") continue;
    for (const f of p.features) {
      const live = liveByFeature.get(`${p.slug}/${f.slug}`);
      // Something is already working on it; it is not a thing to start.
      if (live && live.status === "working") continue;

      const entry = featureEntry(p, f, now);
      if (!entry) continue;
      items.push({
        ...entry,
        score: entry.score + priorityWeight(f.priority) + (f.blocked ? BLOCKED_PENALTY : 0),
        blocked: !!f.blocked,
        reason: f.blocked ?? entry.reason,
      });
    }
  }

  return items.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
}

type FeatureEntry = Omit<NextItem, "score" | "blocked" | "reason"> & { score: number; reason: string };

// What a feature could do next, and which of those is worth doing — so the Projects view, the
// feature sheet and Next all offer the same moves without keeping their own copy of the rules.
// 005 found the UI holding a second, disagreeing copy, which made "Review it" queue a build.
export interface FeatureOption {
  kind: NextKind;
  action: string;
  command: JobCommand | null; // null means no agent can do this — it is yours
  reason: string;
  score: number;
  recommended: boolean;
  href?: string; // a link rather than an action, e.g. the pull request
}

// A line of facts, not a verdict. "3 rounds · 1 of 14 unticked" rather than "nearly done":
// the verdict belongs in the recommendation, where it is labelled as one.
export function featureFacts(f: Feature): string[] {
  const facts: string[] = [];
  if (f.rounds.length) {
    const last = f.rounds[f.rounds.length - 1];
    facts.push(plural(f.rounds.length, "round"));
    if (roundIsStale(f)) facts.push(`round ${last.n} predates the last build`);
  } else if (f.status === "reviewing") {
    facts.push("never reviewed");
  }
  const { ticked, total } = f.criteria;
  if (total) facts.push(ticked === total ? `all ${total} criteria met` : `${total - ticked} of ${total} criteria unticked`);
  if (f.vcs?.merged) facts.push("merged");
  else if (f.vcs && f.vcs.exists) facts.push("branch not merged");
  return facts;
}

// Has the feature been built since its newest review round? `build` writes a Log entry, and a
// round file carries its date, so comparing the two answers it without a repository. Both
// dates absent means we cannot tell, and cannot-tell is not evidence of staleness.
export function roundIsStale(f: Feature): boolean {
  const last = f.rounds[f.rounds.length - 1];
  if (!last?.date || !f.lastLog) return false;
  return f.lastLog > last.date;
}

export function featureOptions(f: Feature, now = new Date()): FeatureOption[] {
  const opts: FeatureOption[] = [];
  const add = (kind: NextKind, action: string, score: number, reason: string, href?: string) =>
    opts.push({ kind, action, command: KIND_COMMAND[kind], score, reason, recommended: false, href });

  // An escalation is a question that has been asked and not answered. No sub-command can
  // answer it, so the row must not offer one: the dashboard should never sell a way to avoid
  // a decision. This outranks everything else a feature could be doing.
  if (f.question && f.status === "reviewing") {
    add("escalated", "Answer", 1.5, f.question);
  }

  switch (f.status) {
    case "building": {
      const stalled = f.lastLog ? daysSince(f.lastLog, now) : null;
      if (stalled !== null && stalled >= STALE_DAYS)
        add("unstick", "Unstick", 2, `no activity for ${plural(stalled, "day")}`);
      else add("unstick", "Continue", 3, "in progress, nothing running");
      break;
    }
    case "reviewing": {
      const unticked = f.criteria.total - f.criteria.ticked;
      const stale = roundIsStale(f);
      // Above starting anything new: finishing what is nearly done beats widening the work.
      add(
        "approve",
        f.rounds.length ? `Review again (round ${f.rounds.length + 1})` : "Review",
        2.5,
        f.rounds.length ? (stale ? "reviewed, but built again since" : "reviewed, no round since the last build") : "never reviewed",
      );
      // "Mark done" is only offered when it would be honest. Both of these were ticked while
      // false during 015, which is why they are rules rather than judgement.
      if (!unticked && !stale && f.rounds.length && !f.question)
        add("finish", "Mark done", 2.4, "reviewed, every criterion met");
      break;
    }
    case "planned":
      add("build", "Build", 4, "planned and ready to build");
      break;
    case "specced":
      add("plan", "Plan", 5, "specced, needs a plan");
      break;
    case "idea":
      add("spec", "Spec", 6, "an idea, needs a spec");
      break;
  }

  // Blocked work still has one move, and it is not an agent's: say why it is stuck and let a
  // person unstick it. Round 1 and round 2 of 015 both found these rendering with no control
  // at all, in a view whose whole premise is that every row can be acted on.
  if (f.blocked) {
    opts.length = 0;
    add("unblock", "Unblock", BLOCKED_PENALTY, f.blocked);
  }

  // A link, not an action: the dashboard does not drive git, and `JOB_COMMANDS` stays short
  // because it is the blast radius of a compromised page.
  if (f.prUrl) add("link", f.vcs?.merged ? "PR merged" : "Open PR", 99, "the pull request", f.prUrl);

  // Exactly one recommendation: the cheapest real move. Ties break toward the earlier rule,
  // which is the one the lifecycle reaches first.
  const best = opts.filter((o) => o.kind !== "link").sort((a, b) => a.score - b.score)[0];
  if (best) best.recommended = true;
  return opts;
}

// The single move a feature should make, or null — what `featureAction` used to return, now
// derived from the options so there is one set of rules rather than two.
export function featureAction(f: Feature, now = new Date()): FeatureOption | null {
  return featureOptions(f, now).find((o) => o.recommended) ?? null;
}

export interface LifecycleStage {
  status: string;
  count: number;
}

// How many features sit at each lifecycle stage right now, across active projects, in order.
// Every stage is returned even when empty: the strip draws the shape of the process, and a
// process that changes shape depending on where work happens to be is not a diagram of
// anything. Pure, so the "counts sum to the features" claim is a unit test, not a screenshot.
export function lifecycleCounts(projects: Project[]): LifecycleStage[] {
  const counts = new Map<string, number>(FEATURE_STATUSES.map((s) => [s, 0]));
  for (const p of projects) {
    if (p.status !== "active") continue;
    for (const f of p.features) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  }
  // A status outside the lifecycle (a typo in a spec) is counted but shown last rather than
  // silently dropped, so a mistake in frontmatter is visible instead of invisible.
  const extra = [...counts.keys()].filter((s) => !(FEATURE_STATUSES as readonly string[]).includes(s));
  return [...FEATURE_STATUSES, ...extra].map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

function featureEntry(p: Project, f: Feature, now: Date): FeatureEntry | null {
  const a = featureAction(f, now);
  if (!a) return null;
  return {
    kind: a.kind,
    action: a.action,
    command: a.command,
    reason: a.reason,
    score: a.score,
    title: f.title,
    project: p.name,
    projectSlug: p.slug,
    feature: f.slug,
    priority: f.priority,
    status: f.status,
    sessionId: null,
    url: null,
  };
}
