#!/usr/bin/env node --experimental-strip-types --no-warnings
import { hideCursor, showCursor, reset } from "@myobie/pty/tui";
import {
  calculateLayout,
  nextLayoutMode,
  parseLayoutsFlag,
  DEFAULT_LAYOUT_MODES,
  type LayoutMode,
  type PaneRect,
} from "./layout.ts";
import { createAttachPane, createLocalPane, closePane, sessionPaneTitle, type Pane } from "./pane.ts";
import { renderFrame, clearCellCache, renderSessionPicker, renderPrefixOverlay } from "./render.ts";
import { processInput, isPrefixPending, setPrefixPending } from "./keys.ts";
import {
  type SelectionState,
  hasDragDistance,
  extractSelectedText,
  copyToClipboard,
  screenToPaneLocal,
  clampToInner,
} from "./selection.ts";
import { CellBuffer, fullRender, moveTo, fg, bg, visibleLength, RESET, spawnDaemon } from "@myobie/pty/tui";
import { updateTags } from "@myobie/pty/client";
import {
  type PickerState,
  createPickerState,
  refreshPicker,
  filterPicker,
  moveSelection,
  randomSessionId,
  buildRemoteConnectUrl,
  formatSessionLabel,
} from "./session-picker.ts";
import {
  type TagFilter,
  TagSubscription,
  parseTagFilter,
  formatTagFilters,
} from "./tag-subscription.ts";
import { startStats, newLaunchId } from "./stats.ts";
import { adjustScrollOffset } from "./scroll.ts";
import { buildShimEnv } from "./shim-env.ts";
import { newLayoutTagKey, formatLayoutBadge } from "./layout-tag.ts";
import { parseNewSubcommand, parseFilterTagEnv } from "./new-subcommand.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_main = path.dirname(fileURLToPath(import.meta.url));
function shimDir(): string {
  return path.resolve(__dirname_main, "../shim");
}


const enterAltScreen = "\x1b[?1049h";
const leaveAltScreen = "\x1b[?1049l";
const enableMouse = "\x1b[?1002h\x1b[?1006h"; // button-motion tracking + SGR encoding
const disableMouse = "\x1b[?1006l\x1b[?1002l";
// Bracketed paste: tells the outer terminal "wrap user pastes in
// \x1b[200~...\x1b[201~". Those markers pass through our input handler
// untouched (end in `~`, not a key we parse) and reach the focused
// pane's app. Editors like helix/vim see the markers and skip
// auto-indent for the pasted content — fixes the "each pasted line
// gets more indented" bug.
const enableBracketedPaste = "\x1b[?2004h";
const disableBracketedPaste = "\x1b[?2004l";
const STATUS_BAR_HEIGHT = 1;

// --- State ---

let panes: Pane[] = [];
let focusedIndex = 0;
let layoutMode: LayoutMode = "grid";
let enabledLayouts: LayoutMode[] = [...DEFAULT_LAYOUT_MODES];
let prevBuffer: CellBuffer | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let renderTimerDelay = 16;
let running = false;
let lastLayout: { paneIndex: number; rect: PaneRect }[] = [];
let scrollOffsets: number[] = []; // per-pane scroll offset (0 = live viewport)
let scrollLastBaseY: number[] = []; // per-pane snapshot of baseY for anchor math
let selection: SelectionState | null = null;
let tagSubscription: TagSubscription | null = null;
// Filters driving the subscription. In auto-tag mode, this is
// [{ key: layoutTagKey, value: "1" }]. In explicit --tag mode, it's the
// user's tags.
let tagFilters: TagFilter[] = [];
// The per-layout-instance tag key (`:l<pid>-<rand>`). Always set when
// auto-tag mode is active. `null` in explicit --tag mode — we don't
// write tags there, we only read.
let layoutTagKey: string | null = null;
// Session names for CLI-spec spawns that haven't arrived through the
// subscription yet. When they finally fire onAdd, we skip the auto-focus
// so initial panes don't fight for focus. Entries are removed when the
// matching onAdd fires.
const startupPendingNames = new Set<string>();
// Session names the user explicitly initiated (picker "+ New session").
// When their session_start event arrives, focus the new pane so the
// user sees their creation. Non-user-initiated adds (tmux shim teammates,
// sessions appearing via explicit --tag shared workspace) skip focus
// so they don't yank the user out of their current pane.
const focusOnAddNames = new Set<string>();
// Auto-tag mode: we own the tag, so picker applies it, close removes it,
// quit cleans up. Explicit-tag mode: user owns the tag, we only subscribe.
let autoTagMode = false;
let tmuxMode = false;
let showingSessionPicker = false;
let pickerState: PickerState | null = null;
let moveMode = false; // true between ^] m and the position key that follows
let stopStats: (() => void) | null = null;

// --- Terminal helpers ---

function getSize(): [number, number] {
  return [
    (process.stdout as any).rows ?? 24,
    (process.stdout as any).columns ?? 80,
  ];
}

// --- Render scheduling ---
// Immediate: focused pane echo after keystroke — near-zero input latency.
// Normal (8ms): background activity from unfocused panes.

let expectingFocusedEcho = false;
let renderImmediate: ReturnType<typeof setImmediate> | null = null;

