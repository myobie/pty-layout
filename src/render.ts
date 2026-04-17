import {
  CellBuffer,
  diff,
  fullRender,
  drawBox,
  fg,
  bg,
  reset,
  moveTo,
  showCursor,
  RESET,
  visibleLength,
} from "@myobie/pty/tui";
import type { PaneRect, LayoutMode } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { type SelectionState, isSelectedAtScroll, hasDragDistance } from "./selection.ts";
import type { PickerState } from "./session-picker.ts";
import { indexToPositionKey } from "./positions.ts";
import { effectiveCursorRow } from "./scroll.ts";

type Cell = ReturnType<Pane["handle"]["readCells"]>[0][0];

// Cache of last-read cells per pane, keyed by pane id
const cellCache = new Map<number, { cells: Cell[][]; width: number; height: number; scrollOffset: number }>();

export function clearCellCache(paneId?: number) {
  if (paneId !== undefined) cellCache.delete(paneId);
  else cellCache.clear();
}

const GREEN: [number, number, number] = [80, 200, 120];
const GREY: [number, number, number] = [100, 100, 100];
const STATUS_BG: [number, number, number] = [40, 40, 40];
const STATUS_FG: [number, number, number] = [180, 180, 180];

const MODE_LABELS: Record<LayoutMode, string> = {
  grid: "grid",
  zoom: "zoom",
  single: "single",
};

export function renderFrame(
  panes: Pane[],
  rects: PaneRect[],
  focusedIndex: number,
  layoutMode: LayoutMode,
  totalRows: number,
  totalCols: number,
  prevBuffer: CellBuffer | null,
  prefixActive: boolean,
  scrollOffsets: number[] = [],
  selection?: SelectionState | null,
  sessionPicker?: PickerState | null,
  moveMode: boolean = false,
  tagMode: boolean = false,
): { output: string; buffer: CellBuffer } {
  const buf = new CellBuffer(totalRows, totalCols);

  // Determine which panes are visible
  const visible: { pane: Pane; rect: PaneRect; paneIndex: number }[] = [];
  if (layoutMode === "single") {
    if (panes[focusedIndex] && rects[0]) {
      visible.push({
        pane: panes[focusedIndex],
        rect: rects[0],
        paneIndex: focusedIndex,
      });
    }
  } else {
    for (let i = 0; i < panes.length && i < rects.length; i++) {
      visible.push({ pane: panes[i], rect: rects[i], paneIndex: i });
    }
  }

  // Track focused pane's cursor position for cursor placement
  let cursorScreenRow = -1;
  let cursorScreenCol = -1;

  for (const { pane, rect, paneIndex } of visible) {
    const isFocused = paneIndex === focusedIndex;
    const borderColor = isFocused ? GREEN : GREY;
    const titleKey = indexToPositionKey(paneIndex) ?? String(paneIndex + 1);
    const title = `${titleKey}: ${pane.title}`;

    // Draw border with title and fill
    const boxAnsi =
      fg(borderColor[0], borderColor[1], borderColor[2]) +
      drawBox(rect.outerRow, rect.outerCol, rect.outerWidth, rect.outerHeight, {
        style: "rounded",
        title,
      }) +
      reset();
    buf.writeAnsi(boxAnsi);

    // Resize the PTY to match inner content area
    if (rect.innerWidth > 0 && rect.innerHeight > 0) {
      pane.handle.resize(rect.innerWidth, rect.innerHeight);

      const scrollOffset = scrollOffsets[paneIndex] ?? 0;
      const cached = cellCache.get(pane.id);
      const canReuse = cached
        && !pane.handle.dirty
        && cached.width === rect.innerWidth
        && cached.height === rect.innerHeight
        && cached.scrollOffset === scrollOffset;

      const cells = canReuse
        ? cached.cells
        : pane.handle.readCells(scrollOffset);

      if (!canReuse) {
        cellCache.set(pane.id, {
          cells,
          width: rect.innerWidth,
          height: rect.innerHeight,
          scrollOffset,
        });
      }

      // Blit PTY cells into the buffer, applying selection highlight.
      // Selection coords were captured at selection.scrollOffset, so we
      // use isSelectedAtScroll() to translate to the current scroll —
      // the highlight tracks the selected content, not the screen position.
      const showSelection = selection
        && selection.paneIndex === paneIndex
        && hasDragDistance(selection);

      for (let r = 0; r < cells.length && r < rect.innerHeight; r++) {
        const row = cells[r];
        if (!row) continue;
        for (let c = 0; c < row.length && c < rect.innerWidth; c++) {
          const cell = row[c];
          if (!cell) continue;
          if (showSelection && isSelectedAtScroll(r, c, selection!, scrollOffset)) {
            buf.setCell(rect.innerRow - 1 + r, rect.innerCol - 1 + c, {
              ...cell,
              fg: cell.bg ?? [0, 0, 0],
              bg: cell.fg ?? [200, 200, 200],
            });
          } else {
            buf.setCell(rect.innerRow - 1 + r, rect.innerCol - 1 + c, cell);
          }
        }
      }

      // Track cursor for focused pane. If the user scrolled back far
      // enough, the cursor's effective row ends up off-screen and we
      // leave it hidden (cursorScreenRow stays -1).
      if (isFocused) {
        const effective = effectiveCursorRow(pane.handle.cursorRow, scrollOffset, rect.innerHeight);
        if (effective !== null) {
          cursorScreenRow = rect.innerRow + effective;
          cursorScreenCol = rect.innerCol + pane.handle.cursorCol;
        }
      }
    }

    pane.handle.dirty = false;
  }

  // Status bar at bottom row
  renderStatusBar(buf, totalRows, totalCols, layoutMode, focusedIndex, panes.length);

  // Overlays
  if (sessionPicker) {
    renderSessionPicker(buf, sessionPicker, totalRows, totalCols);
  } else if (prefixActive) {
    renderPaneBadges(buf, visible);
    renderPrefixOverlay(buf, totalRows, totalCols, moveMode, tagMode);
  }

  // Diff against previous buffer
  const canDiff =
    prevBuffer &&
    prevBuffer.rows === totalRows &&
    prevBuffer.cols === totalCols;
  const output = canDiff ? diff(prevBuffer, buf) : fullRender(buf);

  // Position cursor at focused pane's cursor location and show it
  let cursor = "";
  if (cursorScreenRow > 0 && cursorScreenCol > 0) {
    cursor = moveTo(cursorScreenRow, cursorScreenCol) + showCursor();
  }

  return { output: output + cursor, buffer: buf };
}

