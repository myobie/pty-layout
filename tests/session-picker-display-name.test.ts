import { describe, it, expect } from "vitest";
import { formatSessionLabel, randomSessionId } from "../src/session-picker.ts";

describe("formatSessionLabel", () => {
  it("returns name when displayName is missing", () => {
    expect(formatSessionLabel("abc123xy")).toBe("abc123xy");
  });

  it("returns name when displayName is empty", () => {
    expect(formatSessionLabel("abc123xy", "")).toBe("abc123xy");
  });

  it("returns name when displayName equals name", () => {
    expect(formatSessionLabel("abc123xy", "abc123xy")).toBe("abc123xy");
  });

  it("shows 'displayName (name)' when both are set and differ", () => {
    expect(formatSessionLabel("abc123xy", "my-server")).toBe("my-server (abc123xy)");
  });
});

describe("randomSessionId", () => {
  it("returns an 8-char lowercase alphanumeric string", () => {
    for (let i = 0; i < 20; i++) {
      const id = randomSessionId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it("produces different ids across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(randomSessionId());
    // With 36^8 possible ids, 50 samples should always be unique
    expect(ids.size).toBe(50);
  });
});
