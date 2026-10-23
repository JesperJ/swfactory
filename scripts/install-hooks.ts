// Installs the Factory reporting hook so Claude Code sessions show up on the dashboard.
//
//   npm run install-hooks -- --user [--url https://factory.example.com --token <hook token>]
//       All Claude Code sessions on this machine. --url/--token are saved in ~/.claude/settings.json.
//
//   npm run install-hooks -- ../path/to/repo
//       One repo (commit the result). Needed for Claude Code on the web and mobile, which
//       don't read your ~/.claude. Set FACTORY_URL and FACTORY_HOOK_TOKEN in the cloud
//       environment's settings; the token is never written into the repo.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"] as const;
const SCRIPT = "factory-report.sh";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
type Settings = { hooks?: Record<string, HookEntry[]>; env?: Record<string, string>; [k: string]: unknown };

// Adds the hook to every event, replacing an earlier Factory entry instead of duplicating it.
export function mergeHooks(settings: Settings, command: string): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of EVENTS) {
    const kept = (hooks[event] ?? []).filter((e) => !e.hooks?.some((h) => h.command?.includes(SCRIPT)));
    hooks[event] = [...kept, { hooks: [{ type: "command", command, timeout: 10 }] }];
  }
  return { ...settings, hooks };
}

function main(argv: string[]) {
  const user = argv.includes("--user");
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const target = argv.find((a, i) => !a.startsWith("--") && !["--url", "--token"].includes(argv[i - 1] ?? ""));
  if (!user && !target) {
    console.log("Usage:\n  npm run install-hooks -- --user [--url <factory url> --token <hook token>]\n  npm run install-hooks -- <repo path>");
    process.exit(1);
  }

  const claudeDir = user ? join(homedir(), ".claude") : join(resolve(target!), ".claude");
  const scriptSrc = resolve(fileURLToPath(import.meta.url), "../../hooks", SCRIPT);
  const scriptDst = join(claudeDir, "hooks", SCRIPT);
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  copyFileSync(scriptSrc, scriptDst);
  chmodSync(scriptDst, 0o755);

  const settingsFile = join(claudeDir, "settings.json");
  let settings: Settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  const command = user ? `"$HOME/.claude/hooks/${SCRIPT}"` : `"$CLAUDE_PROJECT_DIR/.claude/hooks/${SCRIPT}"`;
  settings = mergeHooks(settings, command);

  const url = flag("--url");
  const token = flag("--token");
  if (user && (url || token)) {
    settings.env = { ...(settings.env ?? {}), ...(url ? { FACTORY_URL: url } : {}), ...(token ? { FACTORY_HOOK_TOKEN: token } : {}) };
  } else if (!user && (url || token)) {
    console.warn("Ignoring --url/--token: they would be committed with the repo. Set them as environment variables instead.");
  }
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  console.log(`Installed ${scriptDst}\nUpdated   ${settingsFile}`);
  if (user && !(url && token)) {
    console.log("\nNext: set FACTORY_URL and FACTORY_HOOK_TOKEN (shell profile, or rerun with --url and --token).");
  }
  if (!user) {
    console.log(
      "\nNext: commit .claude/ in that repo, and for Claude Code on the web/mobile add FACTORY_URL and\n" +
        "FACTORY_HOOK_TOKEN as environment variables in the cloud environment's settings.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
