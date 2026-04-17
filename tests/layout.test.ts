import { describe, it, expect } from "vitest";
import {
  calculateLayout,
  nextLayoutMode,
  parseLayoutsFlag,
  isLayoutMode,
  DEFAULT_LAYOUT_MODES,
  ALL_LAYOUT_MODES,
  type PaneRect,
  type LayoutMode,
} from "../src/layout.ts";

const STATUS_BAR = 1;

function assertInnerDerived(rects: PaneRect[]) {
  for (const r of rects) {
    expect(r.innerRow).toBe(r.outerRow + 1);
    expect(r.innerCol).toBe(r.outerCol + 1);
    expect(r.innerWidth).toBe(Math.max(r.outerWidth - 2, 0));
    expect(r.innerHeight).toBe(Math.max(r.outerHeight - 2, 0));
  }
}

function assertNoBoundsOverflow(rects: PaneRect[], totalRows: number, totalCols: number) {
  const availRows = totalRows - STATUS_BAR;
  for (const r of rects) {
    expect(r.outerRow).toBeGreaterThanOrEqual(1);
    expect(r.outerCol).toBeGreaterThanOrEqual(1);
    expect(r.outerRow + r.outerHeight - 1).toBeLessThanOrEqual(availRows);
    expect(r.outerCol + r.outerWidth - 1).toBeLessThanOrEqual(totalCols);
  }
}

function assertNoOverlap(rects: PaneRect[]) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlapH =
        a.outerCol < b.outerCol + b.outerWidth &&
        a.outerCol + a.outerWidth > b.outerCol;
      const overlapV =
        a.outerRow < b.outerRow + b.outerHeight &&
        a.outerRow + a.outerHeight > b.outerRow;
      expect(
        overlapH && overlapV,
        `Panes ${i} and ${j} overlap`,
      ).toBe(false);
    }
  }
}

// --- nextLayoutMode ---

describe("nextLayoutMode", () => {
  it("default cycle: grid -> stacked -> single -> grid (zoom excluded)", () => {
    expect(nextLayoutMode("grid")).toBe("stacked");
    expect(nextLayoutMode("stacked")).toBe("single");
    expect(nextLayoutMode("single")).toBe("grid");
  });

  it("DEFAULT_LAYOUT_MODES does not include zoom", () => {
    expect(DEFAULT_LAYOUT_MODES).toEqual(["grid", "stacked", "single"]);
    expect(DEFAULT_LAYOUT_MODES).not.toContain("zoom");
  });

  it("ALL_LAYOUT_MODES includes every layout", () => {
    expect(ALL_LAYOUT_MODES).toEqual(["grid", "zoom", "single", "stacked"]);
  });

  it("cycles through a custom list (with zoom added)", () => {
    const withZoom: LayoutMode[] = ["grid", "stacked", "single", "zoom"];
    expect(nextLayoutMode("grid", withZoom)).toBe("stacked");
    expect(nextLayoutMode("stacked", withZoom)).toBe("single");
    expect(nextLayoutMode("single", withZoom)).toBe("zoom");
    expect(nextLayoutMode("zoom", withZoom)).toBe("grid");
  });

  it("falls back to first entry when current is not in the list", () => {
    const list: LayoutMode[] = ["grid", "stacked"];
    expect(nextLayoutMode("zoom", list)).toBe("grid");
    expect(nextLayoutMode("single", list)).toBe("grid");
  });

  it("returns current when list is empty (defensive)", () => {
    expect(nextLayoutMode("grid", [])).toBe("grid");
  });
});

describe("isLayoutMode", () => {
  it("accepts known layouts", () => {
    expect(isLayoutMode("grid")).toBe(true);
    expect(isLayoutMode("zoom")).toBe(true);
    expect(isLayoutMode("single")).toBe(true);
    expect(isLayoutMode("stacked")).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isLayoutMode("sausage")).toBe(false);
    expect(isLayoutMode("")).toBe(false);
    expect(isLayoutMode("GRID")).toBe(false); // case sensitive
  });
});

