// Adapted from Herdr's shipped agents mod, with grouping by main space and by
// name prefix. Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  agents,
  terminals,
  panes,
  focused,
  spaces,
  run,
  theme,
  shared,
  setShared,
  setAgentOrder,
  window,
  layout,
} from "herdr";
import { findNode } from "./find-node.js";
import { TEXT, Icon, GroupHeader, Rail, directoryTooltip, projectColor } from "./ui.js";
import { clearMarqueeHover, marquee } from "./marquee.js";
import { spaceFolder } from "../git/checkouts.js";

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = findNode(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// pi titles its terminal "π - <session> - <folder>" ("π - <folder>" until the
// session has a name). The glyph and the trailing folder repeat what the label
// already says, so keep only the session.
function shownTitle(program, raw) {
  const title = clean(raw);
  if (program?.key !== "pi" || !title.startsWith("π")) return title;
  return title.replace(/^π\s+-\s+/u, "").replace(/\s+-\s+\S+$/u, "");
}

function lead(tab, all = panes()) {
  const mine = all.filter((p) => p.tab === tab.id && p.terminal);
  return mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
}

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the tab bar does; a name the person gave stays.
function title(tab, l) {
  const prog = l?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!l?.program?.agent) return base;
  const live = shownTitle(l?.program, l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  // Only a shell's "user@host: path" goes without saying; an agent's own
  // session name may contain "@" and still tells what the tab is about.
  const shellTitle = /^[^\s@]+@[^\s@]+:\s/.test(live);
  const telling = live && live !== l?.terminal && live !== prog && !path && !shellTitle && live.toLowerCase() !== l.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}
// Agent marks take the agent's own color from its icon; other programs keep the theme's.
// The four stay apart by hue and by lightness, so a 7 px dot still tells them apart:
// orange 19°, gold 40° (much lighter), mint 160°, periwinkle 224°. OpenCode's mark is
// monochrome, so it takes gold; Pi takes the free cool mint, clear of Claude's coral.
const AGENT_COLORS = {
  claude: "#D97757",
  codex: "#7A9DFF",
  pi: "#4FC3A1",
  opencode: "#F1BE58",
};
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "tab", label: "Grouped by tab", icon: "layers" },
];
const sortOf = (id) => SORTS.find((s) => s.id === id) ?? SORTS[0];
const LONG_IDLE = "sec-0";
const IDLE_UNITS = { m: 60000, h: 3600000, d: 86400000 };
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle", 0: "Dormant" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function idleThreshold(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(value.trim());
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const ms = Number(match[1]) * IDLE_UNITS[unit];
  return Number.isFinite(ms) && ms > 0 ? { ms, label: match[1] + unit } : null;
}

const DEFAULT_IDLE_AFTER = idleThreshold("1d");

function grouping(sort, tabName) {
  return sort === "tab"
    ? (a) => ({ id: `tab-${a.tab}`, label: tabName(a) })
    : null;
}

function gatherGroups(list, groupOf) {
  const groups = new Map();
  for (const agent of list) {
    const { id } = groupOf(agent);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(agent);
  }
  return [...groups.values()].flat();
}

