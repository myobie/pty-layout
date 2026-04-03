import { describe, it, expect } from "vitest";
import {
  isSelected,
  hasDragDistance,
  extractSelectedText,
  copyToClipboard,
  screenToPaneLocal,
  clampToInner,
  type SelectionState,
} from "../src/selection.ts";

function sel(startRow: number, startCol: number, endRow: number, endCol: number): SelectionState {
  return { paneId: 1, paneIndex: 0, scrollOffset: 0, startRow, startCol, endRow, endCol, active: false };
}

describe("isSelected", () => {
  it("single row: selects within range", () => {
    const s = sel(2, 3, 2, 7);
    expect(isSelected(2, 3, s)).toBe(true);
    expect(isSelected(2, 5, s)).toBe(true);
    expect(isSelected(2, 7, s)).toBe(true);
    expect(isSelected(2, 2, s)).toBe(false);
    expect(isSelected(2, 8, s)).toBe(false);
    expect(isSelected(1, 5, s)).toBe(false);
    expect(isSelected(3, 5, s)).toBe(false);
  });

  it("multi-row: first row from startCol, last row to endCol, middle rows fully", () => {
    const s = sel(1, 5, 3, 10);
    // Row 1: col >= 5
    expect(isSelected(1, 5, s)).toBe(true);
    expect(isSelected(1, 79, s)).toBe(true);
    expect(isSelected(1, 4, s)).toBe(false);
    // Row 2: fully selected
    expect(isSelected(2, 0, s)).toBe(true);
    expect(isSelected(2, 79, s)).toBe(true);
    // Row 3: col <= 10
    expect(isSelected(3, 0, s)).toBe(true);
    expect(isSelected(3, 10, s)).toBe(true);
    expect(isSelected(3, 11, s)).toBe(false);
  });

  it("handles reversed start/end (drag upward)", () => {
    const s = sel(5, 10, 2, 3);
    // Same as sel(2, 3, 5, 10) after normalization
    expect(isSelected(2, 3, s)).toBe(true);
    expect(isSelected(3, 0, s)).toBe(true);
    expect(isSelected(5, 10, s)).toBe(true);
    expect(isSelected(5, 11, s)).toBe(false);
    expect(isSelected(1, 5, s)).toBe(false);
  });

  it("single cell selection", () => {
    const s = sel(3, 3, 3, 3);
    expect(isSelected(3, 3, s)).toBe(true);
    expect(isSelected(3, 2, s)).toBe(false);
    expect(isSelected(3, 4, s)).toBe(false);
  });
});

describe("hasDragDistance", () => {
  it("false when start equals end", () => {
    expect(hasDragDistance(sel(5, 10, 5, 10))).toBe(false);
  });

  it("true when row differs", () => {
    expect(hasDragDistance(sel(5, 10, 6, 10))).toBe(true);
  });

  it("true when col differs", () => {
    expect(hasDragDistance(sel(5, 10, 5, 11))).toBe(true);
  });
});

describe("extractSelectedText", () => {
  const grid = [
    [{ char: "H" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" }, { char: " " }],
    [{ char: "W" }, { char: "o" }, { char: "r" }, { char: "l" }, { char: "d" }, { char: " " }],
    [{ char: "F" }, { char: "o" }, { char: "o" }, { char: " " }, { char: " " }, { char: " " }],
  ];

  it("extracts single row selection", () => {
    const text = extractSelectedText(grid, sel(0, 0, 0, 4));
    expect(text).toBe("Hello");
  });

  it("extracts multi-row selection", () => {
    const text = extractSelectedText(grid, sel(0, 3, 1, 2));
    // Row 0 from col 3: "lo " → trimmed: "lo"
    // Row 1 to col 2: "Wor"
    expect(text).toBe("lo\nWor");
  });

  it("trims trailing whitespace per line", () => {
    const text = extractSelectedText(grid, sel(2, 0, 2, 5));
    expect(text).toBe("Foo");
  });

  it("handles reversed selection", () => {
    const text = extractSelectedText(grid, sel(0, 4, 0, 0));
    expect(text).toBe("Hello");
  });

  it("skips wide-char placeholders (empty string chars)", () => {
    const wideGrid = [
      [{ char: "A" }, { char: "漢" }, { char: "" }, { char: "B" }],
    ];
    const text = extractSelectedText(wideGrid, sel(0, 0, 0, 3));
    expect(text).toBe("A漢B");
  });
});

describe("copyToClipboard", () => {
  it("returns OSC 52 sequence with base64 payload", () => {
    const result = copyToClipboard("hello");
    const expected = Buffer.from("hello").toString("base64");
    expect(result).toBe(`\x1b]52;c;${expected}\x07`);
  });

  it("handles empty string", () => {
    const result = copyToClipboard("");
    expect(result).toBe(`\x1b]52;c;\x07`);
  });

  it("handles multi-line text", () => {
    const result = copyToClipboard("line1\nline2");
    const expected = Buffer.from("line1\nline2").toString("base64");
    expect(result).toBe(`\x1b]52;c;${expected}\x07`);
  });
});

describe("screenToPaneLocal", () => {
  const rect = {
    outerRow: 1, outerCol: 1, outerWidth: 42, outerHeight: 12,
    innerRow: 2, innerCol: 2, innerWidth: 40, innerHeight: 10,
  };

  it("translates screen coords to pane-local", () => {
    expect(screenToPaneLocal(2, 2, rect)).toEqual({ row: 0, col: 0 });
    expect(screenToPaneLocal(5, 10, rect)).toEqual({ row: 3, col: 8 });
  });
});

describe("clampToInner", () => {
  const rect = {
    outerRow: 1, outerCol: 1, outerWidth: 42, outerHeight: 12,
    innerRow: 2, innerCol: 2, innerWidth: 40, innerHeight: 10,
  };

  it("clamps negative values to 0", () => {
    expect(clampToInner(-1, -1, rect)).toEqual({ row: 0, col: 0 });
  });

  it("clamps beyond bounds to max", () => {
    expect(clampToInner(100, 100, rect)).toEqual({ row: 9, col: 39 });
  });

  it("passes through valid values", () => {
    expect(clampToInner(5, 20, rect)).toEqual({ row: 5, col: 20 });
  });
});
