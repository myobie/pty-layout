export interface PaneRect {
  outerRow: number;
  outerCol: number;
  outerWidth: number;
  outerHeight: number;
  innerRow: number;
  innerCol: number;
  innerWidth: number;
  innerHeight: number;
}

export type LayoutMode = "grid" | "zoom" | "single" | "stacked";

/** Layouts cycled through by default (when --layouts is unset).
 *  Order: grid → stacked → single → grid. Zoom is opt-in because
 *  most users don't want it in their rotation; pass `--layouts=+zoom`
 *  to add it. */
export const DEFAULT_LAYOUT_MODES: LayoutMode[] = ["grid", "stacked", "single"];

/** All known layout names, including opt-in ones. Used for validation. */
export const ALL_LAYOUT_MODES: LayoutMode[] = ["grid", "zoom", "single", "stacked"];

export function isLayoutMode(value: string): value is LayoutMode {
  return (ALL_LAYOUT_MODES as string[]).includes(value);
}

/** Cycle through the provided layout list. Falls back to the first
 *  entry if `current` isn't in the list (shouldn't happen in normal
 *  use). */
export function nextLayoutMode(
  current: LayoutMode,
  enabled: LayoutMode[] = DEFAULT_LAYOUT_MODES,
): LayoutMode {
  if (enabled.length === 0) return current;
  const idx = enabled.indexOf(current);
  if (idx === -1) return enabled[0]!;
  return enabled[(idx + 1) % enabled.length]!;
}

/** Parse a `--layouts=<value>` CLI argument. Each comma-separated token
 *  starting with `+` adds that layout to the default list (if not
 *  already present). Unknown names throw. Example: `+zoom` →
 *  `[grid, stacked, single, zoom]`. */