describe("parseLayoutsFlag", () => {
  it("empty string returns the defaults", () => {
    expect(parseLayoutsFlag("")).toEqual(["grid", "stacked", "single"]);
  });

  it("+zoom appends zoom to the defaults", () => {
    expect(parseLayoutsFlag("+zoom")).toEqual(["grid", "stacked", "single", "zoom"]);
  });

  it("whitespace and empty tokens are tolerated", () => {
    expect(parseLayoutsFlag(" +zoom , ")).toEqual(["grid", "stacked", "single", "zoom"]);
  });

  it("multiple + tokens add each", () => {
    // zoom is the only opt-in one today, but the parser must handle
    // multiple without duplicating what's already present.
    expect(parseLayoutsFlag("+zoom,+grid,+stacked")).toEqual(["grid", "stacked", "single", "zoom"]);
  });

  it("throws on unknown layout names", () => {
    expect(() => parseLayoutsFlag("+bogus")).toThrow(/unknown layout/);
  });

  it("throws on non-+ tokens (reserved for future use)", () => {
    expect(() => parseLayoutsFlag("zoom")).toThrow(/unsupported token/);
    expect(() => parseLayoutsFlag("-zoom")).toThrow(/unsupported token/);
    expect(() => parseLayoutsFlag("=zoom,stacked")).toThrow(/unsupported token/);
  });
});

// --- Edge cases ---

