// Turns a Claude Code hook payload (stdin JSON, forwarded as the request body) plus the
// X-Factory-* headers added by hooks/factory-report.sh into a session update.

import type { SessionStatus, SessionUpdate } from "./db.ts";

const MAX_TEXT = 600;

function clip(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

function statusFor(event: string, payload: Record<string, unknown>): SessionStatus | undefined {
  switch (event) {
    case "SessionStart":
      return "your_turn";
    case "UserPromptSubmit":
      return "working";
    case "Stop":
      return "your_turn";
    case "Notification":
      // idle_prompt just means "still waiting for you after Stop"; everything else
      // (permission prompts, questions) means Claude is blocked on you.
      return payload.notification_type === "idle_prompt" ? "your_turn" : "needs_you";
    case "SessionEnd":
      return "ended";
    default:
      return undefined;
  }
}

export function parseHook(
  payload: Record<string, unknown>,
  header: (name: string) => string | undefined,
): SessionUpdate | null {
  const id = typeof payload.session_id === "string" ? payload.session_id : null;
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
  if (!id || !event) return null;
  const h = (name: string) => header(`x-factory-${name}`)?.trim() || null;
  return {
    id,
    event,
    status: statusFor(event, payload),
    url: h("session-url"),
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    repo: h("repo"),
    branch: h("branch"),
    host: h("host"),
    featureHint: h("feature"),
    prompt: event === "UserPromptSubmit" ? clip(payload.prompt) : null,
    message:
      event === "Notification"
        ? clip(payload.message)
        : event === "Stop"
          ? clip(payload.last_assistant_message)
          : null,
  };
}
