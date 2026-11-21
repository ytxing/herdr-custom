import { exec, hc } from "herdr";

// Read only outcome metadata from the foreground agent's session on its own machine.
const readOutcome = String.raw`
  pid=$1 app=$2
  if [ "$app" = pi ]; then
    file=$(jq -er '.file' "$HOME/.cache/agent-ring/pi/$pid.json" 2>/dev/null) || exit 0
  elif [ "$app" = claude ]; then
    config="$CLAUDE_CONFIG_DIR"
    [ -n "$config" ] || config="$HOME/.claude"
    id=$(jq -er --argjson pid "$pid" 'select(.pid == $pid and .kind == "interactive") | .sessionId' "$config/sessions/$pid.json" 2>/dev/null) || exit 0
    case "$id" in ''|*[!a-fA-F0-9-]*) exit 0 ;; esac
    file=$(find "$config/projects" -maxdepth 2 -type f -name "$id.jsonl" 2>/dev/null)
  else
    file=$(lsof -a -p "$pid" -Fn 2>/dev/null | awk '/^n.*\/sessions\/.*\/rollout-.*[.]jsonl$/ { print substr($0, 2) }' | sort -u)
  fi
  [ -f "$file" ] || exit 0
  tail -n 200 "$file" | jq -Rc --arg app "$app" --arg session "$id" '
    fromjson? |
    if $app == "codex" then
      select(.type == "event_msg")
      | .payload
      | select(.type == "task_started" or .type == "task_complete" or .type == "turn_aborted")
      | {outcome: (if .type == "turn_aborted" and .reason == "interrupted" then "interrupted" else "other" end),
         time: ((.completed_at // 0) * 1000)}
    elif $app == "claude" then
      select(.sessionId == $session and .isSidechain == false and .isMeta != true)
      | select((.type == "user" or .type == "assistant") and .type == .message.role)
      | {outcome: (
           if .type == "assistant" and .isApiErrorMessage == true then "error"
           elif .type == "user" and (
             .message.content == [{type: "text", text: "[Request interrupted by user]"}]
             or .message.content == [{type: "text", text: "[Request interrupted by user for tool use]"}]
           ) then "interrupted" else "other" end),
         timestamp: .timestamp}
    else
      select(.type == "message" and (.message.role == "assistant" or .message.role == "user"))
      | {outcome: (if .message.stopReason == "aborted" then "interrupted"
                   elif .message.stopReason == "error" then "error" else "other" end),
         time: .message.timestamp}
    end
  ' | tail -n 1
`;

export async function turnOutcome(terminal) {
  const app = terminal.report.app === "claude-code" ? "claude" : terminal.report.app;
  if (!["codex", "pi", "claude"].includes(app)) return null;
  try {
    const result = await hc(["get", terminal.address, "--json"]);
    if (result.code !== 0) return null;
    const current = JSON.parse(result.stdout);
    const pid = current.foreground?.pid;
    if (current.state !== "live" || current.turn !== terminal.turn ||
        current.status?.app !== terminal.report.app ||
        !["done", "idle"].includes(current.status?.state)) return "stale";
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(current.status_ms)) return null;
    const machine = terminal.address.includes("/") ? terminal.address.split("/")[0] : null;
    const session = await exec("sh", ["-c", readOutcome, "turn-outcome", String(pid), app], {
      on: machine, timeout: 2000,
    });
    if (session.code !== 0 || !session.stdout.trim()) return null;
    const record = JSON.parse(session.stdout);
    const time = app === "claude" ? Date.parse(record.timestamp) : record.time;
    // Core and the transcript use the same machine clock. Codex rounds completed_at to seconds.
    return Number.isFinite(time) && Math.abs(time - current.status_ms) <= 2000 ? record.outcome : null;
  } catch {
    return null;
  }
}
