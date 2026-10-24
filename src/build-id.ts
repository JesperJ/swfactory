// A short id for "the code this page is running".
//
// The dashboard never navigates and its data arrives over SSE, so an open page goes on running
// whatever it loaded hours ago while rendering current data. That is indistinguishable from a
// bug — it cost three investigations in one day before this existed. The page compares the id
// it booted with against the one the server reports, and reloads when they differ.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Content, not mtime: rebuilding the container rewrites every timestamp, and a page should not
// reload because a file was copied. Paths are included so a rename counts as a change.
export function buildId(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string, prefix: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      // A dangling symlink or an unreadable file must not stop the server booting: without
      // this, one bad entry under public/ throws out of createApp and nothing serves at all.
      // The path still goes into the hash, so the file appearing or disappearing is a change.
      try {
        if (statSync(full).isDirectory()) walk(full, rel);
        else {
          hash.update(rel);
          hash.update(readFileSync(full));
        }
      } catch {
        hash.update(rel);
        hash.update("<unreadable>");
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex").slice(0, 8);
}