function scheduleRender(urgent = false) {
  if (!running) return;

  if (urgent) {
    // Cancel any pending normal timer — immediate wins
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (renderImmediate === null) {
      renderImmediate = setImmediate(() => {
        renderImmediate = null;
        doRender();
      });
    }
    return;
  }

  // Normal: 8ms delay (skip if an immediate render is pending)
  if (renderImmediate !== null || renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    doRender();
  }, 8);
}

// --- Mode proxying to outer terminal ---
// When focused pane has kitty keyboard protocol active, forward it to Kitty.
// On focus change, retract old pane's modes and apply new pane's modes.

let proxiedKittyFlags: number[] = [];

function syncModesToTerminal() {
  const focused = panes[focusedIndex];
  const newFlags = focused?.handle.kittyKeyboardFlags ?? [];

  // Only write if flags changed
  if (newFlags.length === proxiedKittyFlags.length &&
      newFlags.every((f, i) => f === proxiedKittyFlags[i])) {
    return;
  }

  // Pop old flags
  for (let i = 0; i < proxiedKittyFlags.length; i++) {
    process.stdout.write("\x1b[<u");
  }

  // Push new flags
  for (const flags of newFlags) {
    process.stdout.write(`\x1b[>${flags}u`);
  }

  proxiedKittyFlags = [...newFlags];
}

function doRender() {
  if (!running) return;
  syncModesToTerminal();

  if (panes.length === 0) {
    const [totalRows, totalCols] = getSize();
    renderEmptyState(totalRows, totalCols);
    return;
  }

  const [totalRows, totalCols] = getSize();
  if (totalRows < 4 || totalCols < 4) return;

  // Anchor scroll offsets: when baseY advances (new output), bump offsets
  // so panes that are scrolled back stay pinned to the same absolute lines.
  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i]!;
    const adjusted = adjustScrollOffset(
      { offset: scrollOffsets[i] ?? 0, lastBaseY: scrollLastBaseY[i] ?? 0 },
      pane.handle.baseY,
    );
    scrollOffsets[i] = adjusted.offset;
    scrollLastBaseY[i] = adjusted.lastBaseY;
  }

  const rects = calculateLayout(
    layoutMode,
    panes.length,
    totalRows,
    totalCols,
    STATUS_BAR_HEIGHT,
    focusedIndex,
  );

  // Store layout for mouse hit-testing
  if (layoutMode === "single") {
    lastLayout = rects[0] ? [{ paneIndex: focusedIndex, rect: rects[0] }] : [];
  } else {
    lastLayout = rects.map((rect, i) => ({ paneIndex: i, rect }));
  }

  const { output, buffer } = renderFrame(
    panes,
    rects,
    focusedIndex,
    layoutMode,
    totalRows,
    totalCols,
    prevBuffer,
    isPrefixPending(),
    scrollOffsets,
    selection,
    showingSessionPicker ? pickerState : null,
    moveMode,
    /*readOnlyTagMode=*/!autoTagMode,
    formatLayoutBadge(tagFilters, layoutTagKey),
  );

  process.stdout.write(output);
  prevBuffer = buffer;
}

// --- Pane management ---

function addPane(pane: Pane, opts: { focus?: boolean } = {}) {
  pane.handle.onActivity = () => {
    const urgent = panes[focusedIndex] === pane && expectingFocusedEcho;
    if (urgent) expectingFocusedEcho = false;
    scheduleRender(urgent);
    if (pane.handle.exited) {
      setTimeout(() => removePane(pane), 50);
    }
  };
  const wasEmpty = panes.length === 0;
  panes.push(pane);
  scrollOffsets.push(0);
  scrollLastBaseY.push(pane.handle.baseY);
  // Default: focus the new pane (runtime adds — user just picked it, or
  // the shim spawned a teammate they want to see). Startup hydration
  // passes focus=false so the initial panes don't fight each other for
  // focus as the subscription's initialSessions all add in sequence.
  const shouldFocus = opts.focus ?? true;
  if (wasEmpty || shouldFocus) {
    focusedIndex = panes.length - 1;
  }
  prevBuffer = null;
  scheduleRender();
}

function removePane(pane: Pane) {
  const idx = panes.indexOf(pane);
  if (idx === -1) return;
  clearCellCache(pane.id);
  closePane(pane);
  panes.splice(idx, 1);
  scrollOffsets.splice(idx, 1);
  scrollLastBaseY.splice(idx, 1);

  if (panes.length === 0) {
    if (autoTagMode && !showingSessionPicker) {
      // Reopen the picker instead of exiting. Explicit quit is ^] q.
      // In explicit --tag mode we don't reopen — the user set up a
      // passive-watch view and an empty-state is valid.
      openSessionPicker();
      return;
    }
    prevBuffer = null;
    scheduleRender();
    return;
  }

  if (idx < focusedIndex) {
    focusedIndex--;
  } else if (focusedIndex >= panes.length) {
    focusedIndex = panes.length - 1;
  }
  prevBuffer = null;
  scheduleRender();
}

/** Best-effort remove the layout's tag from a session. Called when the
 *  user closes a pane in auto-tag mode — the session keeps running, it
 *  just drops out of this layout's view. No-op (and silent) if the
 *  session or metadata is already gone. */
async function untagSession(sessionName: string): Promise<void> {
  if (!autoTagMode || !layoutTagKey) return;
  try {
    await updateTags(sessionName, {}, [layoutTagKey]);
  } catch {
    // Session exited, metadata gone, or permissions issue. Harmless;
    // pty gc will clean up the orphan if any, or the session is already
    // gone so the tag is too.
  }
  tagSubscription?.untrack(sessionName);
}

