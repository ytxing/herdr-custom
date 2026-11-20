// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, closeOverlay, props, run, shared, terminals, theme } from "herdr";

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

function agentNotice(notification) {
  const address = notification.action?.args?.terminal;
  const finished = notification.title?.endsWith(" finished");
  if (notification.action?.name !== "agent.focus" || typeof address !== "string" ||
      (!finished && !notification.title?.endsWith(" needs you"))) return null;

  const terminal = terminals().find(entry => entry.address === address);
  const agent = agents().find(entry => entry.address === address);
  const program = terminal?.program ?? agent?.program;
  const machine = address.includes("/") ? address.split("/")[0] : null;
  const failed = !finished && terminal?.report?.state === "error";
  const heading = failed ? notification.title.replace(/ needs you$/, " failed") : notification.title;
  const place = clean(agent?.space_name) || clean(notification.body);
  const tab = clean(agent?.tab_name);
  const session = [terminal?.report?.title, terminal?.title, /^\d+$/.test(tab) ? "" : tab]
    .map(clean).find(value => value && value !== program?.name);
  const reason = finished ? "" : attentionMessage(terminal, failed ? "error" : "blocked") ||
    (failed ? "Agent reported an error" : "");
  return { heading, machine, program, session, place: place === session ? "" : place, reason };
}

function noticeText(notice, t) {
  const context = notice.session || notice.place;
  return v_flex().flex_1().min_w(0).overflow_hidden()
    .child(h_flex().gap(5).items_center().min_w(0)
      .child(div().min_w(0).truncate().font_semibold().text_size(13).line_height(16).text_color(t.foreground).child(notice.heading))
      .when(Boolean(notice.machine), el => el.child(
        div().max_w(128).flex_none().truncate().text_size(12).line_height(16).text_color(t.muted).child(`@${notice.machine}`),
      )))
    .when(Boolean(context), el => el.child(h_flex().gap(5).min_w(0).items_center()
      .child(div().min_w(0).truncate().text_size(12).line_height(15).text_color(t.foreground).child(context))
      .when(Boolean(notice.session && notice.place), row => row.child(
        div().max_w(112).min_w(0).truncate().text_size(12).line_height(15).text_color(t.muted).child(`· ${notice.place}`),
      ))))
    .when(Boolean(notice.reason), el => el.child(
      div().truncate().text_size(12).line_height(15).text_color(t.muted).child(notice.reason),
    ));
}

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const notice = login ? null : agentNotice(p);
    const icon = p.icon ?? notice?.program?.icon;
    const glyph = icon && (!p.icon && notice?.program?.tint
      ? svg(icon).size(18).text_color(t.foreground).flex_none()
      : image(icon).w(18).h(18).flex_none());
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
          run(`workspace-chrome.ring-read/${address}`);
        }
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(glyph || div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
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