function renderStatusBar(
  buf: CellBuffer,
  totalRows: number,
  totalCols: number,
  layoutMode: LayoutMode,
  focusedIndex: number,
  paneCount: number,
): void {
  const left = " ^] command key | ^\\ detach pane";
  const right = ` ${focusedIndex + 1}/${paneCount} ${MODE_LABELS[layoutMode]} `;

  // Pad to fill the row
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  const pad = Math.max(totalCols - leftLen - rightLen, 0);
  const text = left + " ".repeat(pad) + right;

  const ansi =
    moveTo(totalRows, 1) +
    bg(STATUS_BG[0], STATUS_BG[1], STATUS_BG[2]) +
    fg(STATUS_FG[0], STATUS_FG[1], STATUS_FG[2]) +
    text.slice(0, totalCols) +
    RESET;

  buf.writeAnsi(ansi);
}

const BADGE_BG: [number, number, number] = [80, 200, 120];
const BADGE_FG: [number, number, number] = [0, 0, 0];

function renderPaneBadges(
  buf: CellBuffer,
  visible: { pane: Pane; rect: PaneRect; paneIndex: number }[],
): void {
  for (const { rect, paneIndex } of visible) {
    const num = indexToPositionKey(paneIndex);
    if (num === null) continue; // beyond our addressable range

    if (rect.innerWidth >= 5 && rect.innerHeight >= 3) {
      // Draw a small box badge centered in the pane
      const badgeW = 5;
      const badgeH = 3;
      const row = rect.innerRow + Math.floor((rect.innerHeight - badgeH) / 2);
      const col = rect.innerCol + Math.floor((rect.innerWidth - badgeW) / 2);

      const ansi =
        bg(BADGE_BG[0], BADGE_BG[1], BADGE_BG[2]) +
        fg(BADGE_FG[0], BADGE_FG[1], BADGE_FG[2]) +
        drawBox(row, col, badgeW, badgeH, { style: "rounded", fill: true }) +
        moveTo(row + 1, col + 2) +
        bg(BADGE_BG[0], BADGE_BG[1], BADGE_BG[2]) +
        fg(BADGE_FG[0], BADGE_FG[1], BADGE_FG[2]) +
        num +
        reset();
      buf.writeAnsi(ansi);
    } else if (rect.innerWidth >= 1 && rect.innerHeight >= 1) {
      // Pane too small for box: just show the number
      const row = rect.innerRow + Math.floor(rect.innerHeight / 2);
      const col = rect.innerCol + Math.floor(rect.innerWidth / 2);
      const ansi =
        moveTo(row, col) +
        bg(BADGE_BG[0], BADGE_BG[1], BADGE_BG[2]) +
        fg(BADGE_FG[0], BADGE_FG[1], BADGE_FG[2]) +
        num +
        reset();
      buf.writeAnsi(ansi);
    }
  }
}

