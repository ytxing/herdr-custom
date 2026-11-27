import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const element = `
  const element = (type) => {
    const target = { type };
    const proxy = new Proxy(target, { get: (object, key) => key in object ? object[key] : () => proxy });
    return proxy;
  };
`;
const host = new Map([
  ["gpui-kit", `${element}
    export class View {};
    export const div = () => element("div"), image = () => element("image"), svg = () => element("svg");
  `],
  ["gpui-base", `${element}
    export const h_flex = () => element("h_flex"), v_flex = () => element("v_flex");
  `],
  ["herdr", `
    export const { appHome, checking, closeOverlay, exec, hc, home, props, run, shared,
      terminals, theme, window } = globalThis.herdrToastTestHost;
  `],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!host.has(specifier)) return nextResolve(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(host.get(specifier))}`, shortCircuit: true };
  },
});

let notification;
let terminal;
let sharedValues;
let externalCalls;
let closeCalls;
let runCalls;

globalThis.herdrToastTestHost = {
  appHome: () => "/herdr",
  checking: () => false,
  closeOverlay: id => closeCalls.push(id),
  exec: (program, args) => {
    externalCalls.push([program, args]);
    return { code: 1, stdout: "", stderr: "" };
  },
  hc: () => ({
    code: 0,
    stdout: JSON.stringify({
      state: terminal.state, turn: terminal.turn, status: terminal.report, status_ms: 0,
      foreground: { pid: 123 },
    }),
  }),
  home: () => "/Users/test",
  props: () => notification,
  run: (command, args) => runCalls.push([command, args]),
  shared: key => sharedValues[key],
  terminals: () => [terminal],
  theme: () => ({}),
  window: () => ({ platform: "macos" }),
};
const { default: AgentRingToast } = await import("../mods/good-agent-notifications/main.js");
hooks.deregister();
delete globalThis.herdrToastTestHost;

for (const { name, resolution, shown, resolutionTurn = 2, title, app = "codex" } of [
  { name: "a Codex toast waits outside its overlay until the turn holds", resolution: "idle", shown: false },
  { name: "a Codex toast waits while its turn is unresolved", resolution: null, shown: false },
  { name: "a Codex toast waits out a resolution for another turn", resolution: "done", resolutionTurn: 1, shown: false },
  { name: "a Codex toast shows and forwards once its turn holds", resolution: "done", shown: true },
  { name: "a Codex toast that is not a completion is shown", resolution: null, title: "Codex needs you", shown: true },
  { name: "another agent's toast is shown without waiting", resolution: null, app: "pi", shown: true },
]) test(name, async () => {
  terminal = { address: "t1", state: "live", turn: 2, report: { app, state: "done" } };
  sharedValues = {
    "agent-ring.turnStatus": resolution ? { t1: { turn: resolutionTurn, status: resolution } } : {},
  };
  notification = {
    title: "Codex finished", body: "Workspace", level: "info", overlay: "toast-1",
    action: { name: "agent.focus", args: { terminal: "t1" } },
  };
  if (title) notification.title = title;
  externalCalls = [];
  closeCalls = [];
  runCalls = [];
  const toast = new AgentRingToast();
  const tasks = [];
  const cx = { spawn: task => tasks.push(task()), notify: () => {} };
  toast.init({}, cx);
  const rendered = toast.render(cx);
  await Promise.all(tasks);

  assert.deepEqual(closeCalls, shown ? [] : ["toast-1"]);
  assert.deepEqual(runCalls, shown ? [] : [["good-agent-sidebar-header.ring-hold/t1", undefined]]);
  assert.equal(rendered.type, shown ? "h_flex" : "div");
  if (shown) assert.ok(externalCalls.length > 0);
  else assert.deepEqual(externalCalls, []);
});

test("a banner line that opens with a bracket reaches the notifier escaped", async () => {
  terminal = {
    address: "t1", state: "live", turn: 2, title: "OpenCode",
    report: { app: "opencode", state: "blocked", title: "[WIP] Session", msg: "[Image 1] Waiting for your answer" },
  };
  notification = {
    title: "OpenCode needs you", body: "Session", level: "error", overlay: "toast-1",
    action: { name: "agent.focus", args: { terminal: "t1" } },
  };
  externalCalls = [];
  const toast = new AgentRingToast();
  const tasks = [];
  toast.init({}, { spawn: task => tasks.push(task()), notify: () => {} });
  await Promise.all(tasks);

  const sent = externalCalls.filter(([program]) => program.endsWith("terminal-notifier"));
  assert.ok(sent.length > 0);
  for (const [, args] of sent) {
    assert.equal(args[args.indexOf("-message") + 1], "\\[Image 1] Waiting for your answer");
    assert.equal(args[args.indexOf("-subtitle") + 1], "\\[WIP] Session");
    assert.equal(args[args.indexOf("-title") + 1], "OpenCode needs you");
  }
});
