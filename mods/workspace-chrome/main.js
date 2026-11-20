import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, focused, layout, machines, nextCommand, notify, panes, props, run, setShared, shared, terminals, theme, updates, window } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const RING_READ = /^ring-read\/((?:[a-z0-9][a-z0-9_.-]*\/)?t[a-z0-9]+)$/;

export default class WorkspaceChrome extends View {
  init(config, cx) {
    if (config?.footer || checking()) return;
    cx.spawn(async () => {
      for (;;) {
        const acknowledge = RING_READ.exec(await nextCommand());
        if (acknowledge) this.acknowledgeDone(acknowledge[1]);
      }
    });
  }

  observeVisibleAgents(cx) {
    if (layout()?.toast !== "agent-ring-toast") {
      this.previousView = undefined;
      return;
    }

    const focus = focused();
    const address = focus?.shown ?? focus?.terminal;
    const active = window()?.active;
    const previous = this.previousView;
    const all = new Map(terminals().map(term => [term.address, term]));
    const allPanes = panes();
    const visible = new Set(allPanes.filter(pane => pane.tab === focus?.tab).map(pane => pane.terminal));
    if (address) visible.add(address);

    const reports = new Map();
    const alerts = [];
    for (const id of visible) {
      const terminal = all.get(id);
      if (!terminal?.report) continue;
      const { turn, report: { app, state } } = terminal;
      const before = active && previous?.active && previous.reports.get(id);
      reports.set(id, { turn, state });
      if (!before) continue;
      // The Core turn also advances on a direct Working → Idle report.
      // Codex startup advances its first turn to Idle before receiving a prompt.
      const codexStartup = app === "codex" && turn === 1 && state === "idle";
      const completed = !codexStartup && (state === "done" || state === "idle") && turn > before.turn;
      const needsUser = id === address && (state === "blocked" || state === "error") && state !== before.state;
      if (completed || needsUser) alerts.push({ terminal, completed, focused: id === address });
    }
    this.previousView = { address, pane: focus?.pane, active, reports };

    const unread = shared("agent-ring.unreadDone") ?? {};
    const toClear = new Set();
    const readyMachines = new Set(machines().filter(machine => machine.layout === "ready").map(machine => machine.name));
    for (const id of Object.keys(unread)) {
      const terminal = all.get(id);
      const machine = id.includes("/") ? id.split("/")[0] : null;
      if (terminal ? terminal.state !== "live" || terminal.report?.state === "working" : readyMachines.has(machine)) {
        toClear.add(id);
      }
    }
    // Closing a pane can move focus without an explicit refocus.
    if (unread[address] && active && previous && previous.address !== address &&
        (!previous.pane || allPanes.some(pane => pane.pane === previous.pane))) toClear.add(address);

    if (toClear.size || alerts.length) cx.spawn(() => {
      const next = { ...shared("agent-ring.unreadDone") };
      for (const id of toClear) delete next[id];
      for (const { terminal, completed } of alerts) if (completed) next[terminal.address] = true;
      if (toClear.size || alerts.some(alert => alert.completed)) setShared("agent-ring.unreadDone", next);
      for (const alert of alerts) this.notifyAgent(alert);
    });
  }

  notifyAgent({ terminal, completed: finished, focused }) {
    if (focused && shared("agent-ring.alerts")?.focusedPane !== true) return;
    const name = terminal.program?.name || terminal.report?.app || "Agent";
    const session = terminal.report?.title || terminal.title || "";
    const place = (terminal.labels?.where ?? terminal.where ?? "").replace(/\s*\/\s*\d+$/, "");
    const reason = finished ? "" : terminal.report?.msg?.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "Needs your attention";
    notify({
      title: name + (finished ? " finished" : " needs you"),
      body: [session, place].filter(Boolean).join("\n") + (reason ? `\n${reason}` : ""),
      level: finished ? "info" : "error",
      action: { name: "agent.focus", args: { terminal: terminal.address } },
    });
  }

  acknowledgeDone(address) {
    const unread = shared("agent-ring.unreadDone");
    if (!unread?.[address]) return;
    const next = { ...unread };
    delete next[address];
    setShared("agent-ring.unreadDone", next);
  }

  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render(cx) {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/workspace-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    if (!checking()) this.observeVisibleAgents(cx);
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
