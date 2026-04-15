#!/usr/bin/env node --experimental-strip-types --no-warnings
import { hideCursor, showCursor, reset } from "@myobie/pty/tui";
import { calculateLayout, nextLayoutMode, type LayoutMode, type PaneRect } from "./layout.ts";
import { createSessionPane, createAttachPane, createLocalPane, closePane, defaultShell, type Pane } from "./pane.ts";
import { renderFrame, clearCellCache, renderSessionPicker } from "./render.ts";
import { processInput, isPrefixPending } from "./keys.ts";
import {
  type SelectionState,
  hasDragDistance,
  extractSelectedText,
  copyToClipboard,
  screenToPaneLocal,
  clampToInner,
} from "./selection.ts";
import { CellBuffer, fullRender, moveTo, fg, bg, visibleLength, RESET, spawnDaemon } from "@myobie/pty/tui";
import {
  type PickerState,
  createPickerState,
  refreshPicker,
  filterPicker,
  moveSelection,
  autoSessionName,
} from "./session-picker.ts";
import {
  type TagFilter,
  TagSubscription,
  parseTagFilter,
  formatTagFilters,
} from "./tag-subscription.ts";

const enterAltScreen = "\x1b[?1049h";
const leaveAltScreen = "\x1b[?1049l";
const enableMouse = "\x1b[?1002h\x1b[?1006h"; // button-motion tracking + SGR encoding
const disableMouse = "\x1b[?1006l\x1b[?1002l";
const STATUS_BAR_HEIGHT = 1;

// --- State ---

let panes: Pane[] = [];
let focusedIndex = 0;
let layoutMode: LayoutMode = "grid";
let prevBuffer: CellBuffer | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let renderTimerDelay = 16;
let running = false;
let lastLayout: { paneIndex: number; rect: PaneRect }[] = [];
let scrollOffsets: number[] = []; // per-pane scroll offset (0 = live viewport)
let selection: SelectionState | null = null;
let tagSubscription: TagSubscription | null = null;
let tagFilters: TagFilter[] = [];
let tagMode = false;
let showingSessionPicker = false;
let pickerState: PickerState | null = null;

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

function doRender() {
  if (!running) return;

  if (panes.length === 0) {
    if (showingSessionPicker || tagMode) {
      const [totalRows, totalCols] = getSize();
      renderEmptyState(totalRows, totalCols);
    }
    return;
  }

  const [totalRows, totalCols] = getSize();
  if (totalRows < 4 || totalCols < 4) return;

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
  );

  process.stdout.write(output);
  prevBuffer = buffer;
}

// --- Pane management ---