function nest(lines, row) {
  return h_flex().children(lines.map((line) => Rail(line))).child(row.flex_1().min_w(0));
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

// What a row calls an agent: its tab's title, or failing that its own.
function agentLabel() {
  const tabs = spaces().flatMap((s) => s.tabs);
  return (a) => {
    const tab = tabs.find((candidate) => candidate.id === a.tab);
    return tab ? title(tab, lead(tab)) : shownTitle(a.program, a.title) || a.program?.name || "";
  };
}

// Same group next to each other, so the list reads, and next-agent keys move, in order.
export class Agents {
  init(_props, cx) {
    this.folded = new Set([LONG_IDLE]);
    this.idleAfter = idleThreshold(localStorage.getItem("idleAfter") ?? "") ?? DEFAULT_IDLE_AFTER;
    this.idleInput = InputState.new({ placeholder: "e.g. 12h/1d" });
    this.idleInput.on("change", (_event, cx) => cx.notify());
    const finishIdleEdit = (_event, cx) => {
      if (!this.editingIdle) return;
      this.editingIdle = false;
      const value = this.idleInput.value().trim();
      const threshold = value ? idleThreshold(value) : DEFAULT_IDLE_AFTER;
      if (threshold) {
        this.idleAfter = threshold;
        localStorage.setItem("idleAfter", threshold.label);
      }
      cx.notify();
    };
    this.idleInput.on("submit", finishIdleEdit);
    this.idleInput.on("blur", finishIdleEdit);
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed))
      if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  focusAgent(agent) {
    run(`good-agent-sidebar-header.ring-read/${agent.address}`);
    run("pane.focus", { pane: agent.pane });
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const name = k.name || k.template || k.program?.name;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(
        s.lines.map((l) =>
          div()
            .self_start()
            .mt(-4)
            .w(9)
            .h(17)
            .mr(4)
            .flex_none()
            .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
            .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6)),
        ),
      )
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(marquee(this, `child-${k.address}`, name || k.address, {
        grow: true,
        tooltip: name,
        color: on ? t.foreground : t.muted,
      }))
      .child(this.status(t, { status: st, program: k.program, address: k.address }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") {
      const phase = [...(a.address ?? "")].reduce((value, char) => (value * 33 + char.codePointAt(0)) >>> 0, 5381);
      // One 0.3-1.0 swing for every agent; the hash sets direction and period.
      const low = 0.3;
      const high = 1;
      const reversed = (phase & 1) === 1;
      // The agent's own color; each address also sets its own breath.
      const tint = AGENT_COLORS[a.program?.key] ?? t.working;
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .bg(tint)
        .accessibility_label("Working")
        .loop("opacity", { from: reversed ? high : low, to: reversed ? low : high, period: 2000 + (phase % 2001) });
    }
    if (a.status === "blocked" && compact)
      return div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    if (a.status === "blocked")
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_semibold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle")
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .border(1.5)
        .border_color(t.idle ?? t.dim);
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(a.status === "done" ? color : t.dim + "00");
  }

  // opts, from the lists view: `view` already read, `heading: false` under its tabs.
  render(opts = {}) {
    const t = theme();
    const view = opts.view ?? this.readView();
    setAgentOrder(view.list.map((a) => a.address));
    const rows = view.collapsed
      ? view.list.flatMap((a, i) => this.agentWithSubs(a, i, view, t))
      : view.groups.flatMap((group, index) => this.groupRows(group, index, view, t));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // Under the lists view's tabs, the tab bar's space divides it instead.
      .when(opts.heading !== false, (el) => el.border_t(1).border_color(t.border))
      .text_size(TEXT.body)
      .when(!view.collapsed && opts.heading !== false, (el) => el.child(this.heading(t)))
      .when(view.list.length === 0 && !view.collapsed, (el) => el.child(this.emptyMessage(t)))
      .child(
        v_flex()
          .id("ag-list")
          .flex_1()
          .min_h(0)
          .px(view.collapsed ? 0 : 8)
          .overflow_y_scrollbar()
          .mode("always")
          .children(rows),
      )
      .when(view.collapsed, (el) => el.child(this.expandRow(t)));
  }

  // ── What to show ──────────────────────────────────────────────────────────

  // Everything one render needs: the agents in order, in their groups.
  readView(sortId = "priority") {
    const sort = sortOf(sortId);
    const all = terminals();
    const now = Date.now();
    const unread = shared("agent-ring.unreadDone");
    const native = agents();
    const unordered = native.map(agent =>
      agent.status === "idle" && unread?.[agent.address] ? { ...agent, status: "done" } : agent);
    this.listed = new Map(unordered.map((a) => [a.address, a.status]));
    this.track(unordered, now);
    this.prunePins(all);

    const byPriority = sort.id === "priority";
    const urgency = this.urgencies(unordered, all);
    const ordered = this.byUrgency(unordered, urgency);
    const pinned = ordered.filter((a) => this.pins.includes(a.address));
    const unpinned = ordered.filter((a) => !this.pins.includes(a.address));

    const label = agentLabel();
    // Each tab's place in the list and its number within its space.
    const tabOrder = new Map();
    const spaceFolders = new Map();
    const paneList = panes();
    for (const space of spaces()) {
      spaceFolders.set(space.id, spaceFolder(space, paneList));
      space.tabs.forEach((tab, index) =>
        tabOrder.set(tab.id, { order: tabOrder.size, number: index + 1 }),
      );
    }
    const groupOf = grouping(sort.id, label);
    const rest = groupOf
      ? gatherGroups(gatherGroups(unpinned, (a) => ({ id: a.space })), groupOf)
      : unpinned;
    const groups = this.makeGroups(pinned, rest, groupOf, byPriority, urgency, now);
    if (sort.id === "tab") {
      const orderOf = (group) => tabOrder.get(group.members[0]?.tab)?.order ?? Infinity;
      const pinnedRank = (group) => (group.id === "pinned" ? 0 : 1);
      groups.sort((x, y) => pinnedRank(x) - pinnedRank(y) || orderOf(x) - orderOf(y));
      for (const group of groups)
        if (group.id !== "pinned") group.number = tabOrder.get(group.members[0]?.tab)?.number;
    }
    if (byPriority) {
      for (const group of groups) {
        if (group.id !== "pinned") group.members = gatherGroups(group.members, (a) => ({ id: a.space }));
      }
    }
    const collapsed = narrow();
    const list = groups.flatMap((group) =>
      collapsed && group.id === LONG_IDLE && this.folded.has(LONG_IDLE) ? [] : group.members,
    );
    return {
      sort,
      all,
      now,
      byPriority,
      collapsed,
      shown: focused()?.agent,
      list,
      label,
      groups,
      spaceFolders,
    };
  }

  // An agent's urgency is its own or its most urgent sub-agent's.
  urgencies(list, all) {
    const kids = (a) =>
      this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0);
    return new Map(list.map((a) => [a.address, Math.max(RANK[a.status] ?? 0, ...kids(a))]));
  }

  byUrgency(list, urgency) {
    const rankOf = (a) => urgency.get(a.address);
    return [...list].sort(
      (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq,
    );
  }

  // Groups in list order: spaces (grouped) or priority sections. Agents of a
  // space are next to each other in agents(), so neighbours make a group.
  makeGroups(pinned, rest, groupOf, byPriority, urgency, now) {
    const groups = pinned.length
      ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }]
      : [];
    if (byPriority) {
      // Every section stays, empty ones at zero: a status vanishing reads as a glitch.
      const byRank = new Map();
      for (const a of rest) {
        const urgencyRank = urgency.get(a.address) || RANK.idle;
        const longIdle = a.status === "idle" && urgencyRank === RANK.idle &&
          now - this.since(a) >= this.idleAfter.ms;
        const rank = longIdle ? 0 : urgencyRank;
        if (!byRank.has(rank)) byRank.set(rank, []);
        byRank.get(rank).push(a);
      }
      for (const rank of [4, 3, 2, 1, 0]) {
        groups.push({
          id: `sec-${rank}`,
          label: SECTION[rank],
          status: SECTION_STATUS[rank] ?? "idle",
          members: byRank.get(rank) ?? [],
        });
      }
      return groups;
    }
    for (const a of rest) {
      const group = groupOf(a);
      if (groups.at(-1)?.id === group.id) groups.at(-1).members.push(a);
      else groups.push({ ...group, status: null, members: [a] });
    }
    return groups;
  }

  toggleFold(id, cx) {
    if (!this.folded.delete(id)) this.folded.add(id);
    cx.notify();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  heading(t) {
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .child(div().text_size(TEXT.label).font_medium().text_color(t.dim).child("Agents"));
  }

  emptyMessage(t) {
    return div()
      .px(12)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .child(
        "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.",
      );
  }

  // Under the compact rail, the way back to the full sidebar.
  expandRow(t) {
    return h_flex()
      .h(28)
      .items_center()
      .justify_center()
      .child(
        div()
          .id("collapse")
          .px(10)
          .py(2)
          .rounded(5)
          .text_size(TEXT.body)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(toggleSidebar)
          .child("»"),
      );
  }

  projectFoldKey(space) {
    return `project:${space}`;
  }

  projectHeader({ id, space, name, folder, machine, t, divided = false, secondary = false }) {
    const fold = this.projectFoldKey(space);
    const color = projectColor(space, t);
    return GroupHeader({
      owner: this,
      id,
      label: name || "Project",
      labelTooltip: directoryTooltip(folder, machine),
      labelColor: color,
      prominent: true,
      folded: this.folded.has(fold),
      divided,
      // The main axis puts its chevron at the right; a sub-heading leads with it.
      trailing: !secondary,
      action: machine
        ? div().flex_none().text_color(t.dim).accessibility_label(`Remote: ${machine}`).child(Icon("server"))
        : null,
      onClick: (cx) => this.toggleFold(fold, cx),
    });
  }

  // One tree level under a heading: each agent is a branch, its sub-agents continue it.
  agentTree(rows) {
    return rows.flatMap((parts, i) => {
      const last = i === rows.length - 1;
      return parts.map((row, j) =>
        nest([j === 0 ? (last ? "└" : "├") : last ? "" : "│"], row),
      );
    });
  }

  groupRows(group, index, view, t) {
    if (view.sort.id === "tab" && group.id !== "pinned")
      return this.tabGroupRows(group, index, view, t);
    const header = this.groupHeader(group, view, t, index > 0);
    if (group.id === "pinned") {
      const members = this.folded.has(group.id)
        ? []
        : group.members.flatMap((a, i) => this.agentWithSubs(a, i, view, t));
      return [header, ...members];
    }
    return [header, ...this.priorityProjectRows(group, view, t)];
  }

  priorityProjectRows(group, view, t) {
    if (this.folded.has(group.id)) return [];
    const rows = [];
    const members = group.members;
    for (let start = 0; start < members.length;) {
      const first = members[start];
      let end = start + 1;
      while (end < members.length && members[end].space === first.space) end++;
      const agents = members.slice(start, end);
      const machine = first.address.includes("/") ? first.address.split("/")[0] : null;
      const project = this.projectHeader({
        id: `priority-project-${group.id}-${first.space}`,
        space: first.space,
        name: first.space_name,
        folder: view.spaceFolders.get(first.space),
        machine,
        t,
        secondary: true,
      });
      // The project heading sits at the left edge, like a machine header in Spaces.
      rows.push(project);
      if (!this.folded.has(this.projectFoldKey(first.space))) {
        const agentRows = agents.map((a, i) => this.agentWithSubs(a, i, view, t));
        rows.push(...this.agentTree(agentRows));
      }
      start = end;
    }
    return rows;
  }

  tabGroupRows(group, index, view, t) {
    const first = group.members[0];
    const previousGroup = view.groups[index - 1];
    const projectStart = Boolean(first) &&
      (!previousGroup || previousGroup.id === "pinned" || previousGroup.members[0]?.space !== first.space);
    let project = null;
    if (projectStart) {
      const machine = first.address.includes("/") ? first.address.split("/")[0] : null;
      project = this.projectHeader({
        id: `tab-project-${first.space}`,
        space: first.space,
        name: first.space_name,
        folder: view.spaceFolders.get(first.space),
        machine,
        t,
        divided: Boolean(previousGroup),
      });
    }
    if (this.folded.has(this.projectFoldKey(first.space))) return project ? [project] : [];

    // Tabs sit flush left; the tree indent starts at their agent rows.
    const header = this.groupHeader(group, view, t, false);
    const rows = [header];
    if (!this.folded.has(group.id)) {
      const agentRows = group.members.map((a, i) => this.agentWithSubs(a, i, view, t));
      rows.push(...this.agentTree(agentRows));
    }
    return project ? [project, ...rows] : rows;
  }

  // Folded, a group's header also says its most urgent state.
  groupHeader(group, view, t, divided = false) {
    const folded = this.folded.has(group.id);
    const top = group.members.reduce(
      (most, a) => ((RANK[a.status] ?? 0) > (RANK[most] ?? 0) ? a.status : most),
      null,
    );
    const showTop = folded && !view.byPriority && top && top !== "idle";
    const action = group.id === LONG_IDLE
      ? this.idleThresholdControl(t)
      : showTop ? this.status(t, { status: top }, true) : null;
    const onClick = (cx) => this.toggleFold(group.id, cx);
    const isTab = view.sort.id === "tab" && group.id !== "pinned";
    // Status sections read like project headings: big colored text, right chevron.
    const isSection = view.byPriority && Boolean(group.status);
    const statusColor = group.id === LONG_IDLE ? t.dim : t[group.status] ?? t.muted;
    // A working tab's number breathes in the same tint as the tab bar: the
    // first working pane in the tab, else the tab's lead agent.
    const tabId = group.members[0]?.tab;
    const workingPane = panes().find((p) => p.tab === tabId && p.status === "working");
    const tab = spaces().flatMap((s) => s.tabs).find((candidate) => candidate.id === tabId);
    const tint = workingPane?.program ?? (tab ? lead(tab)?.program : null);
    const numberColor = isTab && top === "working"
      ? AGENT_COLORS[tint?.key] ?? t.working
      : null;
    return GroupHeader({
      owner: this,
      id: group.id,
      label: group.label,
      // Tabs keep their own number in front of the title, outside the marquee.
      number: isTab ? group.number : null,
      numberBreathing: isTab && top === "working",
      numberColor,
      // An empty section stays listed, dimmed.
      labelColor: isSection
        ? group.members.length ? statusColor : t.dim
        : t[group.status],
      prominent: isTab || isSection,
      trailing: isSection,
      folded,
      divided,
      action,
      onClick,
    });
  }

  idleThresholdControl(t) {
    if (this.editingIdle) {
      return div()
        .id("long-idle-input")
        .w(84)
        .flex_none()
        .px(5)
        .rounded(4)
        .bg(t.raised)
        .on_click((_event, cx) => cx.stop_propagation())
        .on_key_down((event, cx) => {
          if (event.key !== "escape") return;
          cx.stop_propagation();
          this.editingIdle = false;
          cx.notify();
        })
        .child(Input.new(this.idleInput)
          .text_size(TEXT.caption)
          .text_color(this.idleInput.value() ? t.foreground : t.dim));
    }
    return div()
      .id("long-idle-threshold")
      .flex_none()
      .px(5)
      .rounded(4)
      .text_size(TEXT.caption)
      .text_color(t.dim)
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .accessibility_label(`Edit idle threshold: ${this.idleAfter.label}`)
      .on_click((_event, cx) => {
        cx.stop_propagation();
        this.editingIdle = true;
        this.idleInput.set_value("");
        this.idleInput.focus();
        cx.notify();
      })
      .child(`>${this.idleAfter.label}`);
  }

  agentWithSubs(a, i, view, t) {
    if (view.collapsed) return [this.railRow(a, i, t)];
    const subs = this.tree(view.all, a.address);
    const row = this.agentRow(a, subs, view, t);
    if (this.folded.has(a.address)) return [row];
    return [row, ...subs.map((s) => this.subRow(t, s, view.shown, view.byPriority))];
  }

  railRow(a, i, t) {
    return h_flex()
      .id(`ag-${a.address}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.focusAgent(a))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_nowrap()
          .text_right()
          .text_color(t.muted)
          .child(String(i + 1)),
      )
      .child(
        h_flex()
          .w(14)
          .flex_none()
          .items_center()
          .justify_center()
          .child(this.status(t, a, true)),
      );
  }

  agentRow(a, subs, view, t) {
    const pic = icon(a.program, 16, t.foreground);
    const hovered = this.hovered === a.address;
    const when = this.since(a);
    // Remote agents use the same server symbol as the machine group header.
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    return h_flex()
      .id(`ag-${a.address}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on === (this.hovered === a.address)) return;
        this.hovered = on ? a.address : null;
        cx.notify();
      })
      .on_click(() => this.focusAgent(a))
      .when(Boolean(pic), (el) => el.child(this.agentIcon(a, pic, subs)))
      .child(this.agentName(a, view, t))
      .when(view.nested && Boolean(machine), (el) =>
        el.child(div().flex_none().text_color(t.dim).accessibility_label(`Remote: ${machine}`).child(Icon("server"))),
      )
      .when(subs.length > 0, (el) => el.child(this.foldButton(a, subs, t)))
      // Keep the title's width stable when the pin replaces the elapsed time.
      .child(
        h_flex().relative().h(17).min_w(17).flex_none().items_center().justify_end()
          .when(Boolean(when), (el) => el.child(
            div().text_size(TEXT.caption).text_color(t.dim)
              .when(hovered, (text) => text.opacity(0))
              .child(duration(view.now - when)),
          ))
          .when(hovered, (el) => el.child(this.pinButton(a, t).absolute().top(0).right(0))),
      )
      .child(this.status(t, a, view.byPriority && !this.pins.includes(a.address)));
  }

  // A tab with no agent, under its space in the lists view: its program and its name.
  tabRow(w, tab, lit, t) {
    const l = lead(tab);
    // The tab's title, as Herdr's tab bar shows it.
    const name = title(tab, l);
    const pic = icon(l?.program, 16, t.dim);
    return h_flex()
      .id(`tab-${tab.id}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(lit, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        run("space.select", { id: w.id });
        run("tab.select", { id: tab.id });
      })
      .child(pic ?? div().w(16).flex_none())
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .child(marquee(this, `tab-${tab.id}`, name, { maxWidth: 140, color: lit ? t.foreground : t.muted })),
      );
  }

  // With sub-agents, clicking the icon folds them.
  agentIcon(a, pic, subs) {
    const t = theme();
    return div()
      .id(`agent-fold-${a.address}`)
      .when(subs.length > 0, (el) =>
        el
          .rounded(4)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.toggleFold(a.address, cx);
          }),
      )
      .child(pic);
  }

  // The tab's title, then quietly its space; nested under its space's row, its program.
  agentName(a, view, t) {
    const name = shownTitle(a.program, a.title) || a.program?.name || "";
    const idle = a.status === "idle" && !a.focused;
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .items_center()
      .child(
        marquee(this, `agent-${a.address}`, name, {
          grow: true,
          tooltip: name,
          color: idle ? t.muted : t.foreground,
        }),
      );
  }

  // The fold chevron; folded, the count too, colored by the most urgent one.
  foldButton(a, subs, t) {
    const statuses = subs.map((s) => kidStatus(s.t, this.listed));
    const top = statuses.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
    const open = !this.folded.has(a.address);
    return div()
      .id(`fold-${a.address}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(TEXT.caption)
      .text_color(open ? t.dim : (t[top] ?? t.dim))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold(a.address, cx);
      })
      .child(Icon(`chevron-${open ? "down" : "right"}`, 11))
      .when(!open, (el) => el.child(String(subs.length)));
  }

  pinButton(a, t) {
    const pinned = this.pins.includes(a.address);
    return div()
      .id(`pin-${a.address}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .accessibility_label(pinned ? "Unpin" : "Pin to the top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.setPins(pinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
        // The row moves away from under the pointer, and no hover-out comes.
        this.hovered = null;
        clearMarqueeHover(this);
        cx.notify();
      })
      .child(Icon(pinned ? "pin-off" : "pin", 13));
  }
}
