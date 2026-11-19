import { openSync, closeSync } from "node:fs";

// Keep Pi's active transcript discoverable from its foreground PID.
export default function (pi) {
  if (!process.env.HC_TERMINAL_ID) return;
  let fd;
  function close() {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  }
  pi.on("session_shutdown", close);
  pi.on("session_start", close);
  pi.on("agent_start", (_event, ctx) => {
    close();
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file) fd = openSync(file, "r");
    } catch { /* A new session may not have been saved yet. */ }
  });
  pi.on("agent_end", (_event, ctx) => {
    if (fd !== undefined) return;
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file) fd = openSync(file, "r");
    } catch { /* Session persistence may be disabled. */ }
  });
}
