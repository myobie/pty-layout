import { describe, it, expect, vi, beforeEach } from "vitest";
import { processInput, isPrefixPending } from "../src/keys.ts";

// Reset prefix state before each test
beforeEach(() => {
  while (isPrefixPending()) {
    processInput(Buffer.from("\x1b"), () => {});
  }
});

describe("regular input forwarding", () => {
  it("forwards plain text to writer", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("hello"), write);
    expect(actions).toEqual([]);
    expect(write).toHaveBeenCalledWith("hello");
  });

  it("forwards escape sequences to writer", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[A"), write);
    expect(actions).toEqual([]);
    expect(write).toHaveBeenCalledWith("\x1b[A");
  });
});

describe("Ctrl+\\ detach", () => {
  it("produces detach action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1c"), write);
    expect(actions).toEqual([{ type: "detach" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("forwards bytes before and after detach", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("ab\x1ccd"), write);
    expect(actions).toEqual([{ type: "detach" }]);
    expect(write).toHaveBeenCalledWith("ab");
    expect(write).toHaveBeenCalledWith("cd");
  });
});

describe("Ctrl+] prefix key", () => {
  it("enters prefix mode when alone in buffer", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1d"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("executes command when key follows in same buffer", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dl"), write);
    expect(actions).toEqual([{ type: "cycleLayout" }]);
    expect(isPrefixPending()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("executes command from next buffer (cross-buffer)", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("n"), write);
    expect(actions).toEqual([{ type: "newShell" }]);
    expect(isPrefixPending()).toBe(false);
  });

  it("forwards text before prefix key", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("hello\x1dl"), write);
    expect(actions).toEqual([{ type: "cycleLayout" }]);
    expect(write).toHaveBeenCalledWith("hello");
  });

  it("forwards text after non-sticky command", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dlmore"), write);
    expect(actions).toEqual([{ type: "cycleLayout" }]);
    expect(write).toHaveBeenCalledWith("more");
  });
});

describe("prefix sticky keys", () => {
  it(", stays in prefix mode", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1d,"), write);
    expect(actions).toEqual([{ type: "focusPrev" }]);
    expect(isPrefixPending()).toBe(true);
  });

  it(". stays in prefix mode", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1d."), write);
    expect(actions).toEqual([{ type: "focusNext" }]);
    expect(isPrefixPending()).toBe(true);
  });

  it("repeated sticky keys produce multiple actions", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1d..."), write);
    expect(actions).toEqual([
      { type: "focusNext" },
      { type: "focusNext" },
      { type: "focusNext" },
    ]);
    expect(isPrefixPending()).toBe(true);
  });

  it("sticky then non-sticky exits prefix", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1d.,l"), write);
    expect(actions).toEqual([
      { type: "focusNext" },
      { type: "focusPrev" },
      { type: "cycleLayout" },
    ]);
    expect(isPrefixPending()).toBe(false);
  });

  it("cross-buffer sticky keys work", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    let actions = processInput(Buffer.from("."), write);
    expect(actions).toEqual([{ type: "focusNext" }]);
    expect(isPrefixPending()).toBe(true);

    actions = processInput(Buffer.from(","), write);
    expect(actions).toEqual([{ type: "focusPrev" }]);
    expect(isPrefixPending()).toBe(true);

    actions = processInput(Buffer.from("w"), write);
    expect(actions).toEqual([{ type: "closePane" }]);
    expect(isPrefixPending()).toBe(false);
  });
});

describe("prefix cancellation", () => {
  it("Escape cancels prefix (bare ESC)", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("\x1b"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(false);
  });

  it("Ctrl+] again cancels prefix", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("\x1d"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(false);
  });

  it("unrecognized key during prefix is consumed and exits", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("z"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(false);
    // The 'z' should be consumed, not forwarded
    expect(write).not.toHaveBeenCalled();
  });
});

describe("prefix command map", () => {
  const commands: [string, string, number?][] = [
    ["l", "cycleLayout"],
    ["n", "newShell"],
    ["w", "closePane"],
    [",", "focusPrev"],
    [".", "focusNext"],
    ["1", "focusIndex", 0],
    ["5", "focusIndex", 4],
    ["9", "focusIndex", 8],
  ];

  for (const [key, type, index] of commands) {
    it(`${key} → ${type}`, () => {
      const write = vi.fn();
      const actions = processInput(Buffer.from(`\x1d${key}`), write);
      const expected: any = { type };
      if (index !== undefined) expected.index = index;
      expect(actions).toEqual([expected]);
    });
  }
});

describe("SGR mouse events", () => {
  it("left click produces mouseDown action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[<0;15;10M"), write);
    expect(actions).toEqual([{ type: "mouseDown", row: 10, col: 15 }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("left click release produces mouseUp action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[<0;15;10m"), write);
    expect(actions).toEqual([{ type: "mouseUp", row: 10, col: 15 }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("left button drag produces mouseDrag action", () => {
    const write = vi.fn();
    // Button 32 = left button (0) + motion flag (32)
    const actions = processInput(Buffer.from("\x1b[<32;20;8M"), write);
    expect(actions).toEqual([{ type: "mouseDrag", row: 8, col: 20 }]);
  });

  it("drag + release sequence produces both actions", () => {
    const write = vi.fn();
    const actions = processInput(
      Buffer.from("\x1b[<0;5;3M\x1b[<32;10;3M\x1b[<32;15;3M\x1b[<0;15;3m"),
      write,
    );
    expect(actions).toEqual([
      { type: "mouseDown", row: 3, col: 5 },
      { type: "mouseDrag", row: 3, col: 10 },
      { type: "mouseDrag", row: 3, col: 15 },
      { type: "mouseUp", row: 3, col: 15 },
    ]);
  });

  it("scroll up produces scrollUp action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[<64;5;3M"), write);
    expect(actions).toEqual([{ type: "scrollUp", row: 3, col: 5 }]);
  });

  it("scroll down produces scrollDown action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[<65;5;3M"), write);
    expect(actions).toEqual([{ type: "scrollDown", row: 3, col: 5 }]);
  });

  it("middle and right clicks are ignored", () => {
    const write = vi.fn();
    let actions = processInput(Buffer.from("\x1b[<1;5;3M"), write);
    expect(actions).toEqual([]);
    actions = processInput(Buffer.from("\x1b[<2;5;3M"), write);
    expect(actions).toEqual([]);
  });

  it("mouse event during prefix cancels prefix", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("\x1b[<0;10;5M"), write);
    expect(actions).toEqual([{ type: "mouseDown", row: 5, col: 10 }]);
    expect(isPrefixPending()).toBe(false);
  });

  it("mouse events mixed with regular input", () => {
    const write = vi.fn();
    const actions = processInput(
      Buffer.from("ab\x1b[<0;1;1Mcd"),
      write,
    );
    expect(actions).toEqual([{ type: "mouseDown", row: 1, col: 1 }]);
    expect(write).toHaveBeenCalledWith("ab");
    expect(write).toHaveBeenCalledWith("cd");
  });

  it("incomplete SGR sequence is forwarded as-is", () => {
    const write = vi.fn();
    // Missing terminator
    const actions = processInput(Buffer.from("\x1b[<0;5;3"), write);
    expect(actions).toEqual([]);
    // Should be forwarded (not consumed)
    expect(write).toHaveBeenCalled();
  });
});
