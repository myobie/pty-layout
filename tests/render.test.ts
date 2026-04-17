import { describe, it, expect } from "vitest";
import { CellBuffer } from "@myobie/pty/tui";
import { buildCollapsedTitleStrip, renderPrefixOverlay } from "../src/render.ts";

/** Read a row of characters from a CellBuffer (1-indexed row). */
function readRow(buf: CellBuffer, row: number, startCol: number, endCol: number): string {
  let out = "";
  for (let c = startCol; c <= endCol; c++) {
    const cell = buf.getCell(row - 1, c - 1);
    out += (cell?.char ?? " ") || " ";
  }
  return out;
}

describe("buildCollapsedTitleStrip", () => {
  it("starts with 2 rule chars + space + title (aligns with focused `╭─ `)", () => {
    const strip = buildCollapsedTitleStrip("1: bash", 40);
    // Focused box top border is `╭─ 1: bash ────╮`. Title starts at col 4.
    // Collapsed strip must also have title at col 4: `── 1: bash ───...`.
    expect(strip.startsWith("── 1: bash ")).toBe(true);
  });

  it("fills remaining width with rule chars", () => {
    const strip = buildCollapsedTitleStrip("abc", 20);
    // Structure: ──[space]abc[space][rules to width] = "── abc ──────────────"
    //           cols: 1 2 3 45 6 7 8 ...20
    const rules = "─".repeat(13);
    expect(strip).toBe("── abc " + rules);
  });

  it("visible length equals the requested width when title fits", () => {
    const visLen = (s: string) => [...s].length;
    for (const width of [40, 80, 120]) {
      expect(visLen(buildCollapsedTitleStrip("some title", width))).toBe(width);
    }
  });

  it("handles very narrow widths by clamping right fill to 0 (may exceed width)", () => {
    // Title + padding is wider than the available width. We don't try to
    // truncate — just don't crash, and produce a sensible prefix.
    const strip = buildCollapsedTitleStrip("hello", 5);
    expect(strip.startsWith("── hello ")).toBe(true);
  });

  it("handles empty title", () => {
    const strip = buildCollapsedTitleStrip("", 20);
    // titleText = ` ${""} ` = "  " (two spaces)
    // strip = "──" + "  " + rules → starts with "──  ─"
    expect(strip.slice(0, 5)).toBe("──  ─");
  });
});

describe("renderPrefixOverlay", () => {
  it("move-mode title row stays inside the box (no overflow)", () => {
    // Large terminal so the box fits comfortably.
    const rows = 20;
    const cols = 80;
    const buf = new CellBuffer(rows, cols);
    renderPrefixOverlay(buf, rows, cols, /*moveMode=*/true);

    // Find the row that contains the title text
    let titleRow = -1;
    for (let r = 1; r <= rows; r++) {
      const text = readRow(buf, r, 1, cols);
      if (text.includes("Move this pane to:")) {
        titleRow = r;
        break;
      }
    }
    expect(titleRow).toBeGreaterThan(0);

    // Find the vertical borders on that row. We expect exactly one `│`
    // to the left of the title and one `│` to the right. Anything after
    // the right border must be space (no leaked text).
    const line = readRow(buf, titleRow, 1, cols);
    const leftBorder = line.indexOf("│");
    const rightBorder = line.lastIndexOf("│");
    expect(leftBorder).toBeGreaterThanOrEqual(0);
    expect(rightBorder).toBeGreaterThan(leftBorder);
    // Title must be inside the borders
    const titleIdx = line.indexOf("Move this pane to:");
    expect(titleIdx).toBeGreaterThan(leftBorder);
    expect(titleIdx + "Move this pane to:".length).toBeLessThanOrEqual(rightBorder);
    // Everything past the right border is space
    expect(line.slice(rightBorder + 1).trim()).toBe("");
  });

  it("normal prefix overlay fits inside the box", () => {
    const rows = 20;
    const cols = 80;
    const buf = new CellBuffer(rows, cols);
    renderPrefixOverlay(buf, rows, cols);

    // `next pane` should appear inside the box, not overflow past it
    for (let r = 1; r <= rows; r++) {
      const line = readRow(buf, r, 1, cols);
      if (line.includes("next pane")) {
        const rightBorder = line.lastIndexOf("│");
        const nextPaneEnd = line.indexOf("next pane") + "next pane".length;
        expect(nextPaneEnd).toBeLessThanOrEqual(rightBorder);
        return;
      }
    }
    throw new Error("expected to find `next pane` text in overlay");
  });

  it("move-mode overlay no longer mentions `a-z position`", () => {
    const rows = 20;
    const cols = 80;
    const buf = new CellBuffer(rows, cols);
    renderPrefixOverlay(buf, rows, cols, /*moveMode=*/true);
    let all = "";
    for (let r = 1; r <= rows; r++) all += readRow(buf, r, 1, cols);
    expect(all).toContain("1-9");
    expect(all).not.toContain("a-z");
  });
});