describe("calculateLayout edge cases", () => {
  it("returns empty array for 0 panes", () => {
    expect(calculateLayout("grid", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
    expect(calculateLayout("zoom", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
    expect(calculateLayout("single", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
    expect(calculateLayout("stacked", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
  });

  it("returns empty array for tiny terminal", () => {
    expect(calculateLayout("grid", 1, 2, 2, STATUS_BAR, 0)).toEqual([]);
  });

  it("works with minimum viable terminal", () => {
    const rects = calculateLayout("grid", 1, 4, 3, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
    expect(rects[0].innerWidth).toBe(1);
    expect(rects[0].innerHeight).toBe(1);
  });
});

// --- Grid layout (fills space, last row panes wider) ---

describe("grid layout", () => {
  it("1 pane fills the whole area", () => {
    const rects = calculateLayout("grid", 1, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
    expect(rects[0].outerWidth).toBe(80);
    expect(rects[0].outerHeight).toBe(23);
    assertInnerDerived(rects);
  });

  it("2 panes: side by side", () => {
    const rects = calculateLayout("grid", 2, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(2);
    // ceil(sqrt(2)) = 2 cols, 1 row
    expect(rects[0].outerRow).toBe(rects[1].outerRow);
    expect(rects[0].outerWidth + rects[1].outerWidth).toBe(80);
    assertNoOverlap(rects);
    assertInnerDerived(rects);
  });

  it("3 panes: 2 on top, 1 on bottom (full width)", () => {
    const rects = calculateLayout("grid", 3, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(3);
    // Top row: 2 panes
    expect(rects[0].outerRow).toBe(rects[1].outerRow);
    // Bottom row: 1 pane, wider to fill space
    expect(rects[2].outerWidth).toBe(80);
    assertNoOverlap(rects);
    assertNoBoundsOverflow(rects, 24, 80);
  });

  it("4 panes: 2x2 grid", () => {
    const rects = calculateLayout("grid", 4, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(4);
    assertNoOverlap(rects);
    assertNoBoundsOverflow(rects, 24, 80);
    assertInnerDerived(rects);
  });

  it("5 panes: last row panes are wider", () => {
    const rects = calculateLayout("grid", 5, 24, 90, STATUS_BAR, 0);
    expect(rects.length).toBe(5);
    // Top: 3 panes at 30 each, bottom: 2 panes at 45 each
    expect(rects[3].outerWidth).toBeGreaterThanOrEqual(rects[0].outerWidth);
    assertNoOverlap(rects);
    assertNoBoundsOverflow(rects, 24, 90);
  });

  it("no gaps or overlaps for 1-9 panes", () => {
    for (let n = 1; n <= 9; n++) {
      const rects = calculateLayout("grid", n, 40, 120, STATUS_BAR, 0);
      assertNoOverlap(rects);
      assertNoBoundsOverflow(rects, 40, 120);
      assertInnerDerived(rects);
    }
  });
});

// --- Zoom layout (all cells same size) ---

describe("zoom layout", () => {
  it("1 pane fills the whole area", () => {
    const rects = calculateLayout("zoom", 1, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
    expect(rects[0].outerWidth).toBe(80);
    expect(rects[0].outerHeight).toBe(23);
  });

  it("2 panes: same width", () => {
    const rects = calculateLayout("zoom", 2, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(2);
    expect(rects[0].outerWidth).toBe(rects[1].outerWidth);
    assertNoOverlap(rects);
  });

  it("3 panes: all same cell width (not full-width bottom)", () => {
    const rects = calculateLayout("zoom", 3, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(3);
    // All panes should have the same width
    expect(rects[0].outerWidth).toBe(rects[1].outerWidth);
    expect(rects[0].outerWidth).toBe(rects[2].outerWidth);
    assertNoOverlap(rects);
  });

  it("4 panes: 2x2 all same size", () => {
    const rects = calculateLayout("zoom", 4, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(4);
    const w = rects[0].outerWidth;
    const h = rects[0].outerHeight;
    for (const r of rects) {
      expect(r.outerWidth).toBe(w);
      expect(r.outerHeight).toBe(h);
    }
    assertNoOverlap(rects);
  });

  it("5 panes: all same cell size, last row centered", () => {
    const rects = calculateLayout("zoom", 5, 24, 90, STATUS_BAR, 0);
    expect(rects.length).toBe(5);
    // All same width (30 each, based on 3 cols)
    const w = rects[0].outerWidth;
    for (const r of rects) {
      expect(r.outerWidth).toBe(w);
    }
    // Last row (2 panes) should be offset/centered
    expect(rects[3].outerCol).toBeGreaterThan(1);
    assertNoOverlap(rects);
  });

  it("7 panes: bottom pane same size as others, not full width", () => {
    const rects = calculateLayout("zoom", 7, 30, 90, STATUS_BAR, 0);
    expect(rects.length).toBe(7);
    // All same width
    const w = rects[0].outerWidth;
    expect(rects[6].outerWidth).toBe(w);
    assertNoOverlap(rects);
  });

  it("9 panes: 3x3 grid all same size", () => {
    const rects = calculateLayout("zoom", 9, 30, 90, STATUS_BAR, 0);
    expect(rects.length).toBe(9);
    for (const r of rects) {
      expect(r.outerWidth).toBe(30);
    }
    assertNoOverlap(rects);
  });

  it("inner rects are derived correctly", () => {
    for (let n = 1; n <= 9; n++) {
      const rects = calculateLayout("zoom", n, 40, 120, STATUS_BAR, 0);
      assertInnerDerived(rects);
    }
  });
});

// --- Single layout ---

describe("single layout", () => {
  it("returns 1 rect filling the whole area", () => {
    const rects = calculateLayout("single", 1, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
    expect(rects[0].outerWidth).toBe(80);
    expect(rects[0].outerHeight).toBe(23);
    assertInnerDerived(rects);
  });

  it("returns 1 rect regardless of pane count", () => {
    const rects = calculateLayout("single", 5, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
  });
});

// --- Stacked layout ---

describe("stacked layout", () => {
  it("1 pane fills the whole area (same as single)", () => {
    const rects = calculateLayout("stacked", 1, 24, 80, STATUS_BAR, 0);
    expect(rects.length).toBe(1);
    expect(rects[0].outerWidth).toBe(80);
    expect(rects[0].outerHeight).toBe(23);
    assertInnerDerived(rects);
  });

  it("5 panes, focused in middle: four 1-row strips, one focused box", () => {
    // 24 rows, status bar 1 → availRows 23. 4 collapsed × 1 + 1 focused = 23.
    // Focused takes 23 - 4 = 19 rows.
    const rects = calculateLayout("stacked", 5, 24, 80, STATUS_BAR, 2);
    expect(rects.length).toBe(5);
    expect(rects[0].outerHeight).toBe(1);
    expect(rects[1].outerHeight).toBe(1);
    expect(rects[2].outerHeight).toBe(19);
    expect(rects[3].outerHeight).toBe(1);
    expect(rects[4].outerHeight).toBe(1);
  });

  it("all panes span full width", () => {
    const rects = calculateLayout("stacked", 4, 24, 80, STATUS_BAR, 1);
    for (const r of rects) {
      expect(r.outerCol).toBe(1);
      expect(r.outerWidth).toBe(80);
    }
  });

  it("panes stack top-to-bottom in index order with no gap", () => {
    const rects = calculateLayout("stacked", 5, 30, 80, STATUS_BAR, 1);
    let expectedRow = 1;
    for (const r of rects) {
      expect(r.outerRow).toBe(expectedRow);
      expectedRow += r.outerHeight;
    }
    // Last rect's bottom edge == availRows
    const last = rects[rects.length - 1]!;
    expect(last.outerRow + last.outerHeight - 1).toBe(30 - STATUS_BAR);
  });

  it("focused pane at index 0 (first collapsed comes AFTER)", () => {
    const rects = calculateLayout("stacked", 3, 20, 80, STATUS_BAR, 0);
    expect(rects[0].outerHeight).toBeGreaterThan(1); // focused
    expect(rects[1].outerHeight).toBe(1); // collapsed
    expect(rects[2].outerHeight).toBe(1); // collapsed
    assertNoOverlap(rects);
  });

  it("focused pane at last index", () => {
    const rects = calculateLayout("stacked", 3, 20, 80, STATUS_BAR, 2);
    expect(rects[0].outerHeight).toBe(1);
    expect(rects[1].outerHeight).toBe(1);
    expect(rects[2].outerHeight).toBeGreaterThan(1);
    assertNoOverlap(rects);
  });

  it("no overlaps and no overflow across pane counts", () => {
    for (const count of [2, 3, 5, 8, 10]) {
      for (const focused of [0, Math.floor(count / 2), count - 1]) {
        const rects = calculateLayout("stacked", count, 40, 100, STATUS_BAR, focused);
        expect(rects.length).toBe(count);
        assertInnerDerived(rects);
        assertNoOverlap(rects);
        assertNoBoundsOverflow(rects, 40, 100);
      }
    }
  });

  it("collapsed panes have innerHeight 0 (no content area)", () => {
    const rects = calculateLayout("stacked", 4, 30, 80, STATUS_BAR, 1);
    const collapsed = rects.filter(r => r.outerHeight === 1);
    for (const r of collapsed) {
      expect(r.innerHeight).toBe(0);
    }
  });

  it("focused pane's innerHeight accounts for 2 border rows", () => {
    const rects = calculateLayout("stacked", 3, 24, 80, STATUS_BAR, 1);
    const focused = rects[1]!;
    expect(focused.innerHeight).toBe(focused.outerHeight - 2);
  });

  it("degrades gracefully when too many panes for available rows", () => {
    // 30 panes in a 20-row terminal. Collapsed total = 29, but availRows=19.
    // Focused clamps to 0. No crash, rects still returned.
    const rects = calculateLayout("stacked", 30, 20, 80, STATUS_BAR, 5);
    expect(rects.length).toBe(30);
  });
});

// --- Cross-mode consistency ---

describe("cross-mode consistency", () => {
  it("1 pane produces same rect in all modes", () => {
    const modes: LayoutMode[] = ["grid", "zoom", "single", "stacked"];
    for (const m of modes) {
      const rects = calculateLayout(m, 1, 24, 80, STATUS_BAR, 0);
      expect(rects.length).toBe(1);
      expect(rects[0].outerWidth).toBe(80);
      expect(rects[0].outerHeight).toBe(23);
    }
  });

  it("no rects have zero or negative dimensions for 1-9 panes", () => {
    const modes: LayoutMode[] = ["grid", "zoom"];
    for (const mode of modes) {
      for (let n = 1; n <= 9; n++) {
        const rects = calculateLayout(mode, n, 40, 120, STATUS_BAR, 0);
        for (const r of rects) {
          expect(r.outerWidth).toBeGreaterThanOrEqual(3);
          expect(r.outerHeight).toBeGreaterThanOrEqual(3);
          expect(r.innerWidth).toBeGreaterThanOrEqual(1);
          expect(r.innerHeight).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