export function parseLayoutsFlag(value: string): LayoutMode[] {
  const out: LayoutMode[] = [...DEFAULT_LAYOUT_MODES];
  const tokens = value.split(",").map(s => s.trim()).filter(Boolean);
  for (const tok of tokens) {
    if (!tok.startsWith("+")) {
      throw new Error(
        `--layouts: unsupported token "${tok}". Only "+<name>" is supported ` +
        `(e.g. --layouts=+zoom). The default set is always included.`,
      );
    }
    const name = tok.slice(1);
    if (!isLayoutMode(name)) {
      throw new Error(
        `--layouts: unknown layout "${name}". Valid names: ${ALL_LAYOUT_MODES.join(", ")}.`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function makeRect(
  outerRow: number,
  outerCol: number,
  outerWidth: number,
  outerHeight: number,
): PaneRect {
  return {
    outerRow,
    outerCol,
    outerWidth,
    outerHeight,
    innerRow: outerRow + 1,
    innerCol: outerCol + 1,
    innerWidth: Math.max(outerWidth - 2, 0),
    innerHeight: Math.max(outerHeight - 2, 0),
  };
}

export function calculateLayout(
  mode: LayoutMode,
  paneCount: number,
  totalRows: number,
  totalCols: number,
  statusBarHeight: number,
  focusedIndex: number,
): PaneRect[] {
  if (paneCount === 0) return [];

  const availRows = totalRows - statusBarHeight;
  if (availRows < 3 || totalCols < 3) return [];

  switch (mode) {
    case "grid":
      return gridLayout(paneCount, availRows, totalCols);
    case "zoom":
      return zoomLayout(paneCount, availRows, totalCols);
    case "single":
      return [makeRect(1, 1, totalCols, availRows)];
    case "stacked":
      return stackedLayout(paneCount, availRows, totalCols, focusedIndex);
  }
}

/**
 * Grid layout: arranges panes in a grid. Last row may have fewer panes
 * that are wider to fill the remaining space.
 */
function gridLayout(
  count: number,
  availRows: number,
  totalCols: number,
): PaneRect[] {
  if (count === 1) {
    return [makeRect(1, 1, totalCols, availRows)];
  }

  const gridCols = Math.ceil(Math.sqrt(count));
  const gridRows = Math.ceil(count / gridCols);
  const cellHeight = Math.floor(availRows / gridRows);
  const rects: PaneRect[] = [];

  for (let i = 0; i < count; i++) {
    const gridRow = Math.floor(i / gridCols);
    const isLastGridRow = gridRow === gridRows - 1;
    const panesInThisRow = isLastGridRow ? count - gridRow * gridCols : gridCols;
    const colInRow = isLastGridRow ? i - gridRow * gridCols : i % gridCols;

    // Last row panes can be wider to fill space
    const cellWidth = Math.floor(totalCols / panesInThisRow);
    const isLastInRow = colInRow === panesInThisRow - 1;

    const outerCol = colInRow * cellWidth + 1;
    const outerRow = gridRow * cellHeight + 1;
    const outerWidth = isLastInRow
      ? totalCols - colInRow * cellWidth
      : cellWidth;
    const outerHeight = isLastGridRow
      ? availRows - gridRow * cellHeight
      : cellHeight;

    rects.push(makeRect(outerRow, outerCol, outerWidth, outerHeight));
  }

  return rects;
}

/**
 * Stacked layout: panes arranged top-to-bottom in index order. Only the
 * focused pane is "open" and gets a full bordered box with content; all
 * others are collapsed to a 1-row title strip. Unfocused panes keep
 * whatever PTY size they had when last focused — we don't resize their
 * handles (same policy as single mode).
 */
function stackedLayout(
  count: number,
  availRows: number,
  totalCols: number,
  focusedIndex: number,
): PaneRect[] {
  if (count === 1) {
    return [makeRect(1, 1, totalCols, availRows)];
  }

  const collapsedHeight = 1;
  const collapsedTotal = (count - 1) * collapsedHeight;
  // If there are so many panes that the focused one would be < 0 rows,
  // clamp to 0. The render layer will skip content drawing in that case.
  const focusedOuterHeight = Math.max(availRows - collapsedTotal, 0);

  const rects: PaneRect[] = [];
  let cursor = 1;
  for (let i = 0; i < count; i++) {
    if (i === focusedIndex) {
      rects.push(makeRect(cursor, 1, totalCols, focusedOuterHeight));
      cursor += focusedOuterHeight;
    } else {
      rects.push(makeRect(cursor, 1, totalCols, collapsedHeight));
      cursor += collapsedHeight;
    }
  }

  return rects;
}

/**
 * Zoom layout: all cells the same size, like a video call grid.
 * If count doesn't fill the grid, empty cells are left.
 * Panes are centered in the last row if it has fewer.
 */
function zoomLayout(
  count: number,
  availRows: number,
  totalCols: number,
): PaneRect[] {
  if (count === 1) {
    return [makeRect(1, 1, totalCols, availRows)];
  }

  const gridCols = Math.ceil(Math.sqrt(count));
  const gridRows = Math.ceil(count / gridCols);
  // Fixed cell size for ALL cells
  const cellWidth = Math.floor(totalCols / gridCols);
  const cellHeight = Math.floor(availRows / gridRows);
  const rects: PaneRect[] = [];

  for (let i = 0; i < count; i++) {
    const gridRow = Math.floor(i / gridCols);
    const isLastGridRow = gridRow === gridRows - 1;
    const panesInThisRow = isLastGridRow ? count - gridRow * gridCols : gridCols;
    const colInRow = isLastGridRow ? i - gridRow * gridCols : i % gridCols;

    // Center the last row if it has fewer panes
    const rowOffset = isLastGridRow
      ? Math.floor((totalCols - panesInThisRow * cellWidth) / 2)
      : 0;

    const outerCol = rowOffset + colInRow * cellWidth + 1;
    const outerRow = gridRow * cellHeight + 1;

    rects.push(makeRect(outerRow, outerCol, cellWidth, cellHeight));
  }

  return rects;
}
