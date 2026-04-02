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

export type LayoutMode = "grid" | "zoom" | "single";

export const LAYOUT_MODES: LayoutMode[] = ["grid", "zoom", "single"];

export function nextLayoutMode(current: LayoutMode): LayoutMode {
  const idx = LAYOUT_MODES.indexOf(current);
  return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length]!;
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
