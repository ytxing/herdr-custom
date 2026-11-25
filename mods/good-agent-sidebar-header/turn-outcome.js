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
  elif [ "$app" = codex ]; then
    # The foreground Codex can keep its subagents' transcripts open too.
    file=$(lsof -a -p "$pid" -Fn 2>/dev/null | awk '/^n.*\/sessions\/.*\/rollout-.*[.]jsonl$/ { print substr($0, 2) }' | sort -u |
      while IFS= read -r candidate; do
        [ -f "$candidate" ] || continue
        if head -n 1 "$candidate" | jq -e '
          .type == "session_meta" and
          (.payload.thread_source == "user" or
           (.payload.thread_source == null and .payload.source == "cli"))
        ' >/dev/null; then
          printf '%s\n' "$candidate"
        fi
      done)
  fi
  [ -f "$file" ] || exit 0
  tail -n 200 "$file" | jq -Rc --arg app "$app" --arg session "$id" '
    fromjson? |
    if $app == "codex" then
      select(.type == "event_msg")
      | select(.payload.type == "task_started" or .payload.type == "task_complete" or .payload.type == "turn_aborted")
      | {outcome: (if .payload.type == "task_complete" then "completed"
                   elif .payload.type == "task_started" then "stale"
                   elif .payload.reason == "interrupted" then "interrupted" else "stale" end),
         time: (.payload.completed_at | numbers * 1000 // null), timestamp}
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
    const exactTime = typeof record.time === "number";
    const time = exactTime ? record.time : Date.parse(record.time ?? record.timestamp);
    const tolerance = app === "codex" && (!exactTime || machine) ? 30_000 : 2_000;
    // Codex completed_at rounds to seconds; aborts and remote status delivery need more slack.
    return Number.isFinite(time) && Math.abs(time - current.status_ms) <= tolerance ? record.outcome : null;
  } catch {
    return null;
  }
}
