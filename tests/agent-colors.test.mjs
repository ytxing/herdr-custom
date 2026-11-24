import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Each mod installs on its own, so the palette is repeated in three places.
// This keeps the copies from drifting apart.
const FILES = [
  "mods/good-agent-sidebar/views/agents.js",
  "mods/good-agent-tab-bar/main.js",
  "mods/good-agent-pane-header/main.js",
];

function palette(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const body = /const AGENT_COLORS = \{([\s\S]*?)\};/.exec(text)?.[1];
  assert.ok(body, `${file} declares AGENT_COLORS`);
  return Object.fromEntries(
    [...body.matchAll(/(\w+):\s*"([^"]+)"/g)].map(([, key, value]) => [key, value]),
  );
}

test("every agent surface uses the same breathing-light palette", () => {
  const expected = {
    claude: "#D97757",
    codex: "#7A9DFF",
    pi: "#4FC3A1",
    opencode: "#F1BE58",
  };
  for (const file of FILES) assert.deepEqual(palette(file), expected, file);
});
