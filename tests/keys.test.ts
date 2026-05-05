import { describe, it, expect, vi, beforeEach } from "vitest";
import { processInput, isPrefixPending, _resetKeyState } from "../src/keys.ts";

// Reset prefix state and any held tail bytes before each test
beforeEach(() => {
  _resetKeyState();
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

describe("prefix quit command", () => {
  it("q produces quit action", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dq"), write);
    expect(actions).toEqual([{ type: "quit" }]);
  });
});

describe("move command and position letters", () => {
  it("^] m produces movePane action and stays sticky", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dm"), write);
    expect(actions).toEqual([{ type: "movePane" }]);
    expect(isPrefixPending()).toBe(true);
  });

  it("^] a selects pane at position 10 (letter 'a')", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1da"), write);
    expect(actions).toEqual([{ type: "focusIndex", index: 9 }]);
  });

  it("^] m a produces movePane then focusIndex(9) (move to position 10)", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dma"), write);
    expect(actions).toEqual([
      { type: "movePane" },
      { type: "focusIndex", index: 9 },
    ]);
  });

  it("command letters (l, n, w, q, m) are NOT position keys", () => {
    const write = vi.fn();
    // 'l' is cycleLayout, not focusIndex
    const actions = processInput(Buffer.from("\x1dl"), write);
    expect(actions).toEqual([{ type: "cycleLayout" }]);
  });
});

describe("paste with embedded control chars", () => {
  it("Ctrl+] in middle of paste triggers prefix + forwards text around it", () => {
    const write = vi.fn();
    // `w` is non-sticky — after it runs as a command, remaining text
    // forwards. "hello\x1dworld" → "hello" fwd, ^]w=closePane, "orld" fwd.
    const actions = processInput(Buffer.from("hello\x1dworld"), write);
    expect(write).toHaveBeenCalledWith("hello");
    expect(actions).toEqual([{ type: "closePane" }]);
    expect(write).toHaveBeenCalledWith("orld");
  });

  it("Ctrl+\\ in middle of paste produces detach + forwards text around it", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("before\x1cafter"), write);
    expect(actions).toEqual([{ type: "detach" }]);
    expect(write).toHaveBeenCalledWith("before");
    expect(write).toHaveBeenCalledWith("after");
  });

  it("multiple control chars in a single buffer produce multiple actions", () => {
    const write = vi.fn();
    // `l` is sticky, so we don't need a second \x1d before `n`
    const actions = processInput(Buffer.from("\x1dln"), write);
    expect(actions).toEqual([
      { type: "cycleLayout" },
      { type: "newShell" },
    ]);
  });
});

