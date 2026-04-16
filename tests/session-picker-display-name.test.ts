import { describe, it, expect } from "vitest";
import {
  formatSessionLabel,
  randomSessionId,
  buildRemoteConnectUrl,
} from "../src/session-picker.ts";

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

describe("buildRemoteConnectUrl", () => {
  it("inserts session name before the fragment", () => {
    expect(buildRemoteConnectUrl("wss://host/ws#pubkey.secret", "my-session"))
      .toBe("wss://host/ws/my-session#pubkey.secret");
  });

  it("inserts session name before the fragment even with query params", () => {
    expect(buildRemoteConnectUrl("wss://host/ws?p=1#abc.def", "s1"))
      .toBe("wss://host/ws?p=1/s1#abc.def");
  });

  it("appends to the end when there is no fragment", () => {
    expect(buildRemoteConnectUrl("wss://host/ws", "s1"))
      .toBe("wss://host/ws/s1");
  });

  it("preserves multi-# fragments (takes everything after first #)", () => {
    expect(buildRemoteConnectUrl("wss://host/ws#a#b", "s1"))
      .toBe("wss://host/ws/s1#a#b");
  });
});
