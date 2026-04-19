import { describe, it, expect } from "vitest";
import {
  newLayoutTagKey,
  formatLayoutBadge,
  LAYOUT_TAG_KEY_RE,
} from "../src/layout-tag.ts";

describe("newLayoutTagKey", () => {
  it("matches the pty gc regex shape :l<pid>-<rand>", () => {
    const key = newLayoutTagKey(12345);
    expect(LAYOUT_TAG_KEY_RE.test(key)).toBe(true);
  });

  it("embeds the given PID", () => {
    const key = newLayoutTagKey(99999);
    const m = LAYOUT_TAG_KEY_RE.exec(key)!;
    expect(m[1]).toBe("99999");
  });

  it("generates a unique suffix each call", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) keys.add(newLayoutTagKey(1));
    // Suffix is 8 chars from 36-char alphabet → collision probability
    // per pair ~= 1/36^8. 50 calls → vanishingly unlikely to collide.
    expect(keys.size).toBe(50);
  });

  it("uses lowercase alphanumeric suffix (matches pty's regex)", () => {
    const key = newLayoutTagKey(1);
    const suffix = key.split("-")[1]!;
    expect(/^[a-z0-9]+$/.test(suffix)).toBe(true);
    expect(suffix.length).toBe(8);
  });

  it("defaults to process.pid when no pid arg", () => {
    const key = newLayoutTagKey();
    const m = LAYOUT_TAG_KEY_RE.exec(key)!;
    expect(parseInt(m[1]!, 10)).toBe(process.pid);
  });

  it("uses reserved `:` prefix so pty hides it from default listings", () => {
    const key = newLayoutTagKey(1);
    expect(key.startsWith(":")).toBe(true);
  });
});

describe("formatLayoutBadge", () => {
  it("auto-tag: shows just the short suffix in brackets", () => {
    expect(formatLayoutBadge([], ":l12345-abcxyz99")).toBe("[abcxyz99]");
  });

  it("auto-tag: falls back to full key if no `-` separator", () => {
    // Defensive — shouldn't happen in normal flow
    expect(formatLayoutBadge([], ":lweird")).toBe("[:lweird]");
  });

  it("explicit tag key=value: shows the full expression", () => {
    expect(formatLayoutBadge([{ key: "team", value: "alpha" }], null)).toBe("[team=alpha]");
  });

  it("explicit tag with multiple filters: joins with comma", () => {
    expect(formatLayoutBadge(
      [{ key: "team", value: "alpha" }, { key: "env", value: "dev" }],
      null,
    )).toBe("[team=alpha,env=dev]");
  });

  it("explicit tag key-only: shows just the key", () => {
    expect(formatLayoutBadge([{ key: "project" }], null)).toBe("[project]");
  });

  it("no filters and no auto key: empty string", () => {
    expect(formatLayoutBadge([], null)).toBe("");
  });

  it("auto key wins over filters (auto mode always carries both)", () => {
    // In auto-tag mode, tagFilters also contains [{key: autoKey, value: "1"}].
    // Badge should display the auto suffix, not the raw internal key.
    const autoKey = ":l42-deadbeef";
    const filters = [{ key: autoKey, value: "1" }];
    expect(formatLayoutBadge(filters, autoKey)).toBe("[deadbeef]");
  });
});
