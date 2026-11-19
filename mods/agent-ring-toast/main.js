import { appHome, checking, exec, hc, home, props, shared, terminals, window } from "herdr";
import Toast from "./toast.js";

const TERMINAL = /^(?:[a-z0-9][a-z0-9_.-]*\/)?t[a-z0-9]+$/;
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";

const readCodexInput = `
  files=$(lsof -a -p "$1" -Fn 2>/dev/null | awk '/^n\\/.*\\/sessions\\/.*\\/rollout-.*\\.jsonl$/ {print substr($0, 2)}' | sort -u)
  case "$files" in ''|*'
'*) exit 0 ;; esac
  tail -c 1048576 "$files" | jq -Rsr '
    [split("\\n")[] | fromjson? | .payload
      | if .type == "user_message" then .message
        elif .role == "user" and ((.internal_chat_message_metadata_passthrough.content_item_kinds // []) | index("user.text")) != null
        then [.content[]? | select(.type == "input_text") | .text] | join(" ")
        else empty end
      | strings | gsub("[[:space:]]+"; " ") | select(test("[^ ]"))]
    | last // "" | if length > 160 then .[:160] + "…" else . end'
`;

async function lastInput(address) {
  try {
    const result = await hc(["get", address, "--json"]);
    if (result.code !== 0) return "";
    const terminal = JSON.parse(result.stdout);
    const pid = terminal.foreground?.pid;
    if (terminal.foreground?.name !== "codex" || !Number.isSafeInteger(pid) || pid <= 0) return "";
    const on = address.includes("/") ? address.split("/")[0] : null;
    const input = await exec("sh", ["-c", readCodexInput, "agent-ring", String(pid)], { on, timeout: 2000 });
    return input.code === 0 ? input.stdout.trim() : "";
  } catch {
    return "";
  }
}

function attentionMessage(terminal, state) {
  const reports = [terminal?.report, ...Object.values(terminal?.records ?? {})];
  for (const report of reports) {
    if (report?.state !== state || typeof report.msg !== "string") continue;
    const firstLine = report.msg.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (firstLine) return [...firstLine].length > 160 ? [...firstLine].slice(0, 160).join("") + "…" : firstLine;
  }
  if (state === "error") return "";
  const kind = reports.find(report => report?.state === "blocked" && report.kind)?.kind;
  if (kind === "permission") return "Approval required";
  if (kind === "auth") return "Sign-in required";
  if (kind === "question") return "Waiting for your answer";
  return "";
}

async function forward(notification) {
  const address = notification.action?.args?.terminal;
  if (notification.action?.name !== "agent.focus" || typeof address !== "string" || !TERMINAL.test(address)) return;
  const kind = notification.title?.endsWith(" needs you") ? "suspended"
    : notification.title?.endsWith(" finished") ? "done" : null;
  if (!kind) return;

  const config = shared("agent-ring.alerts") ?? {};
  const focus = `${quote(`${home()}/.local/bin/herdr-app`)} do agent.focus --terminal ${quote(address)}`;
  const terminal = terminals().find(entry => entry.address === address);
  const sessionTitle = [terminal?.report?.title, terminal?.title]
    .find(title => typeof title === "string" && title.trim());
  const machine = address.includes("/") ? address.split("/")[0] : null;
  const failed = kind === "suspended" && terminal?.report?.state === "error";
  const heading = failed ? notification.title.replace(/ needs you$/, " failed") : notification.title;
  const title = machine ? `${heading} @${machine}` : heading;
  const subtitle = sessionTitle?.replace(/\s+/g, " ").trim();
  const args = ["-title", title,
    "-group", `herdr-agent-ring/${address}`, "-activate", "dev.herdr.app", "-execute", focus];
  if (subtitle) args.push("-subtitle", subtitle);
  const modDirectory = `${appHome()}/mods/agent-ring-toast`;
  const tasks = [];
  if (config.banner !== false) {
    const notifier = `${modDirectory}/AgentRingHerdr.app/Contents/MacOS/terminal-notifier`;
    tasks.push((async () => {
      const detail = kind === "suspended" ? attentionMessage(terminal, failed ? "error" : "blocked") : await lastInput(address);
      const fallback = failed ? "Agent reported an error" : kind === "done" ? "Finished" : "Needs your attention";
      const bannerArgs = [...args, "-message", detail || fallback];
      try {
        if ((await exec(notifier, bannerArgs)).code === 0) return;
      } catch {
        // The dedicated sender may be unavailable.
      }
      await exec("terminal-notifier", bannerArgs);
    })());
  }
  if (config.sound !== false) {
    tasks.push(exec("node", [`${modDirectory}/sound.cjs`, kind,
      config.mode === "fixed" ? "fixed" : "random", address, config[kind] ?? ""]));
  }
  await Promise.allSettled(tasks);
}

export default class AgentRingToast extends Toast {
  init(_props, cx) {
    const notification = props() ?? {};
    if (!checking() && notification.title && window()?.platform === "macos") {
      cx.spawn(() => forward(notification));
    }
  }
}
