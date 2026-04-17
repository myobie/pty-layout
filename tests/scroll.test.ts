import { describe, it, expect } from "vitest";
import { adjustScrollOffset } from "../src/scroll.ts";

describe("adjustScrollOffset", () => {
  it("stays at 0 when following live (offset=0)", () => {
    const result = adjustScrollOffset({ offset: 0, lastBaseY: 100 }, 150);
    expect(result.offset).toBe(0);
    expect(result.lastBaseY).toBe(150);
  });

  it("keeps the same absolute lines in view when baseY advances", () => {
    // User is scrolled back 10 lines. baseY=100 means they're viewing lines 90-ish.
    // baseY advances to 105 (5 new lines). Offset should become 15 so they still
    // see lines 90-ish (baseY - offset = 105 - 15 = 90).
    const result = adjustScrollOffset({ offset: 10, lastBaseY: 100 }, 105);
    expect(result.offset).toBe(15);
    expect(result.lastBaseY).toBe(105);
  });

  it("preserves anchor across many advancements", () => {
    let state = { offset: 5, lastBaseY: 50 };
    const anchorAbsolute = 50 - 5; // absolute line at top of view: 45

    state = adjustScrollOffset(state, 60); // +10
    state = adjustScrollOffset(state, 75); // +15
    state = adjustScrollOffset(state, 100); // +25

    // baseY - offset should still equal the original anchor
    expect(state.lastBaseY - state.offset).toBe(anchorAbsolute);
  });

  it("does not change offset when baseY is unchanged", () => {
    const result = adjustScrollOffset({ offset: 7, lastBaseY: 100 }, 100);
    expect(result.offset).toBe(7);
  });

  it("updates lastBaseY even if baseY went backwards (defensive)", () => {
    const result = adjustScrollOffset({ offset: 5, lastBaseY: 100 }, 80);
    expect(result.offset).toBe(5); // unchanged
    expect(result.lastBaseY).toBe(80);
  });

  it("anchor math is stable after user scrolls (offset updated externally)", () => {
    // Sim: user is at offset=0, baseY=100. They scroll up 10 lines → offset=10.
    // At scroll time we snapshot lastBaseY=100. Then baseY advances to 120.
    const afterScroll = { offset: 10, lastBaseY: 100 };
    const afterAdvance = adjustScrollOffset(afterScroll, 120);
    // Anchor should still be at absolute line 90 (100-10)
    expect(afterAdvance.lastBaseY - afterAdvance.offset).toBe(90);
    expect(afterAdvance.offset).toBe(30);
  });
});
