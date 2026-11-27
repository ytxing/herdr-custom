import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// lastInput() asks hc for the terminal, then runs its reader script against the real database.
let terminal;
const host = new Map([
  ["gpui-kit", "export class View {}; export const div = () => null; export const image = () => null;"],
  ["gpui-base", "export const h_flex = () => null, v_flex = () => null;"],
  ["herdr", `
    export const { appHome, checking, closeOverlay, exec, hc, home, props, run, shared, terminals, theme, window } =
      globalThis.opencodeTestHost;
  `],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!host.has(specifier)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(host.get(specifier))}`, shortCircuit: true };
  },
});

let dataHome;
globalThis.opencodeTestHost = {
  appHome: () => "/herdr",
  checking: () => false,
  closeOverlay: () => null,
  exec: (program, args, options = {}) => {
    calls.push({ program, args, options });
    return { code: 0, stdout: execFileSync(program, args, { encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: dataHome } }).trimEnd() };
  },
  hc: () => ({ code: 0, stdout: JSON.stringify(terminal) }),
  home: () => "/Users/test",
  props: () => ({}),
  run: () => null,
  shared: key => settings.get(key),
  terminals: () => [terminal],
  theme: () => ({}),
  window: () => ({ platform: "macos" }),
};
const { lastInput } = await import("../mods/good-agent-notifications/main.js");
hooks.deregister();
delete globalThis.opencodeTestHost;

let calls;
const settings = new Map();
let sqlite = true;
try { execFileSync("sqlite3", ["--version"]); } catch { sqlite = false; }

function database(t, schema) {
  const fixture = mkdtempSync(join(tmpdir(), "herdr-opencode-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  dataHome = join(fixture, "share");
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const db = join(dataHome, "opencode", "opencode.db");
  const sql = (...statements) => execFileSync("sqlite3", [db], { input: statements.join("\n"), encoding: "utf8" });
  // OpenCode 2.4 keeps the user's text on the message itself; before, on the message's text parts.
  if (schema === "v2") {
    sql("CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, time_created integer, data text);");
    for (const [id, text, at] of [["ses_login", "first prompt", 10], ["ses_login", "second prompt", 20], ["ses_docs", "docs prompt", 30]])
      sql(`INSERT INTO session_message VALUES ('m-${id}-${at}', '${id}', 'user', ${at}, '{"text":"${text}"}');`);
  } else {
    sql("CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, data text);",
      "CREATE TABLE part (message_id text, session_id text, time_created integer, data text);");
    for (const [id, text, at] of [["ses_login", "first prompt", 10], ["ses_login", "second prompt", 20], ["ses_docs", "docs prompt", 30]])
      sql(`INSERT INTO message VALUES ('m-${id}-${at}', '${id}', ${at}, '{"role":"user"}');`,
        `INSERT INTO part VALUES ('m-${id}-${at}', '${id}', ${at}, '{"type":"text","text":"${text}"}');`);
  }
}

const opencode = (records, argv = ["opencode"]) => ({
  foreground: { pid: 123, argv }, status: { app: "opencode", state: "idle", title: "Fix login" }, records,
});

for (const schema of ["v2", "old"]) {
  test(`OpenCode: the session of the terminal's 7501 record, read from its ${schema} schema`, { skip: !sqlite && "no sqlite3" }, async t => {
    database(t, schema);
    calls = [];

    // One record: its key is the session.
    terminal = opencode({ ses_login: { app: "opencode", state: "idle", title: "Fix login" } });
    assert.equal(await lastInput("t1"), "second prompt");
    assert.deepEqual(calls.at(-1).args.slice(2), ["agent-ring", "123", "opencode", "ses_login"]);
    assert.equal(calls.at(-1).options.on, null);

    // Several records: the one whose title matches the terminal's status.
    terminal = opencode({ ses_docs: { state: "idle", title: "Write docs" }, ses_login: { state: "idle", title: "Fix login" } });
    assert.equal(await lastInput("t1"), "second prompt");

    // Several records and no matching title: the first.
    terminal = opencode({ ses_docs: { state: "idle", title: "Write docs" }, ses_login: { state: "idle", title: "Fix login" } });
    terminal.status.title = "Renamed since";
    assert.equal(await lastInput("t1"), "docs prompt");

    // A record on a remote machine is read there.
    terminal = opencode({ ses_login: { state: "idle", title: "Fix login" } });
    assert.equal(await lastInput("box/t1"), "second prompt");
    assert.equal(calls.at(-1).options.on, "box");
  });

  test(`OpenCode: without a record, the session the sidebar header remembered, else --session (${schema})`, { skip: !sqlite && "no sqlite3" }, async t => {
    database(t, schema);
    t.after(() => settings.clear());

    // Idle again, the report is gone: the header wrote down the id while the agent worked.
    terminal = opencode(undefined);
    settings.set("agent-ring.sessions", { t1: "ses_login" });
    assert.equal(await lastInput("t1"), "second prompt");
    settings.set("agent-ring.sessions", { "box/t1": "ses_login" });
    assert.equal(await lastInput("box/t1"), "second prompt");
    assert.equal(calls.at(-1).options.on, "box");

    // Nothing remembered: --session names the session.
    settings.clear();
    terminal = opencode(undefined, ["opencode", "--session", "ses_login"]);
    assert.equal(await lastInput("t1"), "second prompt");

    // Without either there is nothing to read.
    terminal = opencode(undefined);
    assert.equal(await lastInput("t1"), "");
    // A session id with stray characters is refused, not spliced into the query.
    settings.set("agent-ring.sessions", { t1: "ses_x'; drop table session_message --" });
    assert.equal(await lastInput("t1"), "");
  });
}
