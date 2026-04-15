import { describe, it, expect } from "vitest";
import { parseTagFilter, matchesTags, formatTagFilters } from "../src/tag-subscription.ts";

describe("parseTagFilter", () => {
  it("parses key=value", () => {
    expect(parseTagFilter("project=myapp")).toEqual({ key: "project", value: "myapp" });
  });

  it("parses key-only (no value)", () => {
    expect(parseTagFilter("project")).toEqual({ key: "project" });
  });

  it("handles value with equals sign", () => {
    expect(parseTagFilter("url=http://x=1")).toEqual({ key: "url", value: "http://x=1" });
  });

  it("handles empty value", () => {
    expect(parseTagFilter("key=")).toEqual({ key: "key", value: "" });
  });
});

describe("matchesTags", () => {
  it("matches exact key=value", () => {
    expect(matchesTags([{ key: "project", value: "myapp" }], { project: "myapp" })).toBe(true);
  });

  it("rejects wrong value", () => {
    expect(matchesTags([{ key: "project", value: "myapp" }], { project: "other" })).toBe(false);
  });

  it("rejects missing key", () => {
    expect(matchesTags([{ key: "project", value: "myapp" }], { env: "prod" })).toBe(false);
  });

  it("key-only matches any value", () => {
    expect(matchesTags([{ key: "project" }], { project: "anything" })).toBe(true);
  });

  it("key-only rejects missing key", () => {
    expect(matchesTags([{ key: "project" }], { env: "prod" })).toBe(false);
  });

  it("AND semantics: all filters must match", () => {
    const filters = [
      { key: "project", value: "myapp" },
      { key: "env", value: "dev" },
    ];
    expect(matchesTags(filters, { project: "myapp", env: "dev" })).toBe(true);
    expect(matchesTags(filters, { project: "myapp" })).toBe(false);
    expect(matchesTags(filters, { project: "myapp", env: "prod" })).toBe(false);
  });

  it("returns false for undefined tags", () => {
    expect(matchesTags([{ key: "project" }], undefined)).toBe(false);
  });

  it("returns false for empty filters", () => {
    expect(matchesTags([], { project: "myapp" })).toBe(false);
  });
});

describe("formatTagFilters", () => {
  it("formats key=value filters", () => {
    expect(formatTagFilters([{ key: "project", value: "myapp" }])).toBe("project=myapp");
  });

  it("formats key-only filters", () => {
    expect(formatTagFilters([{ key: "project" }])).toBe("project");
  });

  it("formats multiple filters", () => {
    expect(formatTagFilters([
      { key: "project", value: "myapp" },
      { key: "env", value: "dev" },
    ])).toBe("project=myapp, env=dev");
  });
});
