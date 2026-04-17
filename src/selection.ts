import type { PaneRect } from "./layout.ts";

export interface SelectionState {
  paneId: number;
  paneIndex: number;
  scrollOffset: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  active: boolean;
}

export function isSelected(row: number, col: number, sel: SelectionState): boolean {
  let r1 = sel.startRow, c1 = sel.startCol;
  let r2 = sel.endRow, c2 = sel.endCol;
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    [r1, c1, r2, c2] = [r2, c2, r1, c1];
  }

  if (row < r1 || row > r2) return false;
  if (row === r1 && row === r2) return col >= c1 && col <= c2;
  if (row === r1) return col >= c1;
  if (row === r2) return col <= c2;
  return true;
}

/** Check if a screen cell is part of a selection, translating the
 *  selection's captured coordinates to the current scroll position.
 *
 *  Selections are captured in screen-local coords at the time of the
 *  mousedown (along with the scroll offset in effect then). When the
 *  user scrolls the pane afterwards, the highlight must follow the
 *  selected content — NOT stay in the same on-screen position.
 *
 *  delta = current - captured. When user scrolls up (offset increases),
 *  the selected content moves DOWN on screen by `delta` rows. So we
 *  translate the current screen cell's row back by `-delta` before
 *  checking against the captured bounds. */
export function isSelectedAtScroll(
  screenRow: number,
  screenCol: number,
  sel: SelectionState,
  currentScrollOffset: number,
): boolean {
  const delta = currentScrollOffset - sel.scrollOffset;
  return isSelected(screenRow - delta, screenCol, sel);
}

export function hasDragDistance(sel: SelectionState): boolean {
  return sel.startRow !== sel.endRow || sel.startCol !== sel.endCol;
}

export function extractSelectedText(
  cells: { char: string }[][],
  sel: SelectionState,
): string {
  let r1 = sel.startRow, c1 = sel.startCol;
  let r2 = sel.endRow, c2 = sel.endCol;
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    [r1, c1, r2, c2] = [r2, c2, r1, c1];
  }

  const lines: string[] = [];
  for (let r = r1; r <= r2; r++) {
    const row = cells[r];
    if (!row) { lines.push(""); continue; }
    const colStart = r === r1 ? c1 : 0;
    const colEnd = r === r2 ? c2 : row.length - 1;
    let line = "";
    for (let c = colStart; c <= colEnd; c++) {
      const ch = row[c]?.char ?? " ";
      if (ch !== "") line += ch; // skip wide-char placeholders
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

export function copyToClipboard(text: string): string {
  const encoded = Buffer.from(text).toString("base64");
  return `\x1b]52;c;${encoded}\x07`;
}

export function screenToPaneLocal(
  screenRow: number,
  screenCol: number,
  rect: PaneRect,
): { row: number; col: number } {
  return {
    row: screenRow - rect.innerRow,
    col: screenCol - rect.innerCol,
  };
}

export function clampToInner(
  row: number,
  col: number,
  rect: PaneRect,
): { row: number; col: number } {
  return {
    row: Math.max(0, Math.min(row, rect.innerHeight - 1)),
    col: Math.max(0, Math.min(col, rect.innerWidth - 1)),
  };
}
