// A personal terminal menu: Herdr's pane items, with the right-click target
// shown as a small Menu/Pane switch instead of a long sentence.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, notify, theme, keys, terminals, panes, spaces, shared, setShared } from "herdr";

function icon(name) {
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

function items(p) {
  const tg = p?.target ?? {};
  const all = terminals();
  const term = all.find((t) => t.address === tg.terminal);
  const parent = term?.parent && all.find((t) => t.address === term.parent);
  const toProgram = term?.labels?.["herdr.right-click"] === "program";
  // A terminal shown outside a tab (a layout terminal block, a window) has no
  // pane to split, zoom or close.
  const inTab = panes().some((pane) => pane.pane === tg.pane);
  return [
    ...(inTab
      ? [
          { label: "Split right", command: "pane.split", args: { direction: "right", pane: tg.pane }, icon: "panel-right" },
          { label: "Split down", command: "pane.split", args: { direction: "down", pane: tg.pane }, icon: "layers" },
          { label: "Zoom", command: "pane.zoom", args: { pane: tg.pane }, icon: "square" },
          { label: "Move pane to tab", picker: true, icon: "layers", hint: ">" },
        ]
      : []),
    ...(term
      ? [
          // The short handle other Herdr agents use: hc read/send <address>.
          // The tagged form marks it as a terminal reference in agent messages.
          {
            label: "Copy reference",
            ref: true,
            terminal: term.address,
            value: shared("my-menu.copy-as") === "tagged" ? "tagged" : "raw",
            icon: "terminal",
          },
          { toggle: true, label: "Right-click", terminal: term.address, value: toProgram ? "program" : "menu" },
        ]
      : []),
    ...(parent
      ? [{ label: `Send back to ${parent.name || parent.address}`, command: "terminal.park", args: { terminal: term.address }, icon: "terminal" }]
      : []),
    ...(inTab ? [{ label: "Close pane", command: "pane.close", args: { pane: tg.pane }, icon: "x", divider: true }] : []),
  ];
}

export default class MyMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  pick(target, item) {
    closeOverlay(props()?.overlay);
    run("terminal.right_click", { terminal: item.terminal, to: target });
    // Once the program takes right-clicks, only Shift+right-click brings us back.
    if (target === "program")
      notify({
        title: "Right-click goes to the program",
        body: "Shift+right-click still opens this menu.",
      });
  }

  // Copy the terminal address in the chosen form: the bare handle agents pass
  // to hc read/send, or the tagged form they put in their messages.
  copyAs(terminal, format, cx) {
    setShared("my-menu.copy-as", format);
    cx?.write_to_clipboard(format === "tagged" ? `<hc>${terminal}</hc>` : terminal);
    closeOverlay(props()?.overlay);
  }

  choose(i, cx) {
    const it = items(props())[i];
    if (!it) return;
    const p = props();
    if (it.ref) {
      this.copyAs(it.terminal, it.value, cx);
    } else if (it.picker) {
      openOverlay({
        mod: "my-menu",
        kind: "popup",
        width: 260,
        height: 320,
        props: { tab: "pane", target: p.target, pick: "tab" },
      });
      closeOverlay(p.overlay);
    } else if (it.copy) {
      cx?.write_to_clipboard(it.copy);
      closeOverlay(p.overlay);
    } else if (it.toggle) {
      this.pick(it.value === "program" ? "menu" : "program", it);
    } else {
      closeOverlay(p.overlay);
      run(it.command, it.args);
    }
  }

  // The space's other tabs, in their order, with their numbers.
  otherTabs(target) {
    const tabId = panes().find((pane) => pane.pane === target?.pane)?.tab;
    const space = spaces().find((s) => s.tabs.some((tab) => tab.id === tabId));
    return (space?.tabs ?? [])
      .map((tab, index) => ({ tab, number: index + 1 }))
      .filter((entry) => entry.tab.id !== tabId);
  }

  // No pane.move command: park the terminal, then give it a pane in the chosen
  // tab, or in a new one. Each step lands after the core replies, so wait.
  moveTo(entry, cx) {
    const { target, overlay } = props();
    cx.spawn(async (cx) => {
      run("terminal.park", { terminal: target.terminal });
      for (let i = 0; i < 60; i++) {
        await cx.sleep(50);
        if (!panes().some((pane) => pane.terminal === target.terminal)) break;
      }
      // The core lists the pane-less terminal as running a moment later.
      await cx.sleep(350);
      if (entry.newTab) {
        run("terminal.keep", { terminal: target.terminal, place: "tab" });
      } else {
        run("tab.select", { id: entry.tab.id });
        await cx.sleep(100);
        run("terminal.keep", { terminal: target.terminal, place: "right" });
      }
      let moved = false;
      for (let i = 0; i < 40; i++) {
        await cx.sleep(50);
        const pane = panes().find((p) => p.terminal === target.terminal);
        if (pane && (entry.newTab || pane.tab === entry.tab.id)) {
          moved = true;
          break;
        }
      }
      closeOverlay(overlay);
      if (!moved)
        notify({
          title: "Move pane to tab failed",
          body: `Take it back with: herdr-app do terminal.keep --terminal ${target.terminal} --place ${entry.newTab ? "tab" : "right"}`,
        });
    });
  }

  renderTabPicker(t) {
    // A new tab first, then the space's other tabs.
    const list = [{ newTab: true }, ...this.otherTabs(props().target)];
    const count = Math.max(1, list.length);
    const move = (i, cx) => {
      if (list[i]) this.moveTo(list[i], cx);
    };
    return v_flex()
      .id("my-menu-tabs")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % count;
        else if (e.key === "up") this.at = (this.at + count - 1) % count;
        else if (e.key === "enter") move(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((entry, i) =>
          h_flex()
            .id(entry.newTab ? "mt-new" : `mt-${entry.tab.id}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => move(i, cx))
            .child(
              svg(icon(entry.newTab ? "plus" : "layers"))
                .size(14)
                .flex_none()
                .text_color(t.muted),
            )
            .child(div().flex_1().child(entry.newTab ? "New tab" : `${entry.number}. ${entry.tab.name}`)),
        ),
      );
  }

  // Two segments, the active one filled; each is its own click target.
  switchFor(item, t) {
    const seg = (id, label) =>
      div()
        .id(`rc-${id}`)
        .h(18)
        .px(6)
        .rounded(4)
        .flex()
        .items_center()
        .text_size(10.5)
        .cursor_pointer()
        .when(item.value === id, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(item.value !== id, (el) =>
          el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)),
        )
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.pick(id === "program" ? "program" : "menu", item);
        })
        .child(label);
    return h_flex()
      .flex_none()
      .gap(1)
      .p(1)
      .rounded(5)
      .bg(t.raised)
      .children([seg("menu", "Menu"), seg("program", "Pane")]);
  }

  // raw / tagged: each segment copies at once and becomes the default.
  copySwitchFor(item, t) {
    const seg = (id) =>
      div()
        .id(`rf-${id}`)
        .h(18)
        .px(6)
        .rounded(4)
        .flex()
        .items_center()
        .text_size(10.5)
        .cursor_pointer()
        .when(item.value === id, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(item.value !== id, (el) =>
          el.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)),
        )
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.copyAs(item.terminal, id, cx);
        })
        .child(id);
    return h_flex()
      .flex_none()
      .gap(1)
      .p(1)
      .rounded(5)
      .bg(t.raised)
      .children([seg("raw"), seg("tagged")]);
  }

  render() {
    const t = theme();
    if (props()?.pick === "tab") return this.renderTabPicker(t);
    const list = items(props());
    return v_flex()
      .id("my-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(Boolean(it.divider), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`mm-${i}`)
                .h(31)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .justify_between()
                .text_color(t.foreground)
                .when(i === this.at, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.choose(i, cx))
                .child(
                  svg(icon(it.toggle ? "terminal" : it.icon ?? "terminal"))
                    .size(14)
                    .flex_none()
                    .text_color(t.muted),
                )
                .child(div().flex_1().child(it.label))
                .when(it.toggle, (el) => el.child(this.switchFor(it, t)))
                .when(it.ref, (el) => el.child(this.copySwitchFor(it, t)))
                .when(!it.toggle && !it.ref, (el) =>
                  el.child(div().text_size(11).text_color(t.dim).child(it.hint ?? shortcut(it.command, it.args))),
                ),
            ),
        ),
      );
  }
}