function addPane(pane: Pane) {
  pane.handle.onActivity = () => {
    const urgent = panes[focusedIndex] === pane && expectingFocusedEcho;
    if (urgent) expectingFocusedEcho = false;
    scheduleRender(urgent);
    if (pane.handle.exited) {
      setTimeout(() => removePane(pane), 50);
    }
  };
  panes.push(pane);
  scrollOffsets.push(0);
  focusedIndex = panes.length - 1;
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

  if (panes.length === 0) {
    if (!tagMode && !showingSessionPicker) {
      detach();
      process.exit(0);
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

function removeFocusedPane() {
  if (panes.length === 0) return;
  const pane = panes[focusedIndex];

  clearCellCache(pane.id);
  closePane(pane);
  panes.splice(focusedIndex, 1);
  scrollOffsets.splice(focusedIndex, 1);

  if (panes.length === 0) {
    if (!tagMode && !showingSessionPicker) {
      detach();
      process.exit(0);
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
  // Detach: release handles but don't kill processes.
  // For attached sessions, handle.kill() sends detach (not terminate).
  // For local createPty processes, they'll be cleaned up when our process exits.
  for (const pane of panes) {
    pane.handle.kill();
  }
  process.stdout.write(disableMouse + showCursor() + reset() + leaveAltScreen);
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

  refreshPicker(tagFilters, (state) => {
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
      const tags = tagMode
        ? Object.fromEntries(tagFilters.filter((f) => f.value !== undefined).map((f) => [f.key, f.value!]))
        : undefined;
      const existingNames = new Set(panes.map((p) => p.source.type === "session" ? p.source.name : ""));
      const name = autoSessionName(existingNames);
      try {
        await spawnDaemon({ name, command: defaultShell(), args: [], displayCommand: defaultShell(), tags });
        if (!tagMode) {
          const pane = await createAttachPane(name);
          addPane(pane);
        }
        // In tag mode, EventFollower handles add
      } catch {}
      break;
    }
    case "create-remote": {
      const tagArgs = tagFilters
        .filter((f) => f.value !== undefined)
        .flatMap((f) => ["--tag", `${f.key}=${f.value}`]);
      const name = `remote-${Date.now()}`;
      const pane = createLocalPane("pty-relay", [
        "connect", item.relayUrl!, "--spawn", name, ...tagArgs,
      ]);
      addPane(pane);
      break;
    }
    case "local": {
      const pane = await createAttachPane(item.sessionName!);
      if (tagSubscription) tagSubscription.track(item.sessionName!);
      addPane(pane);
      break;
    }
    case "remote": {
      const pane = createLocalPane("pty-relay", [
        "connect", `${item.relayUrl!}/${item.sessionName!}`,
      ]);
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
      // Bare Esc — close picker
      closeSessionPicker();
      i++;
      continue;
    }

    // Enter — select
    if (code === 0x0d) {
      selectPickerItem();
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

    // Ctrl+C — close
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
  if (!focused || focused.handle.exited) return;

  const wasPrefixed = isPrefixPending();
  expectingFocusedEcho = false;
  const actions = processInput(data, (s) => {
    focused.handle.write(s);
    expectingFocusedEcho = true;
  });

  if (isPrefixPending() !== wasPrefixed) {
    prevBuffer = null;
    scheduleRender();
  }

  for (const action of actions) {
    switch (action.type) {
      case "cycleLayout":
        layoutMode = nextLayoutMode(layoutMode);
        prevBuffer = null;
        scheduleRender();
        break;

      case "focusIndex":
        if (action.index! >= 0 && action.index! < panes.length) {
          focusedIndex = action.index!;
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
        if (tagMode) {
          // In tag mode, panes reflect tagged sessions — can't close
          break;
        }
        removeFocusedPane();
        break;


      case "mouseDown": {
        // Clear any completed selection
        if (selection && !selection.active) {
          selection = null;
          prevBuffer = null;
        }

        const clickIdx = findPaneAtPosition(action.row!, action.col!);
        if (clickIdx === -1) break;
        const clickPane = panes[clickIdx]!;

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
          // Start selection
          const clickEntry = lastLayout.find(l => l.paneIndex === clickIdx);
          if (clickEntry) {
            const local = screenToPaneLocal(action.row!, action.col!, clickEntry.rect);
            const clamped = clampToInner(local.row, local.col, clickEntry.rect);
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

        if (hasDragDistance(selection) && upPane) {
          // Copy selected text to clipboard via OSC 52
          const cells = upPane.handle.readCells(selection.scrollOffset);
          const text = extractSelectedText(cells, selection);
          if (text.length > 0) {
            process.stdout.write(copyToClipboard(text));
          }
          // Keep selection visible (highlight stays until next click)
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

        // Clear selection when scrolling the selected pane
        if (selection && selection.paneIndex === scrollIdx) {
          selection = null;
        }

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
        } else {
          // No mouse mode — scroll through scrollback buffer
          const offset = scrollOffsets[scrollIdx] ?? 0;
          if (action.type === "scrollUp") {
            scrollOffsets[scrollIdx] = Math.min(offset + 3, scrollPane.handle.baseY);
          } else {
            scrollOffsets[scrollIdx] = Math.max(offset - 3, 0);
          }
          prevBuffer = null;
          scheduleRender();
        }
        break;
      }

      case "detach":
        detach();
        process.exit(0);
        break;
    }
  }

}

// --- CLI arg parsing ---

type PaneSpec =
  | { type: "local"; command: string; args: string[] }
  | { type: "attach"; name: string };

interface ParsedArgs {
  specs: PaneSpec[];
  tagFilters: TagFilter[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const specs: PaneSpec[] = [];
  const filters: TagFilter[] = [];

  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--tag" && i + 1 < argv.length) {
      filters.push(parseTagFilter(argv[i + 1]!));
      i += 2;
    } else {
      const arg = argv[i]!;
      if (arg.startsWith("@")) {
        specs.push({ type: "attach", name: arg.slice(1) });
      } else {
        const parts = arg.split(/\s+/);
        specs.push({ type: "local", command: parts[0]!, args: parts.slice(1) });
      }
      i++;
    }
  }

  return { specs, tagFilters: filters };
}

// --- Empty tag state ---

function renderEmptyState(totalRows: number, totalCols: number): void {
  const buf = new CellBuffer(totalRows, totalCols);

  if (!showingSessionPicker) {
    let label: string;
    if (tagMode) {
      label = `Watching for sessions tagged ${formatTagFilters(tagFilters)}...`;
    } else {
      label = `^] n to open session picker`;
    }
    const row = Math.floor(totalRows / 2);
    const col = Math.max(1, Math.floor((totalCols - visibleLength(label)) / 2) + 1);
    buf.writeAnsi(moveTo(row, col) + fg(100, 100, 100) + label + RESET);
  }

  // Status bar
  const left = " ^] command key | ^\\ detach";
  const right = ` 0/0 grid `;
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
  }

  process.stdout.write(fullRender(buf));
}

// --- Main ---

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  tagFilters = parsed.tagFilters;
  tagMode = tagFilters.length > 0;

  // Create initial panes from explicit specs
  for (const spec of parsed.specs) {
    let pane: Pane;
    if (spec.type === "attach") {
      pane = await createAttachPane(spec.name);
    } else {
      pane = createLocalPane(spec.command, spec.args);
    }
    pane.handle.onActivity = () => {
      const urgent = panes[focusedIndex] === pane && expectingFocusedEcho;
      if (urgent) expectingFocusedEcho = false;
      scheduleRender(urgent);
      if (pane.handle.exited) {
        setTimeout(() => removePane(pane), 50);
      }
    };
    panes.push(pane);
    scrollOffsets.push(0);
  }

  // Set up terminal
  running = true;
  process.stdout.write(enterAltScreen + enableMouse + hideCursor());
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", handleStdin);

  // Handle resize
  process.stdout.on("resize", () => {
    prevBuffer = null;
    scheduleRender();
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

  // Start tag subscription if in tag mode
  if (tagMode) {
    tagSubscription = new TagSubscription(tagFilters, {
      onAdd: async (sessionName) => {
        try {
          const pane = await createAttachPane(sessionName);
          addPane(pane);
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
    });

    const initialSessions = await tagSubscription.start();
    for (const name of initialSessions) {
      try {
        const pane = await createAttachPane(name);
        addPane(pane);
      } catch {
        // Session may have disappeared
      }
    }
  }

  // Open picker on startup if no panes and not in tag mode
  if (panes.length === 0 && !tagMode) {
    openSessionPicker();
  }

  // Initial render
  scheduleRender();
}

main().catch((err) => {
  process.stderr.write(`pty-layout: ${err.message}\n`);
  detach();
  process.exit(1);
});
