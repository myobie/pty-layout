# pty-layout

> **Beta** — the CLI, tag model, and tmux shim are usable, but things may change before 1.0.

A terminal multiplexer for [@myobie/pty](https://github.com/myobie/pty) sessions. Open panes, split the screen, attach and detach — all driven by pty tags, not an in-memory session list.

The core idea: **every pane is a pty session carrying a tag this layout watches**. To open a pane, tag a session. To close a pane, untag it (the session keeps running). Any tool that can write a tag can drop a pane into your view — including a drop-in `tmux` shim that makes Claude Code's experimental agent-teams feature work.

## Install

```sh
npm install -g @myobie/pty-layout
```

Requires Node.js 25+. Works on macOS and Linux. Requires [@myobie/pty](https://github.com/myobie/pty).

## Quickstart

```sh
pty-layout                           # auto-tag mode; opens the picker
pty-layout --tag project=myapp       # shared-workspace mode (read-only)
pty-layout --tmux                    # turn on the tmux shim for Claude Code agent teams
pty-layout bash bash                 # start with two tagged shells pre-populated
```

Once inside, press `^]` (Ctrl + `]`) to show the command overlay. Everything useful is one more keystroke from there.

## How it works — the tag model

Every pty-layout instance has a **scope tag** and displays every running session that carries it.

- **Auto-tag mode** (default): pty-layout generates a per-instance reserved key `:l<pid>-<rand>` and writes it as the value `"1"` on any session pulled into the layout. Since the key is unique per pty-layout process, the same session can live in many layouts at once without collision. The `:` prefix keeps the key out of `pty list` output by default.
- **Explicit `--tag` mode**: you pass your own tag (`--tag team=alpha`). Multiple pty-layouts with the same tag share a workspace — sessions tagged `team=alpha` appear in all of them. Close is disabled; the tag belongs to the group.

**Opening a pane:**
- Pick a session from `^] n` → pty-layout writes the scope tag onto the session via `updateTags()`.
- Spawn a new session from the picker → new daemon is tagged at creation.
- Run `pty-layout new -- <cmd>` from inside a layout shell → spawns a tagged daemon, layout auto-attaches.
- **Anyone** (a script, another tool, Claude Code's agent-teams feature) can tag a session with the layout's key. `pty-layout` will attach automatically. That's the protocol — no RPC, just tags.

**Closing a pane:**
- `^] w` or `^] \` removes the scope tag. The underlying session keeps running.
- `pty gc` cleans up orphan `:l<pid>-*` tags left by crashed pty-layouts.

## Keybindings

Prefix is `^]` (Ctrl + `]`). Sticky keys stay in prefix mode so you can chain actions.

| Key       | Action                             |
|-----------|------------------------------------|
| `^]` then | (command character below)          |
| `1`–`9`   | focus pane N (letters continue)    |
| `,` / `.` | focus prev / next pane (sticky)    |
| `l`       | cycle layout (sticky)              |
| `m`       | move-pane mode (sticky)            |
| `n`       | open session picker                |
| `w`       | close focused pane (auto-tag only) |
| `q`       | quit pty-layout                    |
| `Esc`     | cancel prefix                      |
| `^] ^]`   | cancel prefix (alt)                |

Selection:

- **Mouse click-drag** inside a pane → selection. Release → copies to clipboard via OSC 52. Wrapped lines round-trip as single logical lines (URLs, JSON, long commands).
- Scrolling moves the selection anchor with the content (selection tracks content, not screen position).

## Layouts

Cycle with `^] l`:

- **grid** — all panes equal size, filling the terminal.
- **stacked** — panes top-to-bottom in index order. Focused pane is open; others collapse to a 1-row title strip. Switching focus swaps which pane is open. Unfocused panes keep their last focused size (no reflow on collapse).
- **single** — only the focused pane renders; others are hidden.
- **zoom** (opt-in via `--layouts=+zoom`) — all panes same fixed size, video-call-style grid.

Default cycle: `grid → stacked → single → grid`. Add `--layouts=+zoom` to include zoom.

## `--tmux` mode

Make tools that expect `tmux` (notably [Claude Code's experimental agent-teams](https://code.claude.com/docs/en/agent-teams)) work inside pty-layout without real tmux installed.

```sh
pty-layout --tmux --tag team=demo     # or just: pty-layout --tmux (auto-tag)
```

Shells spawned inside get:

- `TMUX=pty-layout,<pid>,0` — non-empty, shaped like real tmux. Enables tmux-aware tools.
- `TMUX_PANE=%<session-name>` — the pane id Claude Code reads directly.
- `PTY_LAYOUT_FILTER_TAG=<key>=<value>` — tells shim/scripts which tag scope to apply.
- `PATH` prepended with pty-layout's shim dir, and a bash function `tmux` that points at the shim via absolute path.
- Shell init wrappers (`--rcfile` for bash, `ZDOTDIR` for zsh) that source your normal rc then re-prepend PATH, beating `brew shellenv` and similar.

The shim translates `split-window`, `send-keys`, `list-panes`, `kill-pane`, `display-message`, `has-session`, and the usual no-ops into pty CLI calls. Teammate sessions spawn with the layout tag, appearing in the layout via the normal subscription flow.

## `pty-layout new`

From inside any layout shell, spawn a new tagged session:

```sh
pty-layout new -- bash                # spawn bash in a new pane
pty-layout new --name task1 -- python run.py
pty-layout new --cwd /tmp -- htop
pty-layout new                        # no command → spawns $SHELL
```

This is a scripting primitive. It reads `$PTY_LAYOUT_FILTER_TAG` (set in every layout-spawned shell), spawns a tagged daemon session, prints the session name. The subscription auto-adds the pane.

## CLI

```
pty-layout                              # interactive, auto-tag mode
pty-layout --tag key=value              # explicit-tag mode (repeatable)
pty-layout --tmux                       # enable tmux shim
pty-layout --layouts=+zoom              # add zoom to the layout cycle
pty-layout bash bash                    # pre-populate with two tagged shells
pty-layout new ...                      # subcommand; see above
```

## Development

```sh
git clone https://github.com/myobie/pty-layout.git
cd pty-layout
npm install
npm start                               # run src/main.ts directly via --experimental-strip-types
npm test                                # vitest run
npm run build                           # compile to dist/, bundle shim/*.ts → shim/*.js
```

## License

[MIT](./LICENSE)
