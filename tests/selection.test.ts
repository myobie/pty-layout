import { describe, it, expect } from "vitest";
import {
  isSelected,
  isSelectedAtScroll,
  hasDragDistance,
  extractSelectedText,
  copyToClipboard,
  screenToPaneLocal,
  clampToInner,
  type SelectionState,
} from "../src/selection.ts";

function sel(startRow: number, startCol: number, endRow: number, endCol: number, scrollOffset = 0): SelectionState {
  return { paneId: 1, paneIndex: 0, scrollOffset, startRow, startCol, endRow, endCol, active: false };
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

describe("isSelectedAtScroll", () => {
  it("matches isSelected when scroll hasn't changed", () => {
    const s = sel(5, 0, 10, 10, 0);
    // Same scroll offset as captured → delta=0 → unchanged behavior
    expect(isSelectedAtScroll(5, 5, s, 0)).toBe(true);
    expect(isSelectedAtScroll(10, 5, s, 0)).toBe(true);
    expect(isSelectedAtScroll(4, 5, s, 0)).toBe(false);
    expect(isSelectedAtScroll(11, 5, s, 0)).toBe(false);
  });

  it("shifts highlight DOWN on screen when user scrolls up", () => {
    // Selection captured at scrollOffset=0, rows 5-10.
    // User scrolls up by 3 → the selected content (rows 5-10 in the old
    // view) is now at screen rows 8-13 in the new view. Content at the
    // original screen rows 5-10 is now different (older scrollback).
    const s = sel(5, 0, 10, 10, 0);
    expect(isSelectedAtScroll(8, 5, s, 3)).toBe(true);   // content was at row 5
    expect(isSelectedAtScroll(13, 5, s, 3)).toBe(true);  // content was at row 10
    expect(isSelectedAtScroll(7, 5, s, 3)).toBe(false);  // row above selected range
    expect(isSelectedAtScroll(14, 5, s, 3)).toBe(false); // row below selected range
    // Rows 5-10 on the new view = content that was at rows 2-7 on the
    // old view. Row 2 was NOT selected; rows 5-7 were. So:
    expect(isSelectedAtScroll(5, 5, s, 3)).toBe(false);  // row 2 content, unselected
    expect(isSelectedAtScroll(10, 5, s, 3)).toBe(true);  // row 7 content, selected
  });

  it("shifts highlight UP on screen when user scrolls back toward live", () => {
    // Selection captured while scrolled back at offset=5, rows 2-4.
    // User scrolls DOWN to offset=0 (live) → delta=-5 → content moved UP 5 rows.
    // A selection starting at screen row 2 (at offset=5) would now be at row -3 (off-screen).
    const s = sel(2, 0, 4, 10, 5);
    // The only visible selection would be for screen rows [-3..-1] which don't exist.
    expect(isSelectedAtScroll(0, 5, s, 0)).toBe(false);
    // But if the user scrolls back UP, selection becomes visible again
    expect(isSelectedAtScroll(2, 5, s, 5)).toBe(true);
  });

  it("handles selection across very different scroll offsets", () => {
    const s = sel(0, 0, 0, 10, 10);
    // Captured at offset=10, row 0. At offset=20, it's at screen row 10.
    expect(isSelectedAtScroll(10, 5, s, 20)).toBe(true);
    expect(isSelectedAtScroll(0, 5, s, 20)).toBe(false);
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

  describe("with wrapped flags", () => {
    // A URL that wraps across 3 screen rows (cols=10). The content is:
    //   "https://ex"  "ample.com/"  "long/path "
    // Rows 1 and 2 are continuations — wrapped[1]=true, wrapped[2]=true.
    const urlGrid = [
      [{ char: "h" }, { char: "t" }, { char: "t" }, { char: "p" }, { char: "s" }, { char: ":" }, { char: "/" }, { char: "/" }, { char: "e" }, { char: "x" }],
      [{ char: "a" }, { char: "m" }, { char: "p" }, { char: "l" }, { char: "e" }, { char: "." }, { char: "c" }, { char: "o" }, { char: "m" }, { char: "/" }],
      [{ char: "l" }, { char: "o" }, { char: "n" }, { char: "g" }, { char: "/" }, { char: "p" }, { char: "a" }, { char: "t" }, { char: "h" }, { char: " " }],
    ];

    it("joins wrapped rows without a newline (reconstructs a URL)", () => {
      const text = extractSelectedText(urlGrid, sel(0, 0, 2, 8), [false, true, true]);
      expect(text).toBe("https://example.com/long/path");
    });

    it("emits a newline at the last row of a wrap group (real line break after)", () => {
      // Two lines, each wrap-broken into 2 rows.
      // Line A (rows 0-1, wrapped[1]=true), Line B (rows 2-3, wrapped[3]=true).
      // Between: wrapped[2] = false (real newline).
      const grid = [
        [{ char: "a" }, { char: "a" }, { char: "a" }],
        [{ char: "b" }, { char: "b" }, { char: "b" }],
        [{ char: "c" }, { char: "c" }, { char: "c" }],
        [{ char: "d" }, { char: "d" }, { char: "d" }],
      ];
      const text = extractSelectedText(grid, sel(0, 0, 3, 2), [false, true, false, true]);
      expect(text).toBe("aaabbb\ncccddd");
    });

    it("preserves trailing spaces on wrapped rows (don't trim mid-line)", () => {
      // A command like:  echo hello   world
      // Wrapping mid-spaces — trimming would lose them.
      const grid = [
        [{ char: "e" }, { char: "c" }, { char: "h" }, { char: "o" }, { char: " " }, { char: "h" }, { char: "i" }, { char: " " }, { char: " " }, { char: " " }],
        [{ char: " " }, { char: "w" }, { char: "o" }, { char: "r" }, { char: "l" }, { char: "d" }, { char: " " }, { char: " " }, { char: " " }, { char: " " }],
      ];
      const text = extractSelectedText(grid, sel(0, 0, 1, 9), [false, true]);
      // 3 trailing spaces on row 0 + 1 leading space on row 1 = 4 spaces
      // between "hi" and "world". All preserved because row 1 is a wrap
      // continuation.
      expect(text).toBe("echo hi    world");
    });

    it("still trims trailing spaces on real-newline rows", () => {
      // Row 0 is NOT wrapped (real line end), so trailing spaces go away.
      const grid = [
        [{ char: "f" }, { char: "o" }, { char: "o" }, { char: " " }, { char: " " }],
        [{ char: "b" }, { char: "a" }, { char: "r" }, { char: " " }, { char: " " }],
      ];
      const text = extractSelectedText(grid, sel(0, 0, 1, 4), [false, false]);
      expect(text).toBe("foo\nbar");
    });

    it("falls back to always-newline when wrapped is omitted (legacy)", () => {
      const text = extractSelectedText(urlGrid, sel(0, 0, 2, 8));
      // No wrap info → every row boundary gets \n, preserving old behavior
      expect(text).toBe("https://ex\nample.com/\nlong/path");
    });

    it("single-row selection ignores wrapped flags (no boundary to cross)", () => {
      const text = extractSelectedText(urlGrid, sel(0, 0, 0, 4), [false, true, true]);
      expect(text).toBe("https");
    });

    it("selection starting mid-wrap correctly joins to end", () => {
      // Select from row 1 col 0 to row 2 col 8: "ample.com/long/path"
      const text = extractSelectedText(urlGrid, sel(1, 0, 2, 8), [false, true, true]);
      expect(text).toBe("ample.com/long/path");
    });

    it("wrapped[] shorter than cells[] — out-of-bounds treated as not-wrapped", () => {
      // Defensive: if the flags array comes back shorter than the cell
      // grid for any reason (resize race, pane disposed mid-call), we
      // must not crash and must fall back to inserting newlines.
      const text = extractSelectedText(urlGrid, sel(0, 0, 2, 8), [false]);
      expect(text).toBe("https://ex\nample.com/\nlong/path");
    });

    it("wrapped[] longer than cells[] — extra entries ignored", () => {
      const tooLong = [false, true, true, true, true, true, true];
      const text = extractSelectedText(urlGrid, sel(0, 0, 2, 8), tooLong);
      expect(text).toBe("https://example.com/long/path");
    });

    it("selection past cells[] bounds doesn't crash", () => {
      // sel end row is beyond cells.length — gracefully produce what
      // we can, with \n for missing rows.
      const text = extractSelectedText(urlGrid, sel(0, 0, 5, 3), [false]);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("https://ex");
    });

    it("empty cells grid + any selection doesn't crash", () => {
      const text = extractSelectedText([], sel(0, 0, 5, 10), []);
      expect(text).toBe("\n\n\n\n\n");
    });
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
