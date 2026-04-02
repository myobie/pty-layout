import { hideCursor, showCursor, reset } from "@myobie/pty/tui";
import { calculateLayout, nextLayoutMode, type LayoutMode, type PaneRect } from "./layout.ts";
import { createSessionPane, createAttachPane, createLocalPane, closePane, defaultShell, type Pane } from "./pane.ts";
import { renderFrame, clearCellCache } from "./render.ts";
import { processInput, isPrefixPending } from "./keys.ts";
import { CellBuffer } from "@myobie/pty/tui";

const enterAltScreen = "\x1b[?1049h";
const leaveAltScreen = "\x1b[?1049l";
const enableMouse = "\x1b[?1000h\x1b[?1006h"; // button tracking + SGR encoding
const disableMouse = "\x1b[?1006l\x1b[?1000l";
const STATUS_BAR_HEIGHT = 1;

// --- State ---

let panes: Pane[] = [];
let focusedIndex = 0;
let layoutMode: LayoutMode = "grid";
let prevBuffer: CellBuffer | null = null;
let renderScheduled = false;
let running = false;
let lastLayout: { paneIndex: number; rect: PaneRect }[] = [];
let scrollOffsets: number[] = []; // per-pane scroll offset (0 = live viewport)

// --- Terminal helpers ---

function getSize(): [number, number] {
  return [
    (process.stdout as any).rows ?? 24,
    (process.stdout as any).columns ?? 80,
  ];
}

// --- Render scheduling (throttled ~60fps) ---

function scheduleRender() {
  if (!running || renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    doRender();
  }, 16);
}

function doRender() {
  if (!running || panes.length === 0) return;

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
  );

  process.stdout.write(output);
  prevBuffer = buffer;
}

// --- Pane management ---

function addPane(pane: Pane) {
  pane.handle.onActivity = () => {
    scheduleRender();
    if (pane.handle.exited) {
      // Brief delay so the final output renders once before removal.
      // Much shorter than the old 500ms — just enough for one frame.
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
    detach();
    process.exit(0);
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
    detach();
    process.exit(0);
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

function handleStdin(data: Buffer) {
  const focused = panes[focusedIndex];
  if (!focused || focused.handle.exited) return;

  const wasPrefixed = isPrefixPending();
  const actions = processInput(data, (s) => focused.handle.write(s));

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
        createSessionPane(defaultShell(), []).then(addPane).catch(() => {
          // If daemon spawn fails, fall back to local process
          addPane(createLocalPane(defaultShell(), []));
        });
        break;

      case "newPty":
        addPane(createLocalPane("pty", []));
        break;

      case "closePane":
        removeFocusedPane();
        break;

      case "mouseDown": {
        const idx = findPaneAtPosition(action.row!, action.col!);
        if (idx !== -1 && idx !== focusedIndex) {
          focusedIndex = idx;
          prevBuffer = null;
          scheduleRender();
        }
        break;
      }

      case "scrollUp":
      case "scrollDown": {
        const scrollIdx = findPaneAtPosition(action.row!, action.col!);
        if (scrollIdx === -1) break;
        const scrollPane = panes[scrollIdx]!;

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

function parseArgs(argv: string[]): PaneSpec[] {
  const specs: PaneSpec[] = [];

  for (const arg of argv) {
    if (arg.startsWith("@")) {
      specs.push({ type: "attach", name: arg.slice(1) });
    } else {
      const parts = arg.split(/\s+/);
      specs.push({ type: "local", command: parts[0]!, args: parts.slice(1) });
    }
  }

  if (specs.length === 0) {
    specs.push({ type: "local", command: defaultShell(), args: [] });
  }

  return specs;
}

// --- Main ---

async function main() {
  const specs = parseArgs(process.argv.slice(2));

  // Create initial panes
  for (const spec of specs) {
    let pane: Pane;
    if (spec.type === "attach") {
      pane = await createAttachPane(spec.name);
    } else {
      pane = createLocalPane(spec.command, spec.args);
    }
    pane.handle.onActivity = () => {
      scheduleRender();
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

  // Initial render
  scheduleRender();
}

main().catch((err) => {
  process.stderr.write(`pty-layout: ${err.message}\n`);
  detach();
  process.exit(1);
});
