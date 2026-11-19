import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Publish the active branch's user entry so the banner can read the original text.
export default function (pi) {
  if (!process.env.HC_TERMINAL_ID) return;
  const directory = join(homedir(), ".cache", "agent-ring", "pi");
  const ref = join(directory, process.pid + ".json");
  const temporary = ref + ".tmp";

  function clear() {
    try {
      rmSync(ref, { force: true });
      rmSync(temporary, { force: true });
    } catch (error) {
      console.warn("Agent Ring could not clear the Pi session reference:", error);
    }
  }
  function publish(_event, ctx) {
    const session = ctx.sessionManager;
    const entry = session.getBranch().findLast(item =>
      item.type === "message" && item.message.role === "user");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ file: session.getSessionFile(), entry: entry?.id }), { mode: 0o600 });
      renameSync(temporary, ref);
    } catch (error) {
      clear();
      console.warn("Agent Ring could not publish the Pi session reference:", error);
    }
  }
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("agent_end", publish);
}
