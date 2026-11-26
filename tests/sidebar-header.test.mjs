import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const host = new Map([
  ["gpui-kit", "export class View {}; export const div = null, image = null, svg = null;"],
  ["gpui-base", "export const h_flex = null, v_flex = null, Input = null, InputState = null, Popover = null, Popup = null, ScrollHandle = null;"],
  ["herdr", `
    export const { exec, hc, focused, layout, machines, notify, panes, run, setShared, shared,
      terminals, window } = globalThis.herdrTestHost;
    export const agents = null, checking = null, closeOverlay = null, nextCommand = null, props = null,
      openOverlay = null, settings = null, setAgentOrder = null, spaces = null, theme = null, updates = null;
  `],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!host.has(specifier)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(host.get(specifier))}`, shortCircuit: true };
  },
});

const time = "2026-11-23T02:35:37.958Z";
const statusMs = Date.parse(time);
let address = "t1";
let active = true;
const terminal = { address, state: "live", turn: 1, report: { app: "codex", state: "working" } };
const settings = new Map([["agent-ring.alerts", { focusedPane: true }]]);
let alerts;
let files;
let fixture;
let executedOn;
let shownTerminals;
let dispatch;

globalThis.herdrTestHost = {
  exec: (program, args, options = {}) => {
    executedOn = options.on ?? null;
    return {
      code: 0,
      stdout: execFileSync(program, args, {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, TEST_CODEX_FILES: files.join("\n") },
      }),
    };
  },
  hc: ([, target]) => {
    const entry = (shownTerminals ?? [terminal]).find(entry => entry.address === target);
    return {
      code: 0,
      stdout: JSON.stringify({
        state: entry.state, turn: entry.turn, status: entry.report, status_ms: statusMs,
        foreground: entry.report.app === "codex" ? { pid: 123 } : null,
      }),
    };
  },
  focused: () => ({ terminal: address, tab: "tab" }),
  layout: () => ({ toast: "good-agent-notifications" }),
  machines: () => [{ name: null, layout: "ready" }],
  notify: alert => alerts.push(alert),
  panes: () => (shownTerminals ?? [terminal]).map(entry => ({ tab: "tab", terminal: entry.address })),
  run: (command, args) => dispatch(command, args),
  setShared: (key, value) => settings.set(key, value),
  shared: key => settings.get(key),
  terminals: () => shownTerminals ?? [terminal],
  window: () => ({ active }),
};
const { default: WorkspaceChrome } = await import("../mods/good-agent-sidebar-header/main.js");
const { Agents, resolvedStatus, resolvedAgents } = await import("../mods/good-agent-sidebar/views/agents.js");
const { resolvedPaneStatus } = await import("../mods/good-agent-tab-bar/main.js");
const { agentNotice } = await import("../mods/good-agent-notifications/toast.js");
hooks.deregister();
delete globalThis.herdrTestHost;

const newChrome = () => {
  const chrome = new WorkspaceChrome();
  chrome.pendingDone = new Map();
  chrome.heldDone = new Map();
  return chrome;
};

const completed = { type: "task_complete", completed_at: Math.floor(statusMs / 1000) };
const interrupted = { ...completed, type: "turn_aborted", reason: "interrupted" };

test("a native remote completion toast combines session title and location", () => {
  const terminal = {
    address: "test-host/t2", title: "Claude Code", program: { name: "Claude Code" },
    report: { app: "claude-code", state: "done", title: "Remote session" },
  };
  const notification = {
    title: "Claude Code finished", body: "Workspace / Review", level: "info",
    action: { name: "agent.focus", args: { terminal: terminal.address } },
  };
  assert.deepEqual(agentNotice(notification, terminal), {
    heading: "Claude Code finished", machine: "test-host",
    session: "Remote session", place: "Workspace / Review", reason: "",
  });
  terminal.report.title = null;
  assert.equal(agentNotice(notification, terminal).session, "");
  assert.equal(agentNotice(notification, terminal).place, "Workspace / Review");
  terminal.title = "Named remote terminal";
  assert.equal(agentNotice(notification, terminal).session, "Named remote terminal");
});

for (const { name, outcome, events, subagent, source, remote, timestampOffsetMs = 0, expectAlert, toast, held, inactive } of [
  { name: "interrupt with an open subagent transcript", outcome: interrupted, subagent: true, expectAlert: false },
  { name: "interrupt without completed_at", outcome: { ...interrupted, completed_at: undefined }, expectAlert: false },
  { name: "remote interrupt with delayed core status", outcome: { ...interrupted, completed_at: undefined }, remote: true, timestampOffsetMs: -25_000, expectAlert: false },
  { name: "interrupt followed by a new task start", events: [interrupted, { type: "task_started" }], expectAlert: false },
  { name: "remote interrupt followed by a new task start", events: [interrupted, { type: "task_started" }], remote: true, expectAlert: false },
  { name: "side conversation while an older main task is still running", events: [{ type: "task_started" }], timestampOffsetMs: -60_000, expectAlert: false },
  { name: "side completion after the main task already completed", outcome: { ...completed, completed_at: Math.floor((statusMs - 60_000) / 1000) }, timestampOffsetMs: -60_000, expectAlert: false },
  { name: "remote completion with delayed core status", outcome: { ...completed, completed_at: Math.floor((statusMs - 25_000) / 1000) }, remote: true, timestampOffsetMs: -25_000, expectAlert: true },
  { name: "completion with an open subagent transcript", outcome: completed, subagent: true, expectAlert: true },
  { name: "interrupt in an older CLI transcript", outcome: interrupted, source: { source: "cli" }, expectAlert: false },
  { name: "completion after an earlier interrupt", outcome: completed, expectAlert: true },
  { name: "a held native toast is posted once its turn completes", outcome: completed, held: true, inactive: true, expectAlert: true, toast: true },
  { name: "a held native toast for another turn stays quiet", outcome: completed, held: "older", inactive: true, expectAlert: true, toast: false },
  { name: "an unconfirmed completion with no held toast stays quiet", outcome: interrupted, inactive: true, expectAlert: false },
]) {
  test(name, async t => {
    active = !inactive;
    t.after(() => { active = true; });
    // The person is looking at another pane, so a confirmed turn leaves its marker.
    address = "t9";
    terminal.address = remote ? "remote-host/t1" : "t1";
    fixture = mkdtempSync(join(tmpdir(), "herdr-turn-outcome-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const sessions = join(fixture, "sessions", "2026", "11", "23");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(fixture, "lsof"), '#!/bin/sh\nprintf "%s\\n" "$TEST_CODEX_FILES"\n', { mode: 0o755 });

    function transcript(name, origin, events) {
      const path = join(sessions, `rollout-${name}.jsonl`);
      const eventTime = new Date(statusMs + timestampOffsetMs).toISOString();
      const lines = [{ type: "session_meta", payload: origin },
        ...events.map(payload => ({ timestamp: eventTime, type: "event_msg", payload }))];
      writeFileSync(path, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
      return `n${path}`;
    }

    files = [transcript("main", source ?? { thread_source: "user" }, events ??
      (name === "completion after an earlier interrupt" ? [interrupted, { type: "task_started" }, outcome] : [outcome]))];
    if (subagent) files.push(transcript("child", { thread_source: "subagent" }, [completed]));

    alerts = [];
    settings.delete("agent-ring.unreadDone");
    terminal.turn = 1;
    terminal.report = { app: "codex", state: "working" };
    const chrome = newChrome();
    const tasks = [];
    const cx = { spawn: task => tasks.push(task()) };
    chrome.observeAgents(cx);
    if (held === "older") chrome.holdDone(terminal.address);
    terminal.turn++;
    terminal.report = { app: "codex", state: "idle" };
    if (held === true) chrome.holdDone(terminal.address);
    chrome.observeAgents(cx);
    await Promise.all(tasks);

    assert.deepEqual(alerts.map(alert => alert.title), (toast ?? expectAlert) ? ["codex finished"] : []);
    assert.equal(Boolean(settings.get("agent-ring.unreadDone")?.[terminal.address]), expectAlert);
    const expectedStatus = expectAlert ? "done" : name.includes("older main task") || name.includes("new task start") ? "working" : "idle";
    assert.deepEqual(settings.get("agent-ring.turnStatus")?.[terminal.address], { turn: terminal.turn, status: expectedStatus });
    assert.equal(executedOn, remote ? "remote-host" : null);
  });
}

test("native done is downgraded only by a resolution for the same turn", () => {
  const all = [{ address: "t1", turn: 7 }];
  const working = { t1: { turn: 7, status: "working" } };
  assert.equal(resolvedStatus("t1", "done", all, working), "working");
  assert.equal(resolvedStatus("t1", "done", all, { t1: { turn: 6, status: "idle" } }), "done");
  assert.equal(resolvedStatus("t1", "working", all, working), "working");

  const turns = new Map([["t1", 7]]);
  assert.equal(resolvedPaneStatus({ terminal: "t1", status: "done" }, turns, working, {}), "working");
  assert.equal(resolvedPaneStatus({ terminal: "t1", status: "idle" }, turns, working, { t1: true }), "done");
});

test("a focused pane's completion reads idle, like the look it already has", () => {
  const all = [{ address: "t1", turn: 7 }, { address: "t2", turn: 7 }];
  const native = [
    { address: "t1", status: "done", focused: true },
    { address: "t2", status: "done", focused: false },
  ];
  assert.deepEqual(resolvedAgents(native, all, null, {}).map(agent => agent.status), ["idle", "done"]);
  assert.deepEqual(resolvedAgents(native, all, null, { t1: true }).map(agent => agent.status), ["idle", "done"]);

  const turns = new Map([["t1", 7], ["t2", 7]]);
  assert.equal(resolvedPaneStatus({ terminal: "t1", status: "done", focused: true }, turns, null, {}), "idle");
  assert.equal(resolvedPaneStatus({ terminal: "t2", status: "done", focused: false }, turns, null, {}), "done");
  assert.equal(resolvedPaneStatus({ terminal: "t1", status: "done", focused: true }, turns, { t1: { turn: 7, status: "working" } }, {}), "working");
});

test("a sidebar click acknowledges only the selected completion in the current tab", async t => {
  const local = { address: "t1", state: "live", turn: 1, report: { app: "pi", state: "working" } };
  const remote = {
    address: "test-host/t2", state: "live", turn: 1, labels: { where: "Workspace / 2" },
    program: { name: "Pi" }, report: { app: "pi", state: "working", title: "Remote session" },
  };
  // The person is looking at another pane: neither completion is seen.
  address = "t9";
  shownTerminals = [local, remote];
  alerts = [];
  settings.delete("agent-ring.unreadDone");
  t.after(() => {
    shownTerminals = undefined;
    dispatch = undefined;
    settings.delete("agent-ring.unreadDone");
  });

  const chrome = newChrome();
  const tasks = [];
  const cx = { spawn: task => tasks.push(task()) };
  chrome.observeAgents(cx);
  for (const entry of shownTerminals) {
    entry.turn++;
    entry.report.state = "idle";
  }
  chrome.observeAgents(cx);
  await Promise.all(tasks);

  assert.deepEqual(settings.get("agent-ring.unreadDone"), { t1: true, "test-host/t2": true });
  assert.deepEqual(alerts.find(alert => alert.action.args.terminal === remote.address), {
    title: "Pi finished",
    body: "Remote session\nWorkspace",
    level: "info",
    action: { name: "agent.focus", args: { terminal: remote.address } },
  });

  const commands = [];
  const acknowledge = "good-agent-sidebar-header.ring-read/test-host/t2";
  dispatch = (command, args) => {
    commands.push([command, args]);
    if (command === acknowledge) chrome.acknowledgeDone(remote.address);
  };
  Agents.prototype.focusAgent({ address: remote.address, pane: "remote-pane" });
  assert.deepEqual(commands, [[acknowledge, undefined], ["pane.focus", { pane: "remote-pane" }]]);
  assert.deepEqual(settings.get("agent-ring.unreadDone"), { t1: true });
});

test("a pane the person is looking at is not marked done", async t => {
  const local = { address: "t1", state: "live", turn: 1, report: { app: "pi", state: "working" } };
  const away = { address: "t2", state: "live", turn: 1, report: { app: "pi", state: "working" } };
  address = local.address;
  shownTerminals = [local, away];
  alerts = [];
  settings.delete("agent-ring.unreadDone");
  t.after(() => {
    shownTerminals = undefined;
    settings.delete("agent-ring.unreadDone");
  });

  const chrome = newChrome();
  const tasks = [];
  const cx = { spawn: task => tasks.push(task()) };
  chrome.observeAgents(cx);
  for (const entry of shownTerminals) {
    entry.turn++;
    entry.report.state = "idle";
  }
  chrome.observeAgents(cx);
  await Promise.all(tasks);

  // The focused pane needs no marker; the other pane in the tab keeps its own.
  assert.deepEqual(settings.get("agent-ring.unreadDone"), { t2: true });
});

test("looking at a finished pane acknowledges only that pane's completion", async t => {
  t.after(() => {
    shownTerminals = undefined;
    settings.delete("agent-ring.unreadDone");
  });

  for (const word of ["idle", "done"]) {
    const local = { address: "t1", state: "live", turn: 2, report: { app: "codex", state: word } };
    const remote = { address: "test-host/t2", state: "live", turn: 2, report: { app: "pi", state: "done" } };
    address = local.address;
    shownTerminals = [local, remote];
    alerts = [];
    settings.set("agent-ring.unreadDone", { t1: true, "test-host/t2": true });

    const chrome = newChrome();
    const pending = {};
    chrome.pendingDone.set(local.address, pending);
    const tasks = [];
    const cx = { spawn: task => tasks.push(task()) };
    chrome.observeAgents(cx);
    await Promise.all(tasks);

    assert.deepEqual(settings.get("agent-ring.unreadDone"), { "test-host/t2": true });
    assert.equal(pending.acknowledged, true);
  }
});
