// Keeps the specs up to date.
//
// Local:    watches the specs folder and reloads on change.
// Deployed: set SPECS_GIT_URL and the server clones that repo and pulls it every
//           SPECS_SYNC_SECONDS (and on POST /api/specs/sync).

import { execFile } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitSyncOptions {
  url: string;
  checkoutDir: string;
  branch?: string;
}

async function head(dir: string): Promise<string> {
  return (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

// Returns true when the checkout changed.
export async function gitSync({ url, checkoutDir, branch }: GitSyncOptions): Promise<boolean> {
  if (!existsSync(join(checkoutDir, ".git"))) {
    const args = ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), url, checkoutDir];
    await run("git", args, { timeout: 120_000 });
    return true;
  }
  const before = await head(checkoutDir);
  await run("git", ["-C", checkoutDir, "fetch", "--depth", "1", "origin", branch ?? "HEAD"], { timeout: 60_000 });
  await run("git", ["-C", checkoutDir, "reset", "--hard", "FETCH_HEAD"]);
  return (await head(checkoutDir)) !== before;
}

export function watchDir(dir: string, onChange: () => void): void {
  if (!existsSync(dir)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
  } catch (err) {
    console.warn(`[specs] not watching ${dir}:`, (err as Error).message);
  }
}
