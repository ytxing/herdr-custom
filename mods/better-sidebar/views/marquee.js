import { div } from "gpui-kit";

const MIN_PERIOD_MS = 6000;
const MS_PER_PX = 180;

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

export function marquee(owner, key, value, { maxWidth, color, size, grow = false, tooltip = true } = {}) {
  const text = String(value ?? "");
  owner.marqueeWidths ??= Object.create(null);
  let widths = owner.marqueeWidths[key];
  if (!widths || widths.text !== text) {
    widths = owner.marqueeWidths[key] = { text, content: 0, view: 0 };
  }
  const content = widths.content || estimate(text);
  const available = widths.view || maxWidth || content;
  const overflow = Math.max(0, Math.ceil(content - available));

  let outer = div()
    .flex()
    .items_center()
    .min_w(0)
    .overflow_hidden()
    .whitespace_nowrap()
    .when(tooltip, (el) => el.tooltip(text))
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

  return outer.child(
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
}
