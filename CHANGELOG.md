# Changelog

## Unreleased

_Nothing yet._

## 0.1.0

Initial release.

- Tag-driven pane model: every pane is a `@myobie/pty` daemon session with a tag the layout watches. Auto-tag mode uses a reserved per-instance key; `--tag` mode joins a shared workspace. `pty gc` prunes orphaned layout tags.
- Layouts: grid, stacked, single, opt-in zoom. `--layouts` flag to customize the cycle.
- Text selection with click-drag, OSC 52 copy. Shift-click extends across scroll boundaries; scrolling keeps the selection pinned. Wrap-aware copy (no spurious newlines in wrapped URLs / JSON).
- `--tmux` shim covers enough of tmux's surface (`split-window`, `send-keys`, `list-panes`, `kill-pane`, `display-message`, `has-session`, `new-session`, `TMUX_PANE`) to host [Claude Code agent-teams](https://code.claude.com/docs/en/agent-teams). PATH-preserving shell init wrappers for bash and zsh.
- Session picker, `^]` command overlay, `pty-layout new` subcommand for scripting new tagged panes.
- Palette-indexed SGR colors from pane content round-trip intact so the outer terminal's theme wins. Pane titles refresh on `pty rename`.
- Requires `@myobie/pty ^0.10.0` and Node 25+.