function removeFocusedPane() {
  if (panes.length === 0) return;
  const pane = panes[focusedIndex];

  // Fire-and-forget untag. In auto-tag mode the session keeps running
  // but drops out of the subscription so the event follower's
  // session_exit handler won't double-remove.
  if (pane.source.type === "session") {
    void untagSession(pane.source.name);
  }

  clearCellCache(pane.id);
  closePane(pane);
  panes.splice(focusedIndex, 1);
  scrollOffsets.splice(focusedIndex, 1);
  scrollLastBaseY.splice(focusedIndex, 1);

  if (panes.length === 0) {
    if (autoTagMode && !showingSessionPicker) {
      // Reopen the picker instead of exiting. Explicit quit is ^] q.
      openSessionPicker();
      return;
    }
    prevBuffer = null;
    scheduleRender();
    return;
  }

  focusedIndex = Math.min(focusedIndex, panes.length - 1);
  prevBuffer = null;
  scheduleRender();
}

// --- Mouse hit-testing ---

function findPaneAtPosition(row: number, col: number): number {
  for (const { paneIndex, rect } of lastLayout) {
    if (
      row >= rect.outerRow &&
      row < rect.outerRow + rect.outerHeight &&
      col >= rect.outerCol &&
      col < rect.outerCol + rect.outerWidth
    ) {
      return paneIndex;
    }
  }
  return -1;
}

// --- Cleanup ---