const OVERLAY_BG: [number, number, number] = [30, 30, 30];
const OVERLAY_FG: [number, number, number] = [200, 200, 200];
const OVERLAY_KEY: [number, number, number] = [80, 200, 120];

export function renderPrefixOverlay(
  buf: CellBuffer,
  totalRows: number,
  totalCols: number,
  moveMode: boolean = false,
  tagMode: boolean = false,
): void {
  const lines = moveMode ? [
    ["", "Pick a position to move this pane to:", "", ""],
    ["1-9", "position  ", "a-z", "position "],
    ["Esc", "cancel    ", "", "          "],
  ] : tagMode ? [
    [",", "prev pane ", ".", "next pane "],
    ["1-9", "jump to # ", "l", "layout   "],
    ["m", "move pane ", "n", "sessions  "],
    ["q", "quit      ", "", "          "],
    ["Esc", "cancel    ", "", "          "],
  ] : [
    [",", "prev pane ", ".", "next pane "],
    ["1-9", "jump to # ", "l", "layout   "],
    ["m", "move pane ", "n", "sessions  "],
    ["w", "close pane", "q", "quit      "],
    ["Esc", "cancel    ", "", "          "],
  ];

  const colWidth = 17;
  const contentWidth = colWidth * 2;
  const boxWidth = contentWidth + 2;
  const boxHeight = lines.length + 2;

  if (totalRows < boxHeight + 2 || totalCols < boxWidth + 2) return;

  const startRow = Math.floor((totalRows - boxHeight) / 2) + 1;
  const startCol = Math.floor((totalCols - boxWidth) / 2) + 1;

  let ansi =
    bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
    fg(OVERLAY_KEY[0], OVERLAY_KEY[1], OVERLAY_KEY[2]) +
    drawBox(startRow, startCol, boxWidth, boxHeight, {
      style: "rounded",
      title: " ^] ",
      fill: true,
    });

  for (let r = 0; r < lines.length; r++) {
    const row = lines[r]!;
    ansi += moveTo(startRow + 1 + r, startCol + 1);
    ansi += bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]);
    for (let c = 0; c < row.length; c += 2) {
      const key = row[c]!;
      const desc = row[c + 1]!;
      ansi +=
        fg(OVERLAY_KEY[0], OVERLAY_KEY[1], OVERLAY_KEY[2]) +
        (" " + key).padEnd(5) +
        fg(OVERLAY_FG[0], OVERLAY_FG[1], OVERLAY_FG[2]) +
        desc.padEnd(colWidth - 5);
    }
  }

  ansi += reset();
  buf.writeAnsi(ansi);
}

export interface PickerVisualRow {
  kind: "header" | "item";
  content: string;       // pre-rendered line content (without padding/truncation)
  itemIndex?: number;    // only set for "item" rows — maps to state.flatItems
}

/** Build the full list of visual rows (headers + items) with item-index mapping. */
export function buildPickerVisualRows(state: PickerState): PickerVisualRow[] {
  const rows: PickerVisualRow[] = [];
  let itemIndex = 0;
  for (const group of state.groups) {
    rows.push({ kind: "header", content: " " + group.title + " " });
    for (const item of group.items) {
      let line: string;
      if (item.type === "create-local" || item.type === "create-remote") {
        line = item.label;
      } else {
        const dot = "● ";
        const detail = item.detail ? "  " + item.detail : "";
        line = dot + item.label + detail;
      }
      rows.push({ kind: "item", content: line, itemIndex });
      itemIndex++;
    }
  }
  return rows;
}

