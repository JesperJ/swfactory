// Links reported sessions to projects and features.
//
// Project: the session's git remote matches `repo:` in project.md, or the working
//          directory's folder name equals the project slug.
// Feature: FACTORY_FEATURE in the session's environment ("003" or "003-login"),
//          or a branch name containing the feature number or slug, e.g. feature/003-login.

import { basename } from "node:path";
import type { Session } from "./db.ts";
import { normalizeRepo, type Feature, type Project } from "./specs.ts";

export interface SessionLink {
  project: string | null;
  feature: string | null; // feature slug
}

export function matchProject(s: Pick<Session, "repo" | "cwd">, projects: Project[]): Project | null {
  const repo = normalizeRepo(s.repo);
  if (repo) {
    const hit = projects.find((p) => p.repo === repo);
    if (hit) return hit;
  }
  if (s.cwd) {
    const dir = basename(s.cwd).toLowerCase();
    const hit = projects.find((p) => p.slug.toLowerCase() === dir);
    if (hit) return hit;
  }
  return null;
}

export function matchFeature(s: Pick<Session, "feature_hint" | "branch">, features: Feature[]): Feature | null {
  const hint = s.feature_hint?.toLowerCase();
  if (hint) {
    const hit = features.find(
      (f) => f.slug.toLowerCase() === hint || f.id === hint || (/^\d+$/.test(hint) && Number(f.id) === Number(hint)),
    );
    if (hit) return hit;
  }
  const branch = s.branch?.toLowerCase();
  if (branch) {
    const bySlug = features.find((f) => branch.includes(f.slug.toLowerCase()));
    if (bySlug) return bySlug;
    const num = branch.match(/(?:^|[/_-])(\d{2,4})(?=[-_/]|$)/)?.[1];
    if (num) {
      const byId = features.find((f) => Number(f.id) === Number(num));
      if (byId) return byId;
    }
  }
  return null;
}

export function linkSession(s: Session, projects: Project[]): SessionLink {
  const project = matchProject(s, projects);
  const feature = project ? matchFeature(s, project.features) : null;
  return { project: project?.slug ?? null, feature: feature?.slug ?? null };
}