function detach() {
  if (!running) return;
  running = false;
  tagSubscription?.stop();
  stopStats?.();
  stopStats = null;
  // Pop any proxied kitty keyboard flags
  for (let i = 0; i < proxiedKittyFlags.length; i++) {
    process.stdout.write("\x1b[<u");
  }
  proxiedKittyFlags = [];

  // Best-effort: strip the layout tag from every session-backed pane
  // so the session drops out of views. If this process is SIGKILL'd
  // before we reach here, `pty gc` prunes the orphaned `:l<pid>-<rand>`
  // tags on the next run. Fire-and-forget — we're exiting anyway.
  if (autoTagMode && layoutTagKey) {
    for (const pane of panes) {
      if (pane.source.type === "session") {
        try { updateTags(pane.source.name, {}, [layoutTagKey]); } catch {}
      }
    }
  }

  // Detach: release handles but don't kill processes.
  // For attached sessions, handle.kill() sends detach (not terminate).
  // For local createPty processes, they'll be cleaned up when our process exits.
  for (const pane of panes) {
    pane.handle.kill();
  }
  process.stdout.write(disableMouse + disableBracketedPaste + showCursor() + reset() + leaveAltScreen);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

// --- Input handling ---

function openSessionPicker() {
  showingSessionPicker = true;
  pickerState = createPickerState();
  prevBuffer = null;
  scheduleRender();

  // Picker shows ALL local/remote sessions, not just ones already
  // carrying our tag. The picker flow is "select a session to PULL into
  // this layout" — we'll apply the layout tag on selection. Filtering
  // here would just hide the candidates the user is trying to pull in.
  refreshPicker([], (state) => {
    if (showingSessionPicker) {
      // Preserve current filter and selection if user already typed
      if (pickerState && pickerState.filter.length > 0) {
        pickerState = filterPicker({ ...state, allGroups: state.allGroups }, pickerState.filter);
      } else {
        pickerState = state;
      }
      prevBuffer = null;
      scheduleRender();
    }
  });
}

function closeSessionPicker() {
  showingSessionPicker = false;
  pickerState = null;
  prevBuffer = null;
  scheduleRender();
}

async function selectPickerItem() {
  if (!pickerState) return;
  const item = pickerState.flatItems[pickerState.selectedIndex];
  if (!item) return;

  closeSessionPicker();

  switch (item.type) {
    case "create-local": {
      // Always stamp the subscription's tags on the new session so that
      // the TagSubscription's event-follower picks up session_start and
      // auto-adds the pane. No `create-local` attach-eagerly branch —
      // the subscription is the single source of truth for panes now.
      const tags = Object.fromEntries(
        tagFilters.filter((f) => f.value !== undefined).map((f) => [f.key, f.value!]),
      );
      const userShell = (process.env.SHELL && process.env.SHELL.length > 0)
        ? process.env.SHELL
        : "/bin/bash";
      const cwd = process.env.HOME ?? process.cwd();
      const name = randomSessionId();

      // In --tmux mode we need the shim dir to beat the user's rc
      // reorderings of PATH (brew shellenv etc.). The bash function
      // trick only works for shell-mediated invocations — tools that
      // use execvp directly (like Claude Code's tmux spawner) hit PATH
      // lookup instead. Fix: spawn the shell with rcfile/ZDOTDIR that
      // re-prepends PATH AFTER the user's normal rc runs.
      let command = userShell;
      let shellArgs: string[] = [];
      let env: Record<string, string> | undefined;
      if (tmuxMode) {
        const shellInit = path.join(shimDir(), "shell-init");
        env = buildShimEnv(tagFilters, shimDir(), process.env, name);
        const shellBase = path.basename(userShell);
        if (shellBase === "zsh") {
          env.ZDOTDIR = shellInit;
        } else if (shellBase === "bash") {
          shellArgs = ["--rcfile", path.join(shellInit, "bashrc"), "-i"];
        }
      }

      // User asked for this session — mark for focus-on-arrival.
      focusOnAddNames.add(name);
      try {
        await spawnDaemon({
          name,
          command,
          args: shellArgs,
          displayCommand: userShell,
          cwd,
          tags,
          ...(env ? { env } : {}),
        });
        // The subscription's event follower will see session_start and
        // add the pane. Nothing to do here on success.
      } catch (err) {
        focusOnAddNames.delete(name);
        process.stderr.write(`pty-layout: failed to create session: ${(err as Error).message}\n`);
        openSessionPicker();
      }
      break;
    }
    case "create-remote": {
      // Remote sessions remain local-process panes (pty-relay connect).
      // They don't participate in the tag system — a remote session
      // lives in a different daemon and would need a cross-daemon tag
      // RPC to be subscribed-to. For now, carry the layout's tag as
      // `--tag` args so the remote session is tagged on the remote end
      // (useful if someone else is watching that tag over there).
      const tagArgs = tagFilters
        .filter((f) => f.value !== undefined)
        .flatMap((f) => ["--tag", `${f.key}=${f.value}`]);
      const name = `remote-${Date.now()}`;
      const title = item.hostLabel ? `@${item.hostLabel}/${name}` : `@${name}`;
      const pane = createLocalPane(
        "pty-relay",
        ["connect", item.relayUrl!, "--spawn", name, ...tagArgs],
        title,
      );
      addPane(pane);
      break;
    }
    case "local": {
      // Apply the layout's tag to the existing session so it becomes
      // part of this layout's subscription. In auto-tag mode (we own
      // the tag), this is harmless — only this layout watches for it.
      // In explicit --tag mode, the tag key is the user's choice and
      // applying it makes the session visible to other layouts watching
      // that same tag (intentional: shared workspace).
      const sessionName = item.sessionName!;
      try {
        const tags = Object.fromEntries(
          tagFilters.filter((f) => f.value !== undefined).map((f) => [f.key, f.value!]),
        );
        if (Object.keys(tags).length > 0) {
          await updateTags(sessionName, tags, []);
        }
        // Eager pane add — updateTags doesn't emit a session_start event,
        // so the subscription wouldn't pick this session up. Track it
        // explicitly, attach now.
        const pane = await createAttachPane(sessionName);
        if (tagSubscription) tagSubscription.track(sessionName);
        addPane(pane);
      } catch (err) {
        process.stderr.write(`pty-layout: failed to attach to ${sessionName}: ${(err as Error).message}\n`);
        openSessionPicker();
      }
      break;
    }
    case "remote": {
      const url = buildRemoteConnectUrl(item.relayUrl!, item.sessionName!);
      const label = formatSessionLabel(item.sessionName!, item.sessionDisplayName);
      const title = item.hostLabel
        ? `@${item.hostLabel}/${label}`
        : `@${label}`;
      const pane = createLocalPane("pty-relay", ["connect", url], title);
      addPane(pane);
      break;
    }
  }
}

function handlePickerInput(data: Buffer) {
  const str = data.toString("utf8");
  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);

    // ESC — might be Esc key or start of arrow key sequence
    if (code === 0x1b) {
      if (i + 2 < str.length && str[i + 1] === "[") {
        const dir = str[i + 2];
        if (dir === "A") { // Up arrow
          if (pickerState) {
            pickerState = moveSelection(pickerState, -1);
            prevBuffer = null;
            scheduleRender();
          }
          i += 3;
          continue;
        } else if (dir === "B") { // Down arrow
          if (pickerState) {
            pickerState = moveSelection(pickerState, 1);
            prevBuffer = null;
            scheduleRender();
          }
          i += 3;
          continue;
        }
      }
      // Bare Esc — close picker (user can ^] q to quit)
      closeSessionPicker();
      i++;
      continue;
    }

    // Enter — select
    if (code === 0x0d) {
      selectPickerItem().catch((err) => {
        process.stderr.write(`pty-layout: picker selection failed: ${(err as Error).message}\n`);
        openSessionPicker();
      });
      return; // picker is closed, stop processing
    }

    // Backspace
    if (code === 0x7f || code === 0x08) {
      if (pickerState && pickerState.filter.length > 0) {
        pickerState = filterPicker(pickerState, pickerState.filter.slice(0, -1));
        prevBuffer = null;
        scheduleRender();
      }
      i++;
      continue;
    }

    // Ctrl+] — swap to the command overlay (picker ↔ prefix modal).
    if (code === 0x1d) {
      closeSessionPicker();
      setPrefixPending(true);
      scheduleRender();
      i++;
      continue;
    }

    // Ctrl+C — close picker
    if (code === 0x03) {
      closeSessionPicker();
      i++;
      continue;
    }

    // Printable characters — append to filter
    const ch = str[i]!;
    if (ch >= " " && ch <= "~") {
      if (pickerState) {
        pickerState = filterPicker(pickerState, pickerState.filter + ch);
        prevBuffer = null;
        scheduleRender();
      }
    }
    i++;
  }
}

