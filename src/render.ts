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
import { type SelectionState, isSelected, hasDragDistance } from "./selection.ts";

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
  hiddenPicker?: { panes: Pane[] } | null,
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
    const titleNum = paneIndex + 1;
    const title = `${titleNum}: ${pane.title}`;

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

      // Blit PTY cells into the buffer, applying selection highlight
      const showSelection = selection
        && selection.paneIndex === paneIndex
        && hasDragDistance(selection);

      for (let r = 0; r < cells.length && r < rect.innerHeight; r++) {
        const row = cells[r];
        if (!row) continue;
        for (let c = 0; c < row.length && c < rect.innerWidth; c++) {
          const cell = row[c];
          if (!cell) continue;
          if (showSelection && isSelected(r, c, selection!)) {
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

      // Track cursor for focused pane
      if (isFocused) {
        cursorScreenRow = rect.innerRow + pane.handle.cursorRow;
        cursorScreenCol = rect.innerCol + pane.handle.cursorCol;
      }
    }

    pane.handle.dirty = false;
  }

  // Status bar at bottom row
  renderStatusBar(buf, totalRows, totalCols, layoutMode, focusedIndex, panes.length);

  // Prefix key overlay
  if (prefixActive) {
    if (hiddenPicker && hiddenPicker.panes.length > 0) {
      renderHiddenPicker(buf, hiddenPicker.panes, totalRows, totalCols);
    } else {
      renderPaneBadges(buf, visible);
      renderPrefixOverlay(buf, totalRows, totalCols);
    }
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
  const left = " ^] command key | ^\\ detach";
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
    if (paneIndex > 8) continue; // Only 1-9
    const num = String(paneIndex + 1);

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

function renderPrefixOverlay(
  buf: CellBuffer,
  totalRows: number,
  totalCols: number,
): void {
  const lines = [
    [",", "prev pane ", ".", "next pane "],
    ["1-9", "jump to # ", "l", "layout    "],
    ["n", "new shell ", "p", "new pty   "],
    ["w", "close pane", "h", "hide pane "],
    ["H", "hidden list", "Esc", "cancel    "],
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

function renderHiddenPicker(
  buf: CellBuffer,
  hiddenPanes: Pane[],
  totalRows: number,
  totalCols: number,
): void {
  const maxItems = Math.min(hiddenPanes.length, 9);
  const contentWidth = 36;
  const boxWidth = contentWidth + 2;
  const boxHeight = maxItems + 3; // items + title border + footer + bottom border

  if (totalRows < boxHeight + 2 || totalCols < boxWidth + 2) return;

  const startRow = Math.floor((totalRows - boxHeight) / 2) + 1;
  const startCol = Math.floor((totalCols - boxWidth) / 2) + 1;

  let ansi =
    bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
    fg(OVERLAY_KEY[0], OVERLAY_KEY[1], OVERLAY_KEY[2]) +
    drawBox(startRow, startCol, boxWidth, boxHeight, {
      style: "rounded",
      title: " Hidden Panes ",
      fill: true,
    });

  for (let i = 0; i < maxItems; i++) {
    const pane = hiddenPanes[i]!;
    const num = String(i + 1);
    const title = pane.title.length > contentWidth - 5
      ? pane.title.slice(0, contentWidth - 8) + "..."
      : pane.title;
    ansi +=
      moveTo(startRow + 1 + i, startCol + 1) +
      bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
      fg(OVERLAY_KEY[0], OVERLAY_KEY[1], OVERLAY_KEY[2]) +
      (" " + num).padEnd(4) +
      fg(OVERLAY_FG[0], OVERLAY_FG[1], OVERLAY_FG[2]) +
      title.padEnd(contentWidth - 4);
  }

  // Footer
  ansi +=
    moveTo(startRow + maxItems + 1, startCol + 1) +
    bg(OVERLAY_BG[0], OVERLAY_BG[1], OVERLAY_BG[2]) +
    fg(100, 100, 100) +
    "Press number to unhide, Esc cancel".padEnd(contentWidth);

  ansi += reset();
  buf.writeAnsi(ansi);
}