describe("CSI u keybindings (kitty keyboard protocol)", () => {
  it("Ctrl+] via CSI u enters prefix mode", () => {
    const write = vi.fn();
    // CSI u: codepoint 93 (]), modifier 5 (Ctrl)
    const actions = processInput(Buffer.from("\x1b[93;5u"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(true);
  });

  it("Ctrl+\\ via CSI u produces detach action", () => {
    const write = vi.fn();
    // CSI u: codepoint 92 (\), modifier 5 (Ctrl)
    const actions = processInput(Buffer.from("\x1b[92;5u"), write);
    expect(actions).toEqual([{ type: "detach" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("Ctrl+] via CSI u cancels prefix when already in prefix mode", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[93;5u"), write); // enter prefix
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("\x1b[93;5u"), write); // cancel
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(false);
  });

  it("Ctrl+] via CSI u followed by command key works", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[93;5u"), write); // enter prefix
    expect(isPrefixPending()).toBe(true);

    const actions = processInput(Buffer.from("l"), write); // cycleLayout
    expect(actions).toEqual([{ type: "cycleLayout" }]);
  });

  it("CSI u with higher flags (e.g. 7) still detects Ctrl", () => {
    const write = vi.fn();
    // modifier 7 = Ctrl+Alt (bitmask: shift=0, alt=1, ctrl=1 → 1+2+4=7)
    const actions = processInput(Buffer.from("\x1b[93;7u"), write);
    expect(isPrefixPending()).toBe(true);
  });

  it("non-keybinding CSI u sequences are forwarded", () => {
    const write = vi.fn();
    // Ctrl+A (codepoint 97, modifier 5) — not our keybinding
    const actions = processInput(Buffer.from("\x1b[97;5u"), write);
    expect(actions).toEqual([]);
    expect(write).toHaveBeenCalled(); // forwarded
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
    // `w` (closePane) is non-sticky — prefix exits after command runs
    const actions = processInput(Buffer.from("\x1dw"), write);
    expect(actions).toEqual([{ type: "closePane" }]);
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
    // `w` is non-sticky — "more" forwards after closePane runs
    const actions = processInput(Buffer.from("\x1dwmore"), write);
    expect(actions).toEqual([{ type: "closePane" }]);
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
    // `w` (close pane) is non-sticky so it exits prefix
    const actions = processInput(Buffer.from("\x1d.,w"), write);
    expect(actions).toEqual([
      { type: "focusNext" },
      { type: "focusPrev" },
      { type: "closePane" },
    ]);
    expect(isPrefixPending()).toBe(false);
  });

  it("l stays in prefix mode (for rapid layout cycling)", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1dllll"), write);
    expect(actions).toEqual([
      { type: "cycleLayout" },
      { type: "cycleLayout" },
      { type: "cycleLayout" },
      { type: "cycleLayout" },
    ]);
    expect(isPrefixPending()).toBe(true);
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

    // '/' is neither a command nor a position key
    const actions = processInput(Buffer.from("/"), write);
    expect(actions).toEqual([]);
    expect(isPrefixPending()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("bracketed paste markers pass through unparsed (end in `~`, not u/M/m)", () => {
    const write = vi.fn();
    const paste = "\x1b[200~line1\nline2\nline3\x1b[201~";
    const actions = processInput(Buffer.from(paste), write);
    expect(actions).toEqual([]);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe(paste);
  });

  it("empty bracketed paste passes through intact", () => {
    const write = vi.fn();
    const paste = "\x1b[200~\x1b[201~";
    processInput(Buffer.from(paste), write);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe(paste);
  });

  it("large multi-line paste passes through with newlines intact", () => {
    const write = vi.fn();
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const paste = `\x1b[200~${content}\x1b[201~`;
    processInput(Buffer.from(paste), write);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe(paste);
    expect(forwarded).toContain("\n");
    expect(forwarded.split("\n").length).toBe(50);
  });

  it("paste with content containing tabs and special chars passes through", () => {
    const write = vi.fn();
    const paste = "\x1b[200~\tfn foo() {\n\treturn \"hi\";\n}\x1b[201~";
    processInput(Buffer.from(paste), write);
    expect(write.mock.calls.map(c => c[0]).join("")).toBe(paste);
  });

  it("paste arriving while prefix pending: dismisses modal AND forwards paste intact", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    // Paste arrives while the overlay is showing. Prefix should cancel
    // (overlay dismisses) but the paste markers + content must reach
    // the pane so the editor's bracketed-paste handler kicks in.
    const paste = "\x1b[200~pasted\x1b[201~";
    processInput(Buffer.from(paste), write);
    expect(isPrefixPending()).toBe(false);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe(paste);
  });

  it("arrow keys arriving while prefix pending: cancel prefix AND forward intact", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    // Up arrow is ESC[A — same shape as paste markers (CSI sequence).
    // Must flow through to the focused pane, not get beheaded.
    processInput(Buffer.from("\x1b[A"), write);
    expect(isPrefixPending()).toBe(false);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe("\x1b[A");
  });

  it("bare Esc cancels prefix without leaking to the pane", () => {
    // Regression: the original bug. User hits ^] to open the modal,
    // then hits Esc to dismiss — ESC must not leak as a keystroke to
    // the focused pane (which would cause e.g. vim to enter normal mode).
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);
    processInput(Buffer.from("\x1b"), write);
    expect(isPrefixPending()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("Esc followed by non-CSI byte: consumes Esc, forwards rest", () => {
    // Unusual but possible: user hits Esc then another key in quick
    // succession. The Esc cancels prefix; the trailing byte goes to
    // the pane as a normal character.
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    processInput(Buffer.from("\x1ba"), write);
    expect(isPrefixPending()).toBe(false);
    const forwarded = write.mock.calls.map(c => c[0]).join("");
    expect(forwarded).toBe("a");
  });

  it("kitty-encoded Esc (\\x1b[27u) cancels prefix without leaking to pane", () => {
    // When the focused pane has kitty keyboard active, pty-layout
    // proxies the flags to the outer terminal, which then sends Esc
    // as \x1b[27u instead of bare \x1b. The prefix-cancel path must
    // recognize this form — otherwise the 4-byte sequence leaks
    // through to the focused pane (which decodes it back to Esc and
    // e.g. cancels a claude prompt the user didn't want to cancel).
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    expect(isPrefixPending()).toBe(true);

    processInput(Buffer.from("\x1b[27u"), write);
    expect(isPrefixPending()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("kitty-encoded Esc with modifier (\\x1b[27;5u) also cancels without leaking", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1d"), write);
    processInput(Buffer.from("\x1b[27;5u"), write);
    expect(isPrefixPending()).toBe(false);
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

  it("shift+click sets shift:true on mouseDown", () => {
    const write = vi.fn();
    // Button 0 (left) + shift modifier (4) = 4
    const actions = processInput(Buffer.from("\x1b[<4;15;10M"), write);
    expect(actions).toEqual([{ type: "mouseDown", row: 10, col: 15, shift: true }]);
  });

  it("shift+drag sets shift:true on mouseDrag", () => {
    const write = vi.fn();
    // Left button (0) + motion (32) + shift (4) = 36
    const actions = processInput(Buffer.from("\x1b[<36;20;8M"), write);
    expect(actions).toEqual([{ type: "mouseDrag", row: 8, col: 20, shift: true }]);
  });

  it("non-shift click has no shift field (backward compat)", () => {
    const write = vi.fn();
    const actions = processInput(Buffer.from("\x1b[<0;5;5M"), write);
    // toEqual is strict — missing `shift` must stay missing, not false
    expect(actions).toEqual([{ type: "mouseDown", row: 5, col: 5 }]);
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

describe("legacy-mode pane translation", () => {
  describe("CSI u → legacy when pane has no kitty keyboard", () => {
    it("Ctrl+W (codepoint 119, mod 5) translates to 0x17", () => {
      const write = vi.fn();
      const actions = processInput(
        Buffer.from("\x1b[119;5u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(actions).toEqual([]);
      expect(write).toHaveBeenCalledWith("\x17");
    });

    it("Ctrl+A (codepoint 97, mod 5) translates to 0x01", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[97;5u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(write).toHaveBeenCalledWith("\x01");
    });

    it("Alt+F (codepoint 102, mod 3) translates to ESC + f", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[102;3u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(write).toHaveBeenCalledWith("\x1bf");
    });

    it("Ctrl+Alt+W (codepoint 119, mod 7) translates to ESC + 0x17", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[119;7u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(write).toHaveBeenCalledWith("\x1b\x17");
    });

    it("plain ASCII key with mod 1 (no mods) translates to the char", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[97;1u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(write).toHaveBeenCalledWith("a");
    });

    it("Ctrl+W passes through unchanged when pane HAS kitty keyboard", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[119;5u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: true },
      );
      expect(write).toHaveBeenCalledWith("\x1b[119;5u");
    });

    it("Ctrl+] still consumed as prefix even with kittyKeyboardActive false", () => {
      const write = vi.fn();
      const actions = processInput(
        Buffer.from("\x1b[93;5u"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      expect(actions).toEqual([]);
      expect(isPrefixPending()).toBe(true);
      expect(write).not.toHaveBeenCalled();
    });

    it("text around an unmapped CSI u sequence is still forwarded", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("ab\x1b[119;5ucd"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: false },
      );
      const calls = write.mock.calls.flat().join("");
      expect(calls).toBe("ab\x17cd");
    });

    it("default paneCaps preserves current passthrough behavior", () => {
      const write = vi.fn();
      processInput(Buffer.from("\x1b[119;5u"), write);
      expect(write).toHaveBeenCalledWith("\x1b[119;5u");
    });
  });

  describe("bracketed paste markers stripped when pane has no bracketed paste", () => {
    it("\\e[200~hello\\e[201~ becomes 'hello'", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[200~hello\x1b[201~"),
        write,
        { bracketedPaste: false, kittyKeyboardActive: true },
      );
      const calls = write.mock.calls.flat().join("");
      expect(calls).toBe("hello");
    });

    it("markers passthrough when pane HAS bracketed paste", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("\x1b[200~hello\x1b[201~"),
        write,
        { bracketedPaste: true, kittyKeyboardActive: true },
      );
      const calls = write.mock.calls.flat().join("");
      expect(calls).toBe("\x1b[200~hello\x1b[201~");
    });

    it("text before, between, and after markers all forwarded", () => {
      const write = vi.fn();
      processInput(
        Buffer.from("pre\x1b[200~mid\x1b[201~post"),
        write,
        { bracketedPaste: false, kittyKeyboardActive: true },
      );
      const calls = write.mock.calls.flat().join("");
      expect(calls).toBe("premidpost");
    });
  });
});

describe("legacy-mode pane translation — edge cases", () => {
  it("multiple CSI u sequences in a single buffer all translate", () => {
    const write = vi.fn();
    // Ctrl+A, Ctrl+E, Ctrl+W — common readline edits in a row.
    processInput(
      Buffer.from("\x1b[97;5u\x1b[101;5u\x1b[119;5u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    const calls = write.mock.calls.flat().join("");
    expect(calls).toBe("\x01\x05\x17");
  });

  it("CSI u between regular text segments", () => {
    const write = vi.fn();
    processInput(
      Buffer.from("hello\x1b[119;5uworld"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write.mock.calls.flat().join("")).toBe("hello\x17world");
  });

  it("paneCaps swap between calls — translation applies per-call", () => {
    const write = vi.fn();
    // Simulates a focus switch: first pane has kitty keyboard on, then
    // the user switches focus to a pane that doesn't.
    processInput(
      Buffer.from("\x1b[119;5u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: true },
    );
    processInput(
      Buffer.from("\x1b[119;5u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write.mock.calls.flat().join("")).toBe("\x1b[119;5u\x17");
  });

  it("unmatched bracketed-paste begin marker still strips the marker", () => {
    // We have no idea where the paste ends; stripping the open marker is
    // still better than leaking ESC garbage. Content trails as usual.
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b[200~hello"),
      write,
      { bracketedPaste: false, kittyKeyboardActive: true },
    );
    expect(write.mock.calls.flat().join("")).toBe("hello");
  });

  it("Ctrl+letter codepoint in uppercase (codepoint 87 = 'W') translates the same as lowercase", () => {
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b[87;5u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write).toHaveBeenCalledWith("\x17");
  });

  it("special-key CSI u (e.g. F5 with Ctrl) without legacy mapping passes through", () => {
    // F5 in CSI u is codepoint 57376 (0xE015 in kitty's PUA range).
    // No clean legacy mapping; should forward verbatim.
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b[57376;5u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write.mock.calls.flat().join("")).toBe("\x1b[57376;5u");
  });

  it("CSI u split across two buffer chunks", () => {
    // A real concern when the outer terminal generates CSI u and the
    // OS delivers it in two reads. Documents current behavior; if this
    // ever fails, processInput needs cross-call buffering.
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b[119;5"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    processInput(
      Buffer.from("u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write.mock.calls.flat().join("")).toBe("\x17");
  });

  it("bracketed-paste markers split across two buffer chunks", () => {
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b[20"),
      write,
      { bracketedPaste: false, kittyKeyboardActive: true },
    );
    processInput(
      Buffer.from("0~hello\x1b[201~"),
      write,
      { bracketedPaste: false, kittyKeyboardActive: true },
    );
    expect(write.mock.calls.flat().join("")).toBe("hello");
  });
});

describe("legacy-mode pane translation — state hygiene", () => {
  it("ESC alone is flushed, not held — menu dismissal stays instant", () => {
    const write = vi.fn();
    processInput(
      Buffer.from("\x1b"),
      write,
      { bracketedPaste: false, kittyKeyboardActive: false },
    );
    // Esc must reach the pane immediately so curses apps / shells can
    // dismiss menus / cancel modes — never hold a bare ESC waiting for
    // a follow-up that may never come.
    expect(write).toHaveBeenCalledWith("\x1b");
  });

  it("pendingTail is dropped by _resetKeyState (test isolation)", () => {
    const writeA = vi.fn();
    processInput(
      Buffer.from("\x1b[119;5"),
      writeA,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(writeA).not.toHaveBeenCalled();
    _resetKeyState();
    const writeB = vi.fn();
    processInput(
      Buffer.from("u"),
      writeB,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    // Without reset, B would have produced \x17. After reset, it's a
    // bare 'u' character — forwarded as-is, no translation.
    expect(writeB).toHaveBeenCalledWith("u");
  });

  it("non-ASCII unicode codepoint with no mods passes through", () => {
    const write = vi.fn();
    // U+00E9 = é (codepoint 233)
    processInput(
      Buffer.from("\x1b[233;1u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write).toHaveBeenCalledWith("é");
  });

  it("empty buffer is a no-op (no actions, no writes)", () => {
    const write = vi.fn();
    const actions = processInput(
      Buffer.from(""),
      write,
      { bracketedPaste: false, kittyKeyboardActive: false },
    );
    expect(actions).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("held tail is finally flushed when the follow-up bytes don't extend the sequence", () => {
    const write = vi.fn();
    // \e[ is held (could be CSI u start)
    processInput(
      Buffer.from("\x1b["),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write).not.toHaveBeenCalled();

    // Follow-up: 'A' is a CSI terminator but not 'u' — not CSI u at all
    // (it's an arrow key sequence). We should now flush the tail + 'A'
    // verbatim so the pane's app sees the complete escape.
    processInput(
      Buffer.from("A"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(write.mock.calls.flat().join("")).toBe("\x1b[A");
  });

  it("permissive default never holds — backward-compatible passthrough", () => {
    const write = vi.fn();
    // Same input as the held case above but with default (permissive) caps.
    processInput(Buffer.from("\x1b["), write);
    expect(write).toHaveBeenCalledWith("\x1b[");
  });
});

describe("prefix mode + kitty CSI u keys (legacy translation routes correctly)", () => {
  it("CSI u 'w' (codepoint 119, no mods) in prefix mode triggers closePane", () => {
    const write = vi.fn();
    // Enter prefix
    processInput(
      Buffer.from("\x1b[93;5u"), // Ctrl+] via CSI u
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(isPrefixPending()).toBe(true);

    // 'w' as a CSI u keypress (modifier 1 = no mods).
    const actions = processInput(
      Buffer.from("\x1b[119;1u"),
      write,
      { bracketedPaste: true, kittyKeyboardActive: false },
    );
    expect(actions).toEqual([{ type: "closePane" }]);
    expect(isPrefixPending()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("CSI u 'q' in prefix mode triggers quit", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[93;5u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    const actions = processInput(Buffer.from("\x1b[113;1u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    expect(actions).toEqual([{ type: "quit" }]);
  });

  it("CSI u position digit '1' in prefix mode focuses pane 1", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[93;5u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    // '1' = codepoint 49
    const actions = processInput(Buffer.from("\x1b[49;1u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    expect(actions).toEqual([{ type: "focusIndex", index: 0 }]);
  });

  it("CSI u sticky '.' (focusNext) in prefix mode keeps prefix active", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[93;5u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    // '.' = codepoint 46
    const actions = processInput(Buffer.from("\x1b[46;1u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    expect(actions).toEqual([{ type: "focusNext" }]);
    expect(isPrefixPending()).toBe(true);
  });

  it("CSI u Ctrl+A outside prefix mode translates to 0x01 (forwarded)", () => {
    const write = vi.fn();
    processInput(Buffer.from("\x1b[97;5u"), write, {
      bracketedPaste: true,
      kittyKeyboardActive: false,
    });
    expect(write).toHaveBeenCalledWith("\x01");
    expect(isPrefixPending()).toBe(false);
  });
});