function handleStdin(data: Buffer) {
  if (showingSessionPicker) {
    handlePickerInput(data);
    return;
  }

  const focused = panes[focusedIndex];
  const wasPrefixed = isPrefixPending();
  expectingFocusedEcho = false;

  // If there's a focused pane, non-command bytes forward to it.
  // Otherwise drop them — but commands (Ctrl+], Ctrl+\) still work so the
  // user can quit or open the picker from a bare empty state.
  const actions = processInput(data, (s) => {
    if (focused && !focused.handle.exited) {
      focused.handle.write(s);
      expectingFocusedEcho = true;
      // User typed — snap the focused pane to the live viewport so they
      // can see what they're typing. Only resets scroll for the focused
      // pane; unfocused panes keep their scroll position.
      if ((scrollOffsets[focusedIndex] ?? 0) > 0) {
        scrollOffsets[focusedIndex] = 0;
        scrollLastBaseY[focusedIndex] = focused.handle.baseY;
        prevBuffer = null;
      }
    }
  });

  if (isPrefixPending() !== wasPrefixed) {
    // If prefix mode exits without a follow-up position key (e.g. Esc),
    // cancel move mode too.
    if (!isPrefixPending() && moveMode && actions.every((a) => a.type !== "focusIndex")) {
      moveMode = false;
    }
    prevBuffer = null;
    scheduleRender();
  }

  for (const action of actions) {
    switch (action.type) {
      case "cycleLayout":
        layoutMode = nextLayoutMode(layoutMode, enabledLayouts);
        prevBuffer = null;
        scheduleRender();
        break;

      case "focusIndex":
        if (moveMode) {
          moveMode = false;
          const targetIdx = action.index!;
          if (targetIdx >= 0 && targetIdx < panes.length && targetIdx !== focusedIndex) {
            const pane = panes[focusedIndex]!;
            const offset = scrollOffsets[focusedIndex] ?? 0;
            const lastBaseY = scrollLastBaseY[focusedIndex] ?? 0;
            panes.splice(focusedIndex, 1);
            scrollOffsets.splice(focusedIndex, 1);
            scrollLastBaseY.splice(focusedIndex, 1);
            panes.splice(targetIdx, 0, pane);
            scrollOffsets.splice(targetIdx, 0, offset);
            scrollLastBaseY.splice(targetIdx, 0, lastBaseY);
            focusedIndex = targetIdx;
            prevBuffer = null;
            scheduleRender();
          } else {
            prevBuffer = null;
            scheduleRender();
          }
        } else if (action.index! >= 0 && action.index! < panes.length) {
          focusedIndex = action.index!;
          prevBuffer = null;
          scheduleRender();
        }
        break;

      case "movePane":
        if (panes.length > 1) {
          moveMode = true;
          prevBuffer = null;
          scheduleRender();
        }
        break;

      case "focusPrev":
        if (panes.length > 1) {
          focusedIndex = (focusedIndex - 1 + panes.length) % panes.length;
          prevBuffer = null;
          scheduleRender();
        }
        break;

      case "focusNext":
        if (panes.length > 1) {
          focusedIndex = (focusedIndex + 1) % panes.length;
          prevBuffer = null;
          scheduleRender();
        }
        break;

      case "newShell":
        openSessionPicker();
        break;

      case "closePane":
        if (!autoTagMode) {
          // Explicit --tag mode: the tag is user-owned and shared with
          // other pty-layouts. Closing via untag would silently evict
          // the session from everyone else's view. Disabled.
          break;
        }
        removeFocusedPane();
        break;


      case "mouseDown": {
        const clickIdx = findPaneAtPosition(action.row!, action.col!);
        if (clickIdx === -1) break;
        const clickPane = panes[clickIdx]!;

        // Shift+click extends an existing selection in the same pane
        // rather than starting a new one. This lets the user select
        // text that's larger than a single screen: click to start,
        // scroll, shift+click to extend the endpoint.
        const isShiftExtend = !!action.shift
          && selection
          && selection.paneIndex === clickIdx;

        if (!isShiftExtend && selection && !selection.active) {
          // Clear any completed selection
          selection = null;
          prevBuffer = null;
        }

        // Focus the pane
        if (clickIdx !== focusedIndex) {
          focusedIndex = clickIdx;
          prevBuffer = null;
        }

        if (clickPane.handle.mouseMode) {
          // Forward to mouse-mode pane
          const clickEntry = lastLayout.find(l => l.paneIndex === clickIdx);
          if (clickEntry) {
            const cr = clickEntry.rect;
            const relCol = action.col! - cr.innerCol + 1;
            const relRow = action.row! - cr.innerRow + 1;
            if (relCol >= 1 && relCol <= cr.innerWidth && relRow >= 1 && relRow <= cr.innerHeight) {
              clickPane.handle.write(`\x1b[<0;${relCol};${relRow}M`);
            }
          }
        } else {
          const clickEntry = lastLayout.find(l => l.paneIndex === clickIdx);
          if (clickEntry) {
            const local = screenToPaneLocal(action.row!, action.col!, clickEntry.rect);
            const clamped = clampToInner(local.row, local.col, clickEntry.rect);

            if (isShiftExtend && selection) {
              // Extend: move the end to the click position at the
              // current scroll. Translate click-screen coords back to
              // the selection's captured scroll frame so the endpoint
              // tracks content if the user scrolled in between.
              const deltaScroll = (scrollOffsets[clickIdx] ?? 0) - selection.scrollOffset;
              selection = {
                ...selection,
                endRow: clamped.row - deltaScroll,
                endCol: clamped.col,
                active: true,
              };
            } else {
              // Start fresh selection
              selection = {
                paneId: clickPane.id,
                paneIndex: clickIdx,
                scrollOffset: scrollOffsets[clickIdx] ?? 0,
                startRow: clamped.row,
                startCol: clamped.col,
                endRow: clamped.row,
                endCol: clamped.col,
                active: true,
              };
            }
          }
        }
        scheduleRender();
        break;
      }

      case "mouseDrag": {
        if (!selection || !selection.active) break;
        const dragPane = panes[selection.paneIndex];
        if (!dragPane) break;

        if (dragPane.handle.mouseMode) {
          // Forward drag to mouse-mode pane
          const dragEntry = lastLayout.find(l => l.paneIndex === selection!.paneIndex);
          if (dragEntry) {
            const dr = dragEntry.rect;
            const relCol = action.col! - dr.innerCol + 1;
            const relRow = action.row! - dr.innerRow + 1;
            if (relCol >= 1 && relCol <= dr.innerWidth && relRow >= 1 && relRow <= dr.innerHeight) {
              dragPane.handle.write(`\x1b[<32;${relCol};${relRow}M`);
            }
          }
          selection = null;
          break;
        }

        const dragEntry = lastLayout.find(l => l.paneIndex === selection!.paneIndex);
        if (dragEntry) {
          const local = screenToPaneLocal(action.row!, action.col!, dragEntry.rect);
          const clamped = clampToInner(local.row, local.col, dragEntry.rect);
          selection.endRow = clamped.row;
          selection.endCol = clamped.col;
          if (hasDragDistance(selection)) {
            prevBuffer = null;
            scheduleRender();
          }
        }
        break;
      }

      case "mouseUp": {
        if (!selection) break;
        const upPane = panes[selection.paneIndex];

        if (upPane?.handle.mouseMode) {
          // Forward release to mouse-mode pane
          const upEntry = lastLayout.find(l => l.paneIndex === selection!.paneIndex);
          if (upEntry) {
            const ur = upEntry.rect;
            const relCol = action.col! - ur.innerCol + 1;
            const relRow = action.row! - ur.innerRow + 1;
            if (relCol >= 1 && relCol <= ur.innerWidth && relRow >= 1 && relRow <= ur.innerHeight) {
              upPane.handle.write(`\x1b[<0;${relCol};${relRow}m`);
            }
          }
          selection = null;
          break;
        }

        selection.active = false;

        if (hasDragDistance(selection) && upPane && !upPane.handle.exited) {
          // Copy selected text to clipboard via OSC 52. Use the wrapped
          // flags so long lines that were visually wrapped by xterm
          // round-trip as single logical lines (URLs, JSON, commands)
          // instead of getting spurious \n at each row boundary.
          //
          // Reading cells/flags can throw if the pane's terminal was
          // disposed between mousedown and mouseup (e.g. the session
          // exited mid-drag). Swallow the error and keep the selection
          // state clean rather than crashing the whole app.
          try {
            const cells = upPane.handle.readCells(selection.scrollOffset);
            const wrapped = typeof upPane.handle.readWrappedFlags === "function"
              ? upPane.handle.readWrappedFlags(selection.scrollOffset)
              : undefined;
            const text = extractSelectedText(cells, selection, wrapped);
            if (text.length > 0) {
              process.stdout.write(copyToClipboard(text));
            }
            // Keep selection visible (highlight stays until next click)
          } catch {
            // Pane disposed mid-drag; just drop the selection.
            selection = null;
          }
        } else {
          // Just a click, no drag — clear selection
          selection = null;
        }
        prevBuffer = null;
        scheduleRender();
        break;
      }

      case "scrollUp":
      case "scrollDown": {
        const scrollIdx = findPaneAtPosition(action.row!, action.col!);
        if (scrollIdx === -1) break;
        const scrollPane = panes[scrollIdx]!;

        // Preserve selection across scroll — selection coords are scroll-
        // aware (translated via isSelectedAtScroll at render time and the
        // captured scroll offset at copy time). Users can scroll to reach
        // content beyond a single screen, then shift-click to extend.

        if (scrollPane.handle.mouseMode) {
          // Child wants mouse events — forward translated SGR sequence
          const scrollEntry = lastLayout.find(l => l.paneIndex === scrollIdx);
          if (scrollEntry) {
            const sr = scrollEntry.rect;
            const relCol = action.col! - sr.innerCol + 1;
            const relRow = action.row! - sr.innerRow + 1;
            if (relCol >= 1 && relCol <= sr.innerWidth &&
                relRow >= 1 && relRow <= sr.innerHeight) {
              const btn = action.type === "scrollUp" ? 64 : 65;
              scrollPane.handle.write(`\x1b[<${btn};${relCol};${relRow}M`);
            }
          }
        } else if (scrollPane.handle.alternateScreen) {
          // Alternate screen without mouse mode (TUI apps like claude, htop, less)
          // Convert scroll to arrow keys, like Kitty does natively
          const arrow = action.type === "scrollUp" ? "\x1b[A" : "\x1b[B";
          scrollPane.handle.write(arrow.repeat(3));
        } else {
          // Normal screen, no mouse mode — scroll through scrollback buffer
          const offset = scrollOffsets[scrollIdx] ?? 0;
          if (action.type === "scrollUp") {
            scrollOffsets[scrollIdx] = Math.min(offset + 3, scrollPane.handle.baseY);
          } else {
            scrollOffsets[scrollIdx] = Math.max(offset - 3, 0);
          }
          // Snapshot baseY so future new output anchors correctly
          scrollLastBaseY[scrollIdx] = scrollPane.handle.baseY;
          prevBuffer = null;
          scheduleRender();
        }
        break;
      }

      case "detach":
        // Ctrl+\ removes the focused pane from the layout (in auto-tag
        // mode, via untag). Empty state quits the app. In explicit --tag
        // mode, detaching would evict from everyone's view — disabled.
        if (!autoTagMode) break;
        if (panes.length === 0) {
          detach();
          process.exit(0);
        } else {
          removeFocusedPane();
        }
        break;

      case "quit":
        detach();
        process.exit(0);
        break;
    }
  }

}

