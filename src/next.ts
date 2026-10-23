// Ranks one recommended next action across every project, plus a few alternatives.
//
// The rules are deliberately legible: every item carries the reason it ranks where it does,
// so the list can be argued with. No scoring model.

import type { Session } from "./db.ts";
import type { SessionLink } from "./match.ts";
import type { Feature, Project } from "./specs.ts";

// A session as /api/state serves it: the stored row plus the project and feature it matched.
export type LinkedSession = Session & SessionLink;

export const STALE_DAYS = 7; // a `building` feature with no Log entry for this long has stalled
const REVIEW_WINDOW_MS = 48 * 3600_000; // a finished session older than this stops being urgent
const BLOCKED_PENALTY = 100; // blocked work sinks below everything actionable

export type NextKind = "answer" | "review" | "unstick" | "build" | "plan" | "spec";

export interface NextItem {
  kind: NextKind;
  action: string; // "Answer", "Build" — the verb, for the UI
  title: string;
  project: string; // display name
  projectSlug: string;
  feature: string | null; // feature slug
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
    if (s.status === "your_turn" && now.getTime() - new Date(s.status_since ?? s.updated_at).getTime() > REVIEW_WINDOW_MS) continue;
    const p = projectOf(s.project);
    if (!p) continue;
    const f = featureOf(p, s.feature);
    items.push({
      kind: s.status === "needs_you" ? "answer" : "review",
      action: s.status === "needs_you" ? "Answer" : "Review",
      title: f?.title ?? `${p.name} session`,
      project: p.name,
      projectSlug: p.slug,
      feature: f?.slug ?? null,
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

function featureEntry(p: Project, f: Feature, now: Date): FeatureEntry | null {
  const base = {
    title: f.title,
    project: p.name,
    projectSlug: p.slug,
    feature: f.slug,
    sessionId: null,
    url: null,
  };
  switch (f.status) {
    case "building": {
      const stalled = f.lastLog ? daysSince(f.lastLog, now) : null;
      if (stalled !== null && stalled >= STALE_DAYS)
        return { ...base, kind: "unstick", action: "Unstick", score: 2, reason: `no activity for ${plural(stalled, "day")}` };
      return { ...base, kind: "unstick", action: "Continue", score: 3, reason: "in progress, nothing running" };
    }
    case "planned":
      return { ...base, kind: "build", action: "Build", score: 4, reason: "planned and ready to build" };
    case "specced":
      return { ...base, kind: "plan", action: "Plan", score: 5, reason: "specced, needs a plan" };
    case "idea":
      return { ...base, kind: "spec", action: "Spec", score: 6, reason: "an idea, needs a spec" };
    default:
      return null; // done, or something we don't act on
  }
}
