import { div } from "gpui-kit";
import { appHome, checking, closeOverlay, exec, hc, home, props, run, shared, terminals, window } from "herdr";
import Toast, { agentNotice, attentionMessage } from "./toast.js";

const TERMINAL = /^(?:[a-z0-9][a-z0-9_.-]*\/)?t[a-z0-9]+$/;
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
// terminal-notifier reads a line that opens with a bracket as markup and shows no line at all;
// a backslash before it shows the bracket.
const literal = (text) => text.replace(/^[[({<【]/, "\\$&");

export const readSessionInput = `
  pid=$1 app=$2 session=$3
  pattern= files= entry=
  case "$app" in
    codex) pattern='^n/.*[/]sessions/.*[/]rollout-.*[.]jsonl$' ;;
    pi)
      ref="$HOME/.cache/agent-ring/pi/$pid.json"
      if [ -f "$ref" ]; then
        snapshot=$(cat "$ref") || exit 0
        files=$(printf '%s' "$snapshot" | jq -er '.file') || exit 0
        entry=$(printf '%s' "$snapshot" | jq -er '.entry') || exit 0
      else
        # Older Pi extensions expose the transcript as an open file.
        pattern='^n/.*[.]jsonl$'
      fi
      ;;
    claude)
      id=$(jq -er --argjson pid "$pid" 'select(.pid == $pid and .kind == "interactive") | .sessionId' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$pid.json" 2>/dev/null) || exit 0
      case "$id" in ''|*[!a-fA-F0-9-]*) exit 0 ;; esac
      files=$(find "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -type f -name "$id.jsonl" 2>/dev/null)
      ;;
    opencode)
      case "$session" in ses_*) ;; *) exit 0 ;; esac
      case "$session" in *[!a-zA-Z0-9_]*) exit 0 ;; esac
      db="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
      [ -f "$db" ] || exit 0
      # OpenCode 2.4 keeps the user's text on the message itself; before, on its text parts.
      text=$(sqlite3 -readonly -json "$db" "SELECT json_extract(data,'$.text') AS text FROM session_message WHERE session_id='$session' AND type='user' ORDER BY time_created DESC LIMIT 1;" 2>/dev/null | jq -r '.[0].text // ""')
      [ -n "$text" ] || text=$(sqlite3 -readonly -json "$db" "SELECT json_extract(p.data,'$.text') AS text FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id='$session' AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text' ORDER BY m.time_created DESC,p.time_created ASC LIMIT 1;" 2>/dev/null | jq -r '.[0].text // ""')
      printf '%s\n' "$text"
      exit
      ;;
    *) exit 0 ;;
  esac
  if [ -n "$pattern" ]; then
    files=$(lsof -a -p "$pid" -Fn 2>/dev/null | awk -v pattern="$pattern" '$0 ~ pattern {print substr($0, 2)}' | sort -u)
  fi
  if [ "$app" = codex ]; then
    files=$(printf '%s\\n' "$files" | while IFS= read -r file; do
      [ -f "$file" ] || continue
      if head -n 1 "$file" | jq -e '
        .type == "session_meta" and
        (.payload.thread_source == "user" or
         (.payload.thread_source == null and .payload.source == "cli"))
      ' >/dev/null; then
        printf '%s\\n' "$file"
      fi
    done)
  fi
  case "$files" in ''|*'
'*) exit 0 ;; esac
  # macOS provides tail -r and Linux provides tac.
  if command -v tac >/dev/null 2>&1; then
    tac "$files"
  else
    tail -r "$files"
  fi | jq -Rn -r --arg app "$app" --arg entry "$entry" '
    def text: if type == "string" then . else [.[]? | select(.type == "text" or .type == "input_text") | .text] | join(" ") end;
    def userContent:
      if $app == "pi" then
        select(.type == "message" and .message.role == "user" and ($entry == "" or .id == $entry)) | .message.content
      elif $app == "claude" then
        select(.type == "user" and .isSidechain != true and .isMeta != true and .toolUseResult == null
          and .promptSource != "system" and (.origin.kind == null or .origin.kind == "human"))
        | .message.content | text | select(test("^<(local-command|bash)-(stdout|stderr)>") | not)
      else .payload |
        if .type == "user_message" then .message
        elif .role == "user" and ((.internal_chat_message_metadata_passthrough.content_item_kinds // []) | index("user.text")) != null
        then [.content[]? | select(.type == "input_text" or .type == "text")
          | select((.text | startswith("<image name=") and endswith(">")) or .text == "</image>" | not)]
        else empty end
      end;
    first(inputs | fromjson? | userContent | text | strings | gsub("[[:space:]]+"; " ") | select(test("[^ ]"))) // ""'
`;

export async function lastInput(address) {
  try {
    const result = await hc(["get", address, "--json"]);
    if (result.code !== 0) return "";
    const terminal = JSON.parse(result.stdout);
    const pid = terminal.foreground?.pid;
    const app = terminal.status?.app === "claude-code" ? "claude" : terminal.status?.app;
    if (!['codex', 'pi', 'claude', 'opencode'].includes(app) || !Number.isSafeInteger(pid) || pid <= 0) return "";
    const argv = terminal.foreground?.argv ?? [];
    const sessionFlag = argv.findIndex(arg => arg === "--session" || arg === "-s");
    // OpenCode reports its session's id as a 7501 record while it works; the sidebar header
    // keeps the last one it saw for a terminal, since the report is gone once the turn ends.
    const reported = Object.keys(terminal.records ?? {}).filter(key => key.startsWith("ses_"));
    const session = reported.find(key => terminal.records[key].title && terminal.records[key].title === terminal.status?.title) ??
      reported[0] ?? shared("agent-ring.sessions")?.[address] ?? (sessionFlag >= 0 ? argv[sessionFlag + 1] ?? "" : "");
    const on = address.includes("/") ? address.split("/")[0] : null;
    const input = await exec("sh", ["-c", readSessionInput, "agent-ring", String(pid), app, session], { on, timeout: 2000 });
    return input.code === 0 ? input.stdout : "";
  } catch {
    return "";
  }
}

async function notificationBody(address, terminal, kind, failed) {
  const detail = kind === "done" ? await lastInput(address)
    : attentionMessage(terminal, failed ? "error" : "blocked");
  const fallback = kind === "done" ? "Finished"
    : failed ? "Agent reported an error" : "Needs your attention";
  const text = [...(detail.replace(/\s+/g, " ").trim() || fallback)];
  return text.length > 160 ? text.slice(0, 160).join("") + "…" : text.join("");
}

async function agentImage(terminal, title) {
  const app = terminal?.report?.app ?? terminal?.program?.key;
  const iconName = {
    pi: "pi", codex: "codex", claude: "claude", "claude-code": "claude", opencode: "opencode",
  }[app] ?? /^(pi|codex|claude|opencode)\b/i.exec(title)?.[1].toLowerCase();
  if (!iconName) return null;
  const icon = `${appHome()}/icons/${iconName}.svg`;
  const cache = `${appHome()}/data/good-agent-notifications/banner-icons`;
  try {
    const result = await exec("sh", ["-c", `
      set -e
      mkdir -p "$1"
      image="$1/$2.png"
      if [ ! -s "$image" ] || [ "$3" -nt "$image" ]; then
        temporary=$(mktemp "$1/.icon.XXXXXX")
        trap 'rm -f "$temporary"' EXIT
        rsvg-convert -w 128 -h 128 "$3" -o "$temporary"
        mv -f "$temporary" "$image"
      fi
      printf '%s' "$image"
    `, "agent-ring", cache, iconName, icon], { timeout: 2000 });
    return result.code === 0 && result.stdout ? result.stdout : null;
  } catch {
    return null;
  }
}

async function forward(notification) {
  const address = notification.action?.args?.terminal;
  if (notification.action?.name !== "agent.focus" || typeof address !== "string" || !TERMINAL.test(address)) return;
  const failureTitle = notification.title?.endsWith(" failed");
  const kind = failureTitle || notification.title?.endsWith(" needs you") ? "suspended"
    : notification.title?.endsWith(" finished") ? "done" : null;
  if (!kind) return;

  const config = shared("agent-ring.alerts") ?? {};
  const app = quote(`${home()}/.local/bin/herdr-app`);
  const acknowledge = `${app} do ${quote(`good-agent-sidebar-header.ring-read/${address}`)}`;
  const focus = `${acknowledge}; ${app} do agent.focus --terminal ${quote(address)}`;
  const terminal = terminals().find(entry => entry.address === address);
  const { session, place, machine } = agentNotice(notification, terminal);
  const failed = failureTitle || (kind === "suspended" && terminal?.report?.state === "error");
  const heading = failed ? notification.title.replace(/ needs you$/, " failed") : notification.title;
  const title = (machine ? `${heading} @${machine}` : heading) || (kind === "done" ? "Agent finished" : "Agent needs your attention");
  const subtitle = session || place;
  const args = ["-title", literal(title),
    "-group", `herdr-agent-ring/${address}`, "-activate", "dev.herdr.app", "-execute", focus];
  if (subtitle) args.push("-subtitle", literal(subtitle));
  const modDirectory = `${appHome()}/mods/good-agent-notifications`;
  const tasks = [];
  if (config.banner !== false) {
    const notifier = `${modDirectory}/AgentRingHerdr.app/Contents/MacOS/terminal-notifier`;
    tasks.push((async () => {
      const [body, image] = await Promise.all([
        notificationBody(address, terminal, kind, failed),
        agentImage(terminal, notification.title),
      ]);
      const message = body || (kind === "done" ? "Finished" : failed ? "Agent reported an error" : "Needs your attention");
      const bannerArgs = ["-message", literal(message), ...args];
      const withImage = image ? [...bannerArgs, "-contentImage", `file://${encodeURI(image).replace(/#/g, "%23").replace(/\?/g, "%3F")}`] : bannerArgs;
      try {
        if ((await exec(notifier, withImage)).code === 0) return;
      } catch {
        // The dedicated sender may be unavailable.
      }
      await exec("terminal-notifier", image ? [...bannerArgs, "-contentImage", image] : bannerArgs);
    })());
  }
  if (config.sound !== false) {
    tasks.push(exec("node", [`${modDirectory}/sound.cjs`, kind,
      config.mode === "fixed" ? "fixed" : "random", address, config[kind] ?? ""]));
  }
  await Promise.allSettled(tasks);
}

// Herdr posts "Codex finished" for a side thread's report as readily as for the
// main turn's, and the sidebar header settles each turn against the main rollout.
// A toast that arrives first is closed at once, since an overlay left without
// content draws as an empty box, and the header posts it again once the turn holds.
function turnConfirmed(notification) {
  const address = notification.action?.args?.terminal;
  const terminal = terminals().find(entry => entry.address === address);
  if (!notification.title?.endsWith(" finished") || terminal?.report?.app !== "codex") return true;
  const resolution = shared("agent-ring.turnStatus")?.[address];
  return resolution?.turn === terminal.turn && resolution.status === "done";
}

export default class AgentRingToast extends Toast {
  init(_props, cx) {
    const notification = props() ?? {};
    if (checking() || !notification.title) return;
    if (!turnConfirmed(notification)) {
      // The overlay is not a place to wait: it has no content to wait with.
      run(`good-agent-sidebar-header.ring-hold/${notification.action.args.terminal}`);
      closeOverlay(notification.overlay);
      this.held = true;
      return;
    }
    if (window()?.platform === "macos") cx.spawn(() => forward(notification));
  }

  render(cx) {
    return this.held ? div() : super.render(cx);
  }
}