// --- CLI arg parsing ---

interface PaneSpec {
  command: string;
  args: string[];
}

interface ParsedArgs {
  specs: PaneSpec[];
  tagFilters: TagFilter[];
  tmux: boolean;
  layouts: LayoutMode[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const specs: PaneSpec[] = [];
  const filters: TagFilter[] = [];
  let tmux = false;
  let layouts: LayoutMode[] = [...DEFAULT_LAYOUT_MODES];

  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--tag" && i + 1 < argv.length) {
      filters.push(parseTagFilter(argv[i + 1]!));
      i += 2;
    } else if (argv[i] === "--tmux") {
      tmux = true;
      i++;
    } else if (argv[i]!.startsWith("--layouts=")) {
      layouts = parseLayoutsFlag(argv[i]!.slice("--layouts=".length));
      i++;
    } else if (argv[i] === "--layouts" && i + 1 < argv.length) {
      layouts = parseLayoutsFlag(argv[i + 1]!);
      i += 2;
    } else {
      const arg = argv[i]!;
      const parts = arg.split(/\s+/);
      specs.push({ command: parts[0]!, args: parts.slice(1) });
      i++;
    }
  }

  return { specs, tagFilters: filters, tmux, layouts };
}

// --- Empty tag state ---

function renderEmptyState(totalRows: number, totalCols: number): void {
  const buf = new CellBuffer(totalRows, totalCols);

  if (!showingSessionPicker) {
    let label: string;
    if (!autoTagMode) {
      label = `Watching for sessions tagged ${formatTagFilters(tagFilters)}...`;
    } else {
      label = `^] n to open session picker`;
    }
    const row = Math.floor(totalRows / 2);
    const col = Math.max(1, Math.floor((totalCols - visibleLength(label)) / 2) + 1);
    buf.writeAnsi(moveTo(row, col) + fg(100, 100, 100) + label + RESET);
  }

  // Status bar
  const badge = formatLayoutBadge(tagFilters, layoutTagKey);
  const left = " ^] command key | ^\\ detach pane";
  const right = ` ${badge ? badge + " " : ""}0/0 grid `;
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  const pad = Math.max(totalCols - leftLen - rightLen, 0);
  const statusText = left + " ".repeat(pad) + right;
  buf.writeAnsi(
    moveTo(totalRows, 1) + bg(40, 40, 40) + fg(180, 180, 180) +
    statusText.slice(0, totalCols) + RESET,
  );

  // Session picker overlay
  if (showingSessionPicker && pickerState) {
    renderSessionPicker(buf, pickerState, totalRows, totalCols);
  } else if (isPrefixPending()) {
    // Prefix overlay in the empty state — so ^] shows the help modal
    renderPrefixOverlay(buf, totalRows, totalCols, false, !autoTagMode);
  }

  process.stdout.write(fullRender(buf));
}

