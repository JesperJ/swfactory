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

export interface Feature {
  id: string; // "003"
  slug: string; // "003-login"
  title: string;
  status: string;
  priority: string | null;
  summary: string | null;
  blocked: string | null; // frontmatter `blocked:` — why this can't move right now
  lastLog: string | null; // newest "- YYYY-MM-DD" date under ## Log, for spotting stalls
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
      features: loadFeatures(join(dir, "features")),
      file: join(slug, "project.md"),
    });
  }
  return projects;
}

function loadFeatures(dir: string): Feature[] {
  if (!existsSync(dir)) return [];
  const features: Feature[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const slug = name.slice(0, -3);
    const { data, body } = readMd(join(dir, name));
    features.push({
      id: slug.match(/^(\d+)/)?.[1] ?? slug,
      slug,
      title: str(data.title) ?? firstHeading(body) ?? slug,
      status: str(data.status) ?? "idea",
      priority: str(data.priority),
      summary: str(data.summary),
      blocked: str(data.blocked),
      lastLog: lastLogDate(body),
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
