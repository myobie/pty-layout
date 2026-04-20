# Changelog

## Unreleased

_Nothing yet. Add entries above release cuts._

## 0.1.0

Initial release. Everything that's in here was iterated on heavily — this changelog treats it as one shipped thing so the historical messiness doesn't leak.

### Tag-driven architecture
- Every pane is a pty daemon session carrying a tag the layout watches. No in-memory session list, no "local panes" — just the subscription.
- **Auto-tag mode** (default): pty-layout generates a reserved per-instance key `:l<pid>-<rand>`, writes it via `updateTags()` when the user opens a pane, removes it when the user closes a pane. The `:` prefix keeps the key out of `pty list` default output.
- **Explicit `--tag` mode**: read-only shared-workspace view. Close is disabled (the tag is user-owned; evicting would silently remove the session from other layouts watching the same tag).
- **Crash recovery**: `pty gc` prunes orphan `:l<pid>-<rand>` tags whose encoded PID is no longer alive. If pty-layout is SIGKILL'd, tags don't linger forever.
- **`pty-layout new` subcommand**: reads `$PTY_LAYOUT_FILTER_TAG` from the shell's env, spawns a tagged daemon, auto-appears in the layout. Scripting primitive for any tool that wants to drop a pane into the current layout.

### Layouts
- **grid** — all panes equal size.
- **stacked** — focused pane expanded, others collapse to a 1-row title strip. Collapsed panes keep their last focused PTY size (no reflow on toggle).
- **single** — only the focused pane renders.
- **zoom** — opt-in via `--layouts=+zoom`. Default cycle excludes it.
- **`--layouts`** CLI flag to customize the cycle: `--layouts=+zoom` adds zoom at the end. Unknown names or non-`+` tokens error clearly.
- Status bar shows a layout badge: `[abcxyz]` for auto-tag, `[key=value]` for explicit.

### Selection, scrolling, cursor
- Text selection via click-drag. OSC 52 copy to clipboard.
- **Wrap-aware copy**: uses `PtyHandle.readWrappedFlags()` (pty 0.9+) so visually-wrapped long lines round-trip as a single logical line in the clipboard — no spurious newlines in URLs, JSON, command lines.
- Selection translates to the current scroll: when you scroll, the highlight follows the content, not the screen position.
- Cursor renders at the correct screen row when scrolled back; hidden when scrolled past the live viewport.
- Typing into the focused pane snaps its scroll to the live prompt so you can see what you type.
- Scroll offset anchors when baseY advances (new output doesn't visually yank the scrollback position).
- **Flash-of-scrollback** on window resize mitigated by debouncing resize events (80ms) — PTY buffers finish reflowing before we render.

### `--tmux` shim
- Drop-in replacement for a subset of tmux (`split-window`, `send-keys`, `list-panes`, `kill-pane`, `display-message`, `has-session`, `new-session`, version probe, no-ops for `set-option`, `select-layout`, `capture-pane`, etc.).
- Makes [Claude Code's experimental agent-teams](https://code.claude.com/docs/en/agent-teams) work inside pty-layout.
- Sets `TMUX`, `TMUX_PANE`, `PTY_LAYOUT_FILTER_TAG` on every picker-spawned shell. `TMUX_PANE` is load-bearing — Claude Code reads it directly before falling back to `tmux display-message`.
- Teammate sessions get their own `TMUX_PANE` via `/usr/bin/env TMUX_PANE=%<new-id>` wrapper on the spawned command.
- **PATH fix for users with rc-level PATH manipulation**: shell init wrappers (`--rcfile` for bash, `ZDOTDIR` for zsh) source the user's normal rc then re-prepend the shim dir. Beats `brew shellenv` and similar. Works for the user's actual `$SHELL` (including Homebrew bash 5.x, not just Apple's `/bin/bash` 3.2.57).
- Fish and other shells spawn without wrappers; users whose fish config reprepends PATH can add a one-liner documented in the tmux-mode setup.
- Paste markers (`\x1b[200~...\x1b[201~`) and kitty keyboard protocol sequences pass through the prefix-Esc handler correctly.
- **Bracketed paste enabled** on the outer terminal (`?2004h`), so multi-line pastes into editors like helix don't trigger per-line auto-indent.

### Picker
- Shows all local sessions (not filtered by layout's own tag). Picking applies the scope tag; session appears as a pane.
- Remote sessions via `pty-relay` still work but stay as local-process panes (they don't participate in the tag subscription — a remote session lives in a different daemon).
- Fuzzy filter; `host/session` syntax for remote host narrowing.

### Keybindings
- `^]` prefix with sticky keys (`,`, `.`, `l`, `m`) for chainable navigation / layout cycling.
- Bare Esc consumed as cancel (never leaks to focused pane).
- Kitty keyboard protocol variants of Esc (`\x1b[27u`, `\x1b[27;<mod>u`) also treated as cancel.
- Prefix overlay auto-widens for long title text; move-mode overlay shows `1-9 position` (letters after 9 are self-evident).

### Tests
- 439 tests: 18 unit test files covering the pure logic layer (selection math, scroll anchoring, layout math, tmux-shim argv translation, key translation, bracketed-paste passthrough, layout-tag regex/badge, new-subcommand parsing, shim-env builder) and end-to-end integration tests (spawning pty-layout in a real PTY, verifying focus/scroll/tag-subscription behavior).
- Integration tests run against an isolated `PTY_SESSION_DIR` in `/tmp` so the user's real pty sessions are never touched.
- 50-session safety canary in the test runner — prevents leaked daemons from accumulating across test runs.

### Dependencies
- `@myobie/pty ^0.9.0` — requires `updateTags`, `readWrappedFlags`, `pruneOrphanLayoutTags`, `isReservedTagKey`.