// --- Subcommand: pty-layout new ---

async function runNewSubcommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseNewSubcommand(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const filterEnv = process.env.PTY_LAYOUT_FILTER_TAG ?? "";
  if (!filterEnv.trim()) {
    process.stderr.write(
      "pty-layout new: $PTY_LAYOUT_FILTER_TAG is not set. " +
      "This command is meant to be run inside a pty-layout session — it spawns a new tagged daemon session that the layout will pick up.\n",
    );
    return 1;
  }

  const tags = parseFilterTagEnv(filterEnv);
  if (Object.keys(tags).length === 0) {
    process.stderr.write(
      "pty-layout new: $PTY_LAYOUT_FILTER_TAG has no key=value entries. " +
      "The layout was started with key-only filters; this subcommand needs concrete values to apply.\n",
    );
    return 1;
  }

  const command = parsed.command
    ?? (process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/bash");
  const args = parsed.args;
  const name = parsed.name ?? randomSessionId();
  const cwd = parsed.cwd ?? (process.env.HOME ?? process.cwd());
  const displayCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;

  try {
    await spawnDaemon({ name, command, args, displayCommand, cwd, tags });
  } catch (err) {
    process.stderr.write(`pty-layout new: ${(err as Error).message}\n`);
    return 1;
  }

  // Print the session name so scripts can use it (mirrors `pty run`'s
  // stdout contract — one line, session name, nothing else).
  process.stdout.write(name + "\n");
  return 0;
}

// --- Main ---

async function main() {
  // Subcommand dispatch — before we touch the TTY or spawn anything.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "new") {
    const code = await runNewSubcommand(rawArgs.slice(1));
    process.exit(code);
  }

  const parsed = parseArgs(process.argv.slice(2));
  tmuxMode = parsed.tmux;
  enabledLayouts = parsed.layouts;

  // Tag mode selection. Auto-tag is the default — pty-layout owns a
  // random `:l<pid>-<rand>` key and uses it to track which sessions are
  // in its view. Explicit --tag is shared-workspace mode, read-only.
  if (parsed.tagFilters.length > 0) {
    tagFilters = parsed.tagFilters;
    autoTagMode = false;
    layoutTagKey = null;
  } else {
    layoutTagKey = newLayoutTagKey();
    tagFilters = [{ key: layoutTagKey, value: "1" }];
    autoTagMode = true;
  }

  // Expose the filter string to every child of pty-layout via env. This
  // is how `pty-layout new` (and the tmux shim, and anything the user
  // writes) discovers the layout scope. Setting on our own process.env
  // means all spawned daemons inherit it; daemons' child shells inherit
  // from them; and so on.
  process.env.PTY_LAYOUT_FILTER_TAG = formatTagFilters(tagFilters);

  // --tmux needs the layout tag in its env so the shim's spawn-path
  // (split-window, list-panes) has something to scope to. Works in
  // both auto and explicit modes now since we always have a filter.

  // Set up terminal
  running = true;
  process.stdout.write(enterAltScreen + enableMouse + enableBracketedPaste + hideCursor());
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", handleStdin);

  // Handle resize — debounce because resizing a terminal window often
  // fires many events in quick succession (drag-to-resize), and each
  // render during that window sees partially-stale PTY buffers (cells
  // haven't finished reflowing yet). Rendering mid-flight causes a
  // visible "flash of scrollback." Wait for the event stream to settle,
  // then render once.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  process.stdout.on("resize", () => {
    // Blank the screen immediately so the user doesn't see stale frames
    // while we wait. prevBuffer=null also forces a full re-render.
    prevBuffer = null;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      prevBuffer = null;
      scheduleRender(true);
    }, 80);
  });

  // Handle signals
  process.on("SIGINT", () => {
    detach();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    detach();
    process.exit(0);
  });
  process.on("exit", detach);

  // Tag subscription is always on now. In explicit --tag mode it
  // watches shared-workspace sessions. In auto-tag mode it watches
  // sessions this layout has tagged (mostly itself-created).
  tagSubscription = new TagSubscription(tagFilters, {
    onAdd: async (sessionName) => {
      // Focus rule: only focus the new pane when the user explicitly
      // initiated it (picker + New session). Everything else — CLI
      // startup specs, tmux shim teammates, external tagged sessions —
      // comes in without focus-stealing so the user stays put.
      startupPendingNames.delete(sessionName);
      const shouldFocus = focusOnAddNames.delete(sessionName);
      try {
        const pane = await createAttachPane(sessionName);
        addPane(pane, { focus: shouldFocus });
      } catch {
        // Session may have disappeared between event and attach
      }
    },
    onRemove: (sessionName) => {
      const pane = panes.find(
        (p) => p.source.type === "session" && p.source.name === sessionName,
      );
      if (pane) removePane(pane);
    },
    onRename: (sessionName, displayName) => {
      const pane = panes.find(
        (p) => p.source.type === "session" && p.source.name === sessionName,
      );
      if (!pane) return;
      pane.title = sessionPaneTitle(sessionName, displayName);
      prevBuffer = null;
      scheduleRender();
    },
  });

  const initialSessions = await tagSubscription.start();
  for (const name of initialSessions) {
    try {
      const pane = await createAttachPane(name);
      // Hydration: don't let each initial session fight the others for
      // focus. Focus will land on index 0 after they're all added.
      addPane(pane, { focus: false });
    } catch {
      // Session may have disappeared
    }
  }

  // CLI bare commands (e.g. `pty-layout bash bash`) spawn daemon
  // sessions tagged into this layout. The subscription's event follower
  // picks up each session_start and adds the pane.
  const cliTags = Object.fromEntries(
    tagFilters.filter(f => f.value !== undefined).map(f => [f.key, f.value!]),
  );
  for (const spec of parsed.specs) {
    try {
      const name = randomSessionId();
      // Mark this session name so onAdd keeps focus on pane 1 when its
      // session_start event comes through. Remove only on failure —
      // success leaves it to be consumed by onAdd.
      startupPendingNames.add(name);
      const displayCmd = spec.args.length > 0 ? `${spec.command} ${spec.args.join(" ")}` : spec.command;
      await spawnDaemon({
        name,
        command: spec.command,
        args: spec.args,
        displayCommand: displayCmd,
        cwd: process.env.HOME ?? process.cwd(),
        tags: cliTags,
      });
    } catch (err) {
      process.stderr.write(`pty-layout: failed to spawn "${spec.command}": ${(err as Error).message}\n`);
    }
  }

  // Auto-open picker on startup when the layout is empty AND we're in
  // auto-tag mode. Explicit --tag mode starts in "watching" empty state
  // so a passive workspace observer doesn't get surprised by a modal.
  if (panes.length === 0 && autoTagMode && parsed.specs.length === 0) {
    openSessionPicker();
  }

  // Start stats logging
  const launchId = newLaunchId();
  stopStats = startStats(
    {
      args: process.argv.slice(2),
      initialPanes: panes.length,
      tagMode: true,
    },
    {
      id: launchId,
      paneCount: () => panes.length,
      totalCells: () => {
        let total = 0;
        for (const pane of panes) {
          total += pane.handle.cols * pane.handle.rows;
        }
        return total;
      },
    },
  );

  // Initial render
  scheduleRender();
}

main().catch((err) => {
  process.stderr.write(`pty-layout: ${err.message}\n`);
  detach();
  process.exit(1);
});
