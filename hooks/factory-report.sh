#!/usr/bin/env bash
# Reports Claude Code session events to the Factory dashboard.
# Installed by `npm run install-hooks`. Needs FACTORY_URL and FACTORY_HOOK_TOKEN in the
# environment; without them it does nothing. It never blocks or fails your session.

payload=$(cat)
[ -n "$FACTORY_URL" ] && [ -n "$FACTORY_HOOK_TOKEN" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0

dir=${CLAUDE_PROJECT_DIR:-$PWD}
branch=$(git -C "$dir" branch --show-current 2>/dev/null)
# Strip credentials from the remote URL before it leaves the machine.
repo=$(git -C "$dir" remote get-url origin 2>/dev/null | sed -E 's#://[^@/]*@#://#; s#^[^@/:]+@##')

if [ -n "$CLAUDE_CODE_REMOTE_SESSION_ID" ]; then
  # Claude Code on the web / mobile: link straight to the session.
  url="https://claude.ai/code/session_${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}"
  host="cloud"
else
  url=${FACTORY_SESSION_URL:-}
  host=$(hostname -s 2>/dev/null || hostname)
fi

send() {
  printf '%s' "$payload" | curl -sS -o /dev/null --connect-timeout 2 -m 4 \
    -X POST "${FACTORY_URL%/}/api/hooks" \
    -H "Authorization: Bearer $FACTORY_HOOK_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Factory-Branch: $branch" \
    -H "X-Factory-Repo: $repo" \
    -H "X-Factory-Session-Url: $url" \
    -H "X-Factory-Host: $host" \
    -H "X-Factory-Feature: ${FACTORY_FEATURE:-}" \
    --data-binary @-
}

case "$payload" in
  # The session is closing; send before the process goes away.
  *'"SessionEnd"'*) send >/dev/null 2>&1 ;;
  # Everything else: fire and forget so prompts are never slowed down.
  *) (send >/dev/null 2>&1 &) ;;
esac
exit 0
