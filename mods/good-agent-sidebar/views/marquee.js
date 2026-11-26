import { div } from "gpui-kit";
import { Popup } from "gpui-base";
import { theme } from "herdr";

const MIN_PERIOD_MS = 6000;
const MS_PER_PX = 180;
const TOOLTIP_DELAY_MS = 500;
// A hover-out is not guaranteed: the row may reorder, the view may switch, or
// the pointer may leave the window. The label still has to leave on its own.
const TOOLTIP_LIFETIME_MS = 4000;

function wide(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x1100 && (
    cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300
  );
}

function estimate(text) {
  let width = 0;
  for (const ch of text) width += ch === " " ? 4 : wide(ch) ? 13.5 : 7.5;
  return width;
}

export function clearMarqueeHover(owner) {
  const hover = owner.marqueeHover;
  if (!hover) return false;
  hover.timer?.cancel();
  hover.life?.cancel();
  owner.marqueeHover = undefined;
  return hover.visible;
}

function withTooltip(label, owner, key, text) {
  label.id(`marquee-viewport-${key}`).relative()
    .on_mouse_move(({ local_position: point }, cx) => {
      const previous = owner.marqueeHover;
      if (previous?.key !== key) {
        const wasVisible = clearMarqueeHover(owner);
        const hover = { key, x: point.x, visible: false };
        owner.marqueeHover = hover;
        hover.timer = cx.timer.after(TOOLTIP_DELAY_MS, (cx) => {
          if (owner.marqueeHover !== hover) return;
          hover.visible = true;
          cx.notify();
          hover.life = cx.timer.after(TOOLTIP_LIFETIME_MS, (cx) => {
            if (owner.marqueeHover !== hover) return;
            owner.marqueeHover = undefined;
            cx.notify();
          });
        });
        if (wasVisible) cx.notify();
      } else if (!previous.visible) {
        previous.x = point.x;
      }
    })
    .on_hover((active, cx) => {
      if (!active && owner.marqueeHover?.key === key && clearMarqueeHover(owner)) cx.notify();
    });

  const hover = owner.marqueeHover;
  if (hover?.key === key && hover.visible) {
    const t = theme();
    label.child(
      Popup.new(`marquee-help-${key}`, div().size(1))
        .absolute().left(hover.x).bottom(-9)
        .anchor("top_left")
        .content(
          div().max_w(440).whitespace_normal().px(8).py(4).rounded(5).border_1().border_color(t.border)
            .bg(t.popover).text_color(t.foreground).text_size(12).child(text),
        ),
    );
  }
  return label;
}

export function marquee(owner, key, value, { maxWidth, color, size, grow = false, tooltip } = {}) {
  const text = String(value ?? "");
  owner.marqueeWidths ??= Object.create(null);
  let widths = owner.marqueeWidths[key];
  if (!widths || widths.text !== text) {
    widths = owner.marqueeWidths[key] = { text, content: 0, view: 0 };
  }
  const content = widths.content || estimate(text);
  const available = widths.view || maxWidth || content;
  const overflow = Math.max(0, Math.ceil(content - available));

  const label = div()
    .flex()
    .items_center()
    .min_w(0)
    .overflow_hidden()
    .whitespace_nowrap()
    .when(grow, el => el.flex_1())
    .when(!grow, el => el.flex_none())
    .when(maxWidth != null, el => el.max_w(maxWidth))
    .when(Boolean(color), el => el.text_color(color))
    .when(Boolean(size), el => el.text_size(size))
    .on_size_change((bounds, cx) => {
      const width = Math.round(bounds.width);
      if (widths.view !== width) {
        widths.view = width;
        cx.notify();
      }
    });

  label.child(
    div()
      .id(`marquee-${key}`)
      .relative()
      .flex_none()
      .whitespace_nowrap()
      .on_size_change((bounds, cx) => {
        const width = Math.round(bounds.width);
        if (widths.content !== width) {
          widths.content = width;
          cx.notify();
        }
      })
      .when(overflow > 0, el => el.loop("left", {
        from: 0,
        to: -overflow,
        period: Math.max(MIN_PERIOD_MS, overflow * MS_PER_PX),
        easing: "linear",
      }))
      .child(text),
  );

  return tooltip ? withTooltip(label, owner, key, tooltip) : label;
}