/** Compute scroll offset that keeps the selected item visible in the viewport. */
export function computePickerScroll(
  rows: PickerVisualRow[],
  selectedIndex: number,
  viewportHeight: number,
): number {
  // Find the visual row of the selected item
  let selectedVisualRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === "item" && rows[i]!.itemIndex === selectedIndex) {
      selectedVisualRow = i;
      break;
    }
  }
  if (selectedVisualRow === -1) return 0;

  // If selected row is above the viewport: scroll up so it's at the top
  // If below: scroll down so it's at the bottom
  // Try to include the group header of the selected row when possible
  const headerRow = selectedVisualRow > 0 && rows[selectedVisualRow - 1]!.kind === "header"
    ? selectedVisualRow - 1
    : -1;

  let offset = Math.max(0, selectedVisualRow - viewportHeight + 1);
  // If we can fit the header too, include it
  if (headerRow !== -1 && headerRow >= offset) {
    // already visible
  } else if (headerRow !== -1 && selectedVisualRow - headerRow + 1 <= viewportHeight) {
    offset = Math.max(0, headerRow);
  }
  // Clamp to list bounds
  offset = Math.min(offset, Math.max(0, rows.length - viewportHeight));
  return offset;
}

export function renderSessionPicker(
  buf: CellBuffer,
  state: PickerState,
  totalRows: number,
  totalCols: number,
): void {
  const contentWidth = Math.min(58, totalCols - 4);
  // Use most of the screen height (leave 4 rows breathing room, plus box
  // chrome: 2 borders + filter + footer = 4 more).
  const maxVisibleItems = Math.max(3, totalRows - 8);

  const visualRows = buildPickerVisualRows(state);
  const totalVisualRows = visualRows.length;

  // Box height is fixed at maxVisibleItems when list is long enough to scroll.
  // If list is shorter, shrink the box.
  const listHeight = totalVisualRows === 0
    ? 1 // one row for "Loading..." or empty
    : Math.min(totalVisualRows, maxVisibleItems);

  const hasFilter = state.filter.length > 0;
  const boxHeight = listHeight + (hasFilter ? 4 : 3); // borders + optional filter + footer
  const boxWidth = contentWidth + 2;

  if (totalRows < boxHeight + 2 || totalCols < boxWidth + 2) return;

  const startRow = Math.floor((totalRows - boxHeight) / 2) + 1;
  const startCol = Math.floor((totalCols - boxWidth) / 2) + 1;

  const scrollOffset = computePickerScroll(visualRows, state.selectedIndex, listHeight);
  const moreAbove = scrollOffset > 0;
  const moreBelow = scrollOffset + listHeight < totalVisualRows;

  const title = state.loading ? " Sessions (loading...) " : " Sessions ";

  let ansi =
    bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
    fg(OVERLAY_KEY[0], OVERLAY_KEY[1], OVERLAY_KEY[2]) +
    drawBox(startRow, startCol, boxWidth, boxHeight, {
      style: "rounded",
      title,
      fill: true,
    });

  let row = startRow + 1;

  // Filter bar
  if (hasFilter) {
    ansi +=
      moveTo(row, startCol + 1) +
      bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
      fg(OVERLAY_FG[0], OVERLAY_FG[1], OVERLAY_FG[2]) +
      (" Filter: " + state.filter).slice(0, contentWidth).padEnd(contentWidth);
    row++;
  }

  // Render visible window of rows
  const windowEnd = Math.min(scrollOffset + listHeight, totalVisualRows);
  for (let i = scrollOffset; i < windowEnd; i++) {
    const vr = visualRows[i]!;
    let line: string;
    let fgColor: [number, number, number];

    if (vr.kind === "header") {
      line = vr.content;
      fgColor = OVERLAY_KEY;
    } else {
      const isSel = vr.itemIndex === state.selectedIndex;
      fgColor = isSel ? OVERLAY_KEY : OVERLAY_FG;
      const prefix = isSel ? "▸ " : "  ";
      line = prefix + vr.content;
    }

    // Scroll indicators on the first and last visible rows
    const isFirstVisible = i === scrollOffset;
    const isLastVisible = i === windowEnd - 1;
    if (isFirstVisible && moreAbove) {
      line = line.slice(0, contentWidth - 2) + " ↑";
    } else if (isLastVisible && moreBelow) {
      line = line.slice(0, contentWidth - 2) + " ↓";
    }

    ansi +=
      moveTo(row, startCol + 1) +
      bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
      fg(fgColor[0], fgColor[1], fgColor[2]) +
      line.slice(0, contentWidth).padEnd(contentWidth);
    row++;
  }

  // Footer
  ansi +=
    moveTo(startRow + boxHeight - 2, startCol + 1) +
    bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
    fg(100, 100, 100) +
    "↵ select  type to filter  Esc cancel".slice(0, contentWidth).padEnd(contentWidth);

  ansi += reset();
  buf.writeAnsi(ansi);
}
