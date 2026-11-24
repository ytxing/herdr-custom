// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, props, run, shared, terminals, theme } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export function attentionMessage(terminal, state) {
  const reports = [terminal?.report, ...Object.values(terminal?.records ?? {})];
  for (const report of reports) {
    if (report?.state !== state || typeof report.msg !== "string") continue;
    const firstLine = report.msg.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  if (state === "error") return "";
  const kind = reports.find(report => report?.state === "blocked" && report.kind)?.kind;
  if (kind === "permission") return "Approval required";
  if (kind === "auth") return "Sign-in required";
  if (kind === "question") return "Waiting for your answer";
  return "";
}

const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export function agentNotice(notification, terminal) {
  const address = notification.action?.args?.terminal;
  const finished = notification.title?.endsWith(" finished");
  if (notification.action?.name !== "agent.focus" || typeof address !== "string" ||
      (!finished && !notification.title?.endsWith(" needs you") && !notification.title?.endsWith(" failed"))) return null;

  const machine = address.includes("/") ? address.split("/")[0] : null;
  const lines = String(notification.body ?? "").split(/\r?\n/);
  // Herdr's background alert supplies one line of location. The sidebar
  // header supplies separate session and location lines, plus an optional reason.
  const [snapshotSession, place, ...detail] = lines.length > 1 ? lines : ["", ...lines];
  const program = clean(terminal?.program?.name).toLowerCase();
  const session = [snapshotSession, terminal?.report?.title, terminal?.title]
    .map(clean).find(title => title && title.toLowerCase() !== program) ?? "";
  const state = notification.title.endsWith(" failed") ? "error" : "blocked";
  const reason = clean(detail.join(" ")) || (finished ? "" : attentionMessage(terminal, state));
  return { heading: notification.title, machine, session, place: clean(place), reason };
}

function noticeText(notice, t) {
  const context = notice.reason
    ? [notice.session, notice.place].filter(Boolean).join(" · ")
    : notice.session || notice.place;
  const detail = notice.reason || (notice.session ? notice.place : "");
  return v_flex().flex_1().min_w(0).overflow_hidden().children([
    h_flex().gap(5).items_center().min_w(0)
      .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(notice.heading))
      .when(Boolean(notice.machine), el => el.child(div().truncate().text_size(12).text_color(t.muted).child(`@${notice.machine}`))),
    context ? div().truncate().text_size(12).text_color(t.foreground).child(context) : null,
    detail ? div().truncate().text_size(12).text_color(t.muted).child(detail) : null,
  ].filter(Boolean));
}

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const address = p.action?.name === "agent.focus" ? p.action.args?.terminal : null;
    const terminal = address ? terminals().find(entry => entry.address === address) : null;
    const notice = login ? null : agentNotice(p, terminal);
    const glyph = p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]);
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        const address = p.action?.args?.terminal;
        if (p.action?.name === "agent.focus" && shared("agent-ring.unreadDone")?.[address]) {
          run(`good-agent-sidebar-header.ring-read/${address}`);
        }
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(glyph)
      .child(
        notice ? noticeText(notice, t) : v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
          .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
