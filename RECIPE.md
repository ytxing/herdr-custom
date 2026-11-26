# Good Agent Info

Good Agent Info is a Herdr layout built around a sidebar with Spaces, Tabs, and Status views. It organizes local and remote agents by workspace, prioritizes agents that need attention, and groups long-idle agents under Dormant. The layout also includes a scrolling tab bar, agent-aware pane headers, and Files and Changes panels.

![Good Agent Info layout illustration](preview.png)

## What you see

- A 268 px left sidebar with a 46 px workspace chrome header, the Better Sidebar lists view, and a 28 px footer.
- Better Sidebar offers Spaces, Tabs, and Status views. It groups workspaces by machine, nests Git worktrees, shows agent status and sub-agent trees, and displays repository and pull-request details when available.
- A 42 px tab bar above the main work area. Tabs scroll horizontally, show their number and activity state, and provide Files and Changes panel controls. Unnamed tabs follow the current agent title when it describes the task, including session names containing `@`.
- The main pane uses a 30 px agent-aware header with the program icon, terminal's launch name (or program name), terminal address, working directory, status, and pane actions on hover.
- A hidden 368 px right panel contains Files and Changes. The 28 px workspace status bar remains along the bottom.
- Colors and borders use Herdr theme tokens, except the per-agent working tints. The layout leaves the terminal background, pane border, focus border, and window chrome tied to the selected theme.

## How it behaves

- Spaces, Tabs, and Status switch the sidebar list. Space and agent groups can be folded. Spaces can be moved within their machine, and sidebar width controls the compact rail.
- Agent rows show working, blocked, done, and idle states. A working dot breathes in the agent's own color: Claude coral `#D97757`, Codex periwinkle `#7A9DFF`, Pi mint `#4FC3A1`, OpenCode gold `#F1BE58`. The same tint fills the working tab's number block and spinner in the tab bar, the tab number in Tabs view, and the pane header's working spinner. Sub-agents appear as a tree. Rows focus their pane, and hovering an agent exposes pinning controls.
- The tab bar follows the active tab, scrolls long names, supports drag reordering and double-click rename, and opens the tab menu on right-click.
- The Files and Changes controls select or hide the right panel. Its selection is remembered per space.
- The pane header focuses its pane. Hovering reveals split, zoom, and close actions.
- The terminal right-click menu supports splitting, zooming, parking, closing, copying a terminal address (plain or wrapped in an `<hc>` tag for agent messages), changing right-click routing, and moving a pane to another tab.
- Better Sidebar reads Git metadata for visible workspaces and watches local repositories for changes. Pull-request status is optional and uses the installed GitHub CLI (`gh`) with the user's existing authentication. The Files and Changes panels run Git commands and read files in the active workspace. Remote workspaces use Herdr's configured machine connection.

## Built from

- `layouts/Good Agent Info.json` defines the sidebar, work area, tab bar, pane header, right panel, status bar, and terminal menu.
- `mods/good-agent-sidebar/` provides the combined workspace and agent lists, Git metadata, and optional GitHub pull-request status.
- `mods/good-agent-tab-bar/` provides the tab bar and per-space panel selection.
- `mods/good-agent-pane-header/` provides the agent-aware pane header.
- `mods/good-agent-sidebar-header/` and `mods/good-agent-workspace-status/` provide the top and bottom workspace bars.
- `mods/good-agent-file-browser/` and `mods/good-agent-git-changes/` provide the right-side file browser and Git change view.
- `mods/good-agent-terminal-menu/` provides the terminal context menu and pane-to-tab picker.
- `mods/good-agent-notifications/` forwards agent alerts to macOS and plays notification sounds.

## Agent Ring alerts

Good Agent Info sends Herdr-managed agents on this computer and on remote machines through Agent Ring's macOS notification and sound pools. Agents running outside Herdr keep using Agent Ring's existing hooks and plugins. In Herdr's Settings > Alerts, configure banners, sound playback, and fixed or per-pane sound selection. The MP3 pools live in `mods/good-agent-notifications/sound-fx/`; the same folder path appears in the settings page.

Turn on **Notify for the focused pane** in Settings > Alerts to receive the same alerts while watching an agent. The switch starts off. Banner and sound preferences apply to these alerts too. Other panes in the current tab still send completion alerts. Focusing a completed pane acknowledges only that pane and lets Herdr return it to idle. Every other pane keeps its Done marker until you focus that pane or click its reminder.

The mod uses Node.js and macOS audio tools. Install `terminal-notifier` for system banners and `rsvg-convert` (from `librsvg`) for agent logo attachments. If a local Agent Ring Codex sender and Herdr's app icon are available, the installer can create a Herdr-branded sender locally. Add MP3s you can use to `sound-fx/done/` and `sound-fx/suspended/` inside the installed mod. Empty pools use macOS system sounds. Disable Herdr's built-in sounds to avoid duplicate playback.

Completion banners show the most recent user prompt. Codex, Claude Code, and Pi share a JSONL reader that searches backwards from the end of the transcript. Codex selects the main session from the foreground process’s open files. Claude Code resolves the interactive session ID for that PID. Load `pi-session.ts` as a Pi extension on each machine running Pi. At completion it identifies the current transcript and the user entry on the active branch. The reader needs `jq` on the agent machine, `lsof` for Codex, and `tac` on Linux or `tail -r` on macOS. OpenCode reads its SQLite database using `sqlite3` and an explicit `--session` ID. When the prompt is unavailable, the banner shows `Finished`.

Codex completion candidates produce a per-turn `working`, `idle`, or `done` state from the main rollout. The sidebar, pane headers, tab bar, space summaries, and toast all consume that resolved state instead of trusting the displayed side thread's OSC result. A `task_complete` must match the status transition before `done` is allowed. Side conversations and replayed results therefore remain `working` or `idle` as appropriate, while a real main completion can notify. A Codex toast that arrives before its turn is settled is closed at once, because an overlay with no content draws as an empty box, and the sidebar header posts it again when the turn holds. Remote status delivery has a 30-second tolerance.

After installing the mod, run `node mods/good-agent-notifications/install-alerts.cjs` while Herdr is running, then reopen Settings. Herdr regenerates its built-in Settings screen on startup. Run the same command after a restart to restore the controls. The saved preferences are retained.

## Requirements

- Herdr App 0.1.16 or a compatible release with the `gpui-kit` and `herdr` mod APIs used by these mods.
- `git` for repository details and the Changes panel.
- `gh` is optional. Without it, disable `pull_request_status` in Better Sidebar's mod settings.
- A configured Herdr machine connection is needed to show remote spaces and their repository details.

## Install

Copy `layouts/Good Agent Info.json` into `~/.config/herdr-app/layouts/` and each `good-agent-*` folder under `mods/` into `~/.config/herdr-app/mods/`. Check each mod with `herdr-app check <mod-folder>`, then choose Good Agent Info in the layout picker. Symlinked mod folders are not hot-reloaded: after editing them, restart Herdr or switch layouts and back. Real folders under `mods/` reload on save.

When upgrading from the pre-rename version, remove its old custom `better-sidebar`, `tabs-marquee`, `agent-name-pane`, `agent-ring-toast`, and `my-menu` folders if present. The renamed mods leave Herdr's shipped mods untouched.
