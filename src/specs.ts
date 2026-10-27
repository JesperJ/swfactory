// Loads projects and features from the markdown specs folder.
//
// Layout:
//   <specsDir>/<project-slug>/project.md
//   <specsDir>/<project-slug>/features/<NNN>-<feature-slug>.md

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

export const FEATURE_STATUSES = ["idea", "specced", "planned", "building", "reviewing", "done"] as const;

// How far the acceptance criteria have been ticked. The dashboard could never see this, so a
// feature with three unticked criteria looked exactly like a finished one.
export interface Criteria {
  ticked: number;
  total: number;
}

// A review round that exists on disk, newest last.
export interface Round {
  n: number;
  date: string | null; // "Date:" line inside the round file, when it has one
}

// What version control knows, as reported by the runner — the dashboard has no repository of
// its own to ask. Absent means nobody has told us, which the view must render as nothing rather
// than as a guess. See decisions/2026-10-27-vcs-facts-come-from-the-runner.md.
export interface Vcs {
  branch: string | null;
  exists: boolean;
  merged: boolean;
}

export interface Feature {
  id: string; // "003"
  slug: string; // "003-login"
  title: string;
  status: string;
  priority: string | null;
  summary: string | null;
  blocked: string | null; // frontmatter `blocked:` — why this can't move right now
  lastLog: string | null; // newest "- YYYY-MM-DD" date under ## Log, for spotting stalls
  criteria: Criteria;
  rounds: Round[];
  prUrl: string | null; // newest pull request link found in the Log
  question: string | null; // frontmatter `question:` — an escalation waiting on a person
  vcs: Vcs | null; // reported by the runner; null until it has been
  file: string;
}

export interface Project {
  slug: string;
  name: string;
  status: string;
  summary: string | null;
  repo: string | null; // normalized, e.g. "github.com/owner/name"
  repoUrl: string | null; // as written in project.md
  features: Feature[];
  file: string;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

// "https://github.com/Owner/Name.git", "git@github.com:Owner/Name" -> "github.com/owner/name"
export function normalizeRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z+]+:\/\//, ""); // scheme
  s = s.replace(/^[^@/]+@/, ""); // user@ or token@
  s = s.replace(/^([^/:]+):(?!\d)/, "$1/"); // scp-style host:path
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  // Claude cloud sessions clone through a local git proxy: http://local_proxy@127.0.0.1:PORT/git/owner/name
  const proxied = s.match(/^127\.0\.0\.1(?::\d+)?\/git\/(.+)$/);
  if (proxied) s = `github.com/${proxied[1]}`;
  return s || null;
}

function readMd(file: string) {
  const parsed = matter(readFileSync(file, "utf8"));
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Newest "- YYYY-MM-DD ..." entry under ## Log. Entries are written newest-last by convention,
// but we take the maximum rather than the last line so an out-of-order entry can't fake a stall.
export function lastLogDate(body: string): string | null {
  const log = body.split(/^##\s+Log\s*$/m)[1];
  if (!log) return null;
  const dates = log.match(/^-\s*(\d{4}-\d{2}-\d{2})/gm)?.map((l) => l.replace(/^-\s*/, ""));
  return dates?.length ? dates.sort().at(-1)! : null;
}

// Ticked and total acceptance criteria. Only the checkboxes under "## Acceptance criteria" are
// counted: Tasks are checkboxes too, and conflating them would make a feature look finished
// because its *work* was done rather than because its criteria were met — which is the exact
// confusion this feature exists to remove.
export function countCriteria(body: string): Criteria {
  const section = body.split(/^##\s+Acceptance criteria\s*$/im)[1];
  if (!section) return { ticked: 0, total: 0 };
  const upToNextHeading = section.split(/^##\s+/m)[0];
  const boxes = upToNextHeading.match(/^\s*-\s+\[([ xX~])\]/gm) ?? [];
  const ticked = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  return { ticked, total: boxes.length };
}

// The newest pull request link in the Log. `build` writes one there, which is why this needs no
// repository and no network — the Log is a file the dashboard already reads.
export function prUrlFrom(body: string): string | null {
  const links = body.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  return links?.length ? links[links.length - 1] : null;
}

// Review rounds for one feature id, from `<project>/reviews/<NNN>-round-<n>.md`.
export function loadRounds(reviewsDir: string, id: string): Round[] {
  if (!existsSync(reviewsDir)) return [];
  const rounds: Round[] = [];
  for (const name of readdirSync(reviewsDir).sort()) {
    const m = name.match(/^(\d+)-round-(\d+)\.md$/);
    if (!m || m[1] !== id) continue;
    let date: string | null = null;
    try {
      // "Date: 2026-10-24" near the top. A round file without one still counts as a round.
      date = readFileSync(join(reviewsDir, name), "utf8").match(/^Date:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
    } catch {
      date = null;
    }
    rounds.push({ n: Number(m[2]), date });
  }
  return rounds.sort((a, b) => a.n - b.n);
}

export function loadProjects(specsDir: string): Project[] {
  if (!existsSync(specsDir)) return [];
  const projects: Project[] = [];
  for (const slug of readdirSync(specsDir).sort()) {
    const dir = join(specsDir, slug);
    const file = join(dir, "project.md");
    if (slug.startsWith(".") || !statSync(dir).isDirectory() || !existsSync(file)) continue;
    const { data, body } = readMd(file);
    projects.push({
      slug,
      name: str(data.name) ?? firstHeading(body) ?? slug,
      status: str(data.status) ?? "active",
      summary: str(data.summary),
      repo: normalizeRepo(str(data.repo)),
      repoUrl: str(data.repo),
      features: loadFeatures(join(dir, "features"), join(dir, "reviews")),
      file: join(slug, "project.md"),
    });
  }
  return projects;
}

function loadFeatures(dir: string, reviewsDir: string): Feature[] {
  if (!existsSync(dir)) return [];
  const features: Feature[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    // A spec someone is halfway through editing must not take the dashboard down: this runs on
    // every /api/state. Anything unreadable yields a feature with no extra facts rather than an
    // exception, which is the same failure direction the rest of this file already takes.
    let data: Record<string, unknown> = {};
    let body = "";
    try {
      ({ data, body } = readMd(join(dir, name)));
    } catch {
      continue;
    }
    const id = slug.match(/^(\d+)/)?.[1] ?? slug;
    features.push({
      id,
      slug,
      title: str(data.title) ?? firstHeading(body) ?? slug,
      status: str(data.status) ?? "idea",
      priority: str(data.priority),
      summary: str(data.summary),
      blocked: str(data.blocked),
      lastLog: lastLogDate(body),
      criteria: countCriteria(body),
      rounds: loadRounds(reviewsDir, id),
      prUrl: prUrlFrom(body),
      question: str(data.question),
      vcs: null, // filled in from what the runner has reported, if anything
      file: name,
    });
  }
  return features;
}

// Renders a project's or feature's markdown. Specs come from your own repo, so they are trusted.
export function renderDoc(specsDir: string, projectSlug: string, featureSlug?: string) {
  if (!/^[\w.-]+$/.test(projectSlug) || (featureSlug && !/^[\w.-]+$/.test(featureSlug))) return null;
  const file = featureSlug
    ? join(specsDir, projectSlug, "features", `${featureSlug}.md`)
    : join(specsDir, projectSlug, "project.md");
  if (!existsSync(file)) return null;
  const { data, body } = readMd(file);
  return { meta: data, html: marked.parse(body, { async: false }) };
}
