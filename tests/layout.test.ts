import { describe, it, expect } from "vitest";
import { calculateLayout, nextLayoutMode, LAYOUT_MODES, type PaneRect, type LayoutMode } from "../src/layout.ts";

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
  it("cycles grid -> zoom -> single -> grid", () => {
    expect(nextLayoutMode("grid")).toBe("zoom");
    expect(nextLayoutMode("zoom")).toBe("single");
    expect(nextLayoutMode("single")).toBe("grid");
  });

  it("LAYOUT_MODES contains all three modes", () => {
    expect(LAYOUT_MODES).toEqual(["grid", "zoom", "single"]);
  });
});

// --- Edge cases ---

describe("calculateLayout edge cases", () => {
  it("returns empty array for 0 panes", () => {
    expect(calculateLayout("grid", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
    expect(calculateLayout("zoom", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
    expect(calculateLayout("single", 0, 24, 80, STATUS_BAR, 0)).toEqual([]);
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

// --- Cross-mode consistency ---

describe("cross-mode consistency", () => {
  it("1 pane produces same rect in all modes", () => {
    const modes: LayoutMode[] = ["grid", "zoom", "single"];
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
