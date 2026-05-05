# Changelog

## Unreleased

- Fix Ctrl+W (and other Ctrl-letter / Alt-letter / Ctrl+Alt-letter combos) inserting literal `\e[…u` garbage in panes whose foreground program doesn't speak the kitty keyboard protocol (bash readline, naive curses apps). When the focused pane has no kitty keyboard flags pushed, CSI u sequences other than our own keybindings (`^]`, `^\`) are translated back to their legacy byte form before reaching the pane.
- Fix paste of literal text into a program reading raw stdin (`gets`, `fgets`, bash `read`, etc.) showing `\e[200~ … \e[201~` markers around the content. Markers are now stripped when the focused pane's `bracketedPasteMode` is off — bash readline still gets paste-as-paste at the prompt, but a pasted line into a `read` builtin or naive CLI arrives clean. Needs the next `@myobie/pty` release (uses the new `PtyHandle.bracketedPasteMode` getter on pty main, post-0.10.0).
- Cross-call buffering of partial CSI u and bracketed-paste sequences so OS-level read fragmentation during paste / mid-keystroke doesn't leak ESC garbage to the pane.

## 0.1.0

Initial release.

- Tag-driven pane model: every pane is a `@myobie/pty` daemon session with a tag the layout watches. Auto-tag mode uses a reserved per-instance key; `--tag` mode joins a shared workspace. `pty gc` prunes orphaned layout tags.
- Layouts: grid, stacked, single, opt-in zoom. `--layouts` flag to customize the cycle.
- Text selection with click-drag, OSC 52 copy. Shift-click extends across scroll boundaries; scrolling keeps the selection pinned. Wrap-aware copy (no spurious newlines in wrapped URLs / JSON).
- `--tmux` shim covers enough of tmux's surface (`split-window`, `send-keys`, `list-panes`, `kill-pane`, `display-message`, `has-session`, `new-session`, `TMUX_PANE`) to host [Claude Code agent-teams](https://code.claude.com/docs/en/agent-teams). PATH-preserving shell init wrappers for bash and zsh.
- Session picker, `^]` command overlay, `pty-layout new` subcommand for scripting new tagged panes.
- Palette-indexed SGR colors from pane content round-trip intact so the outer terminal's theme wins. Pane titles refresh on `pty rename`.
- Requires `@myobie/pty ^0.10.0` and Node 25+.
