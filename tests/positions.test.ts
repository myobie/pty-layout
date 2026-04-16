import { describe, it, expect } from "vitest";
import {
  indexToPositionKey,
  positionKeyToIndex,
  COMMAND_LETTERS,
  MAX_POSITIONS,
} from "../src/positions.ts";

describe("indexToPositionKey", () => {
  it("maps 0..8 to digits 1..9", () => {
    expect(indexToPositionKey(0)).toBe("1");
    expect(indexToPositionKey(4)).toBe("5");
    expect(indexToPositionKey(8)).toBe("9");
  });

  it("maps 9 to the first usable letter", () => {
    expect(indexToPositionKey(9)).toBe("a");
  });

  it("skips command letters", () => {
    // 'l', 'm', 'n', 'q', 'w' are commands. 'a' through 'k' are positions 10-20.
    expect(indexToPositionKey(9)).toBe("a");
    expect(indexToPositionKey(10)).toBe("b");
    expect(indexToPositionKey(18)).toBe("j");
    expect(indexToPositionKey(19)).toBe("k");
    // Position 20 should skip 'l' and land on 'o' (because 'm' and 'n' are also commands)
    // a=9, b=10, c=11, d=12, e=13, f=14, g=15, h=16, i=17, j=18, k=19, [skip l,m,n], o=20
    expect(indexToPositionKey(20)).toBe("o");
  });

  it("returns null for negative", () => {
    expect(indexToPositionKey(-1)).toBeNull();
  });

  it("returns null beyond MAX_POSITIONS", () => {
    expect(indexToPositionKey(MAX_POSITIONS)).toBeNull();
    expect(indexToPositionKey(MAX_POSITIONS + 100)).toBeNull();
  });

  it("produces a unique key per index within range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < MAX_POSITIONS; i++) {
      const k = indexToPositionKey(i);
      expect(k).not.toBeNull();
      expect(seen.has(k!)).toBe(false);
      seen.add(k!);
    }
  });
});

describe("positionKeyToIndex", () => {
  it("maps '1'..'9' to 0..8", () => {
    expect(positionKeyToIndex("1")).toBe(0);
    expect(positionKeyToIndex("5")).toBe(4);
    expect(positionKeyToIndex("9")).toBe(8);
  });

  it("maps usable letters to 9+", () => {
    expect(positionKeyToIndex("a")).toBe(9);
    expect(positionKeyToIndex("b")).toBe(10);
    expect(positionKeyToIndex("k")).toBe(19);
  });

  it("returns null for command letters", () => {
    for (const c of COMMAND_LETTERS) {
      expect(positionKeyToIndex(c)).toBeNull();
    }
  });

  it("returns null for non-alphanumeric", () => {
    expect(positionKeyToIndex("/")).toBeNull();
    expect(positionKeyToIndex("?")).toBeNull();
    expect(positionKeyToIndex(" ")).toBeNull();
  });

  it("returns null for '0'", () => {
    expect(positionKeyToIndex("0")).toBeNull();
  });

  it("returns null for multi-char strings", () => {
    expect(positionKeyToIndex("10")).toBeNull();
    expect(positionKeyToIndex("ab")).toBeNull();
  });

  it("is case-insensitive for letters", () => {
    expect(positionKeyToIndex("A")).toBe(9);
    expect(positionKeyToIndex("K")).toBe(19);
  });
});

describe("round-trip", () => {
  it("indexToPositionKey and positionKeyToIndex are inverses", () => {
    for (let i = 0; i < MAX_POSITIONS; i++) {
      const k = indexToPositionKey(i);
      expect(positionKeyToIndex(k!)).toBe(i);
    }
  });
});
