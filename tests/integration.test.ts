import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { Session } from "@myobie/pty/testing";

const mainScript = path.resolve(import.meta.dirname, "../src/main.ts");

let session: Session;

function startApp(
  args: string[] = [],
  opts: { rows?: number; cols?: number } = {},
): Session {
  session = Session.spawn(
    "node",
    ["--experimental-strip-types", "--no-warnings", mainScript, ...args],
    {
      rows: opts.rows ?? 30,
      cols: opts.cols ?? 100,
      env: { TERM: "xterm-256color" },
    },
  );
  return session;
}

afterEach(async () => {
  if (session) {
    try { session.sendKeys("\x1c"); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    await session.close();
    await new Promise((r) => setTimeout(r, 500));
  }
});

/** Send Ctrl+] prefix key followed by a command character */
function prefixKey(ch: string) {
  session.sendKeys(`\x1d${ch}`);
}

describe("startup and status bar", () => {
  it("starts with grid mode, shows borders, status bar, and pane title", async () => {
    startApp();
    await session.waitForText("grid", 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain("^]");
    expect(ss.text).toContain("detach");
    expect(ss.text).toContain("╭");
    expect(ss.text).toContain("╰");
    expect(ss.text).toContain("1:");
    expect(ss.text).toContain("1/1");
  }, 20000);

  it("starts with two panes and shows both", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    const ss = session.screenshot();
    expect(ss.text).toMatch(/\d\/2/);
    expect(ss.text).toContain("1:");
    expect(ss.text).toContain("2:");
  }, 20000);
});

describe("border colors", () => {
  it("focused pane has green border, unfocused has grey", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1:", 15000);
    const ss = session.screenshot();
    expect(ss.ansi).toContain("38;2;80;200;120");
    expect(ss.ansi).toContain("38;2;100;100;100");
  }, 20000);
});

describe("input routing", () => {
  it("forwards keystrokes to the focused pane", async () => {
    startApp();
    await session.waitForText("1:", 15000);
    await new Promise((r) => setTimeout(r, 500));
    session.type("echo test-input-routing\r");
    await session.waitForText("test-input-routing", 10000);
  }, 20000);
});

describe("pane management", () => {
  it("^]w closes the focused pane", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    prefixKey("w");
    await session.waitForText("1/1", 10000);
  }, 20000);

  it("exited pane is removed promptly without eating input", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Focus pane 2, then exit it
    prefixKey("2");
    await session.waitForText("2/2", 5000);
    session.type("exit\r");
    await session.waitForText("1/1", 3000);

    // Keystrokes should route to the remaining pane, not be eaten
    session.type("echo still-alive\r");
    await session.waitForText("still-alive", 5000);
  }, 20000);
});

describe("layout cycling", () => {
  it("^]l cycles grid -> zoom -> single -> grid", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("grid", 15000);

    prefixKey("l");
    await session.waitForText("zoom", 5000);

    prefixKey("l");
    await session.waitForText("single", 5000);
    const ss = session.screenshot();
    expect(ss.text).toContain("1:");

    prefixKey("l");
    await session.waitForText("grid", 5000);
  }, 20000);
});

describe("focus navigation", () => {
  it("^]1..9, ^],/. navigate between panes", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);

    prefixKey("2");
    await session.waitForText("2/2", 5000);

    prefixKey("1");
    await session.waitForText("1/2", 5000);

    // ^]. cycles forward (sticky: stays in prefix)
    prefixKey(".");
    await session.waitForText("2/2", 5000);

    // Already in prefix from sticky ., send , directly to cycle back
    session.sendKeys(",");
    await session.waitForText("1/2", 5000);

    session.sendKeys("\x1b");
  }, 20000);
});

describe("single mode", () => {
  it("shows focused pane and can cycle through panes", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);

    // Type identifiable content into pane 1
    await new Promise(r => setTimeout(r, 300));
    session.type("echo alpha-content\r");
    await session.waitForText("alpha-content", 5000);

    // Switch to pane 2 and type content
    prefixKey("2");
    await session.waitForText("2/2", 5000);
    session.type("echo beta-content\r");
    await session.waitForText("beta-content", 5000);

    // Cycle to single: grid -> zoom -> single
    prefixKey("l");
    await session.waitForText("zoom", 5000);
    prefixKey("l");
    await session.waitForText("single", 5000);

    // Should show pane 2 (still focused)
    let ss = session.screenshot();
    expect(ss.text).toContain("beta-content");
    expect(ss.text).toContain("2:");

    // Focus first pane in single mode
    prefixKey("1");
    await session.waitForText("1/2", 5000);
    ss = session.screenshot();
    expect(ss.text).toContain("alpha-content");
    expect(ss.text).toContain("1:");
  }, 30000);
});

describe("detach", () => {
  it("Ctrl+\\ detaches from the layout", async () => {
    startApp();
    await session.waitForText("^]", 15000);
    session.sendKeys("\x1c");
    await session.waitForAbsent("^]", 5000);
  }, 20000);
});

describe("multi-pane rendering", () => {
  it("four panes all visible in grid", async () => {
    startApp(["bash", "bash", "bash", "bash"]);
    await session.waitForText("1/4", 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain("1:");
    expect(ss.text).toContain("2:");
    expect(ss.text).toContain("3:");
    expect(ss.text).toContain("4:");
    expect(ss.text).toMatch(/\d\/4/);
  }, 20000);
});

describe("prefix overlay", () => {
  it("shows command help when Ctrl+] is pressed", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("grid", 15000);

    session.sendKeys("\x1d");
    await session.waitForText("prev pane", 5000);

    const ss = session.screenshot();
    expect(ss.text).toContain("next pane");
    expect(ss.text).toContain("layout");
    expect(ss.text).toContain("new shell");
    expect(ss.text).toContain("close pane");
    expect(ss.text).toContain("cancel");

    session.sendKeys("\x1b");
    await session.waitForAbsent("prev pane", 5000);
  }, 20000);
});

describe("text selection", () => {
  it("click-drag highlights text and click clears it", async () => {
    startApp();
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Type identifiable text
    session.type("echo SELECTME\r");
    await session.waitForText("SELECTME", 5000);

    // Get the screenshot before selection to find the text position
    const before = session.screenshot();
    expect(before.text).toContain("SELECTME");

    // Find approximate row/col of "SELECTME" in screen coords
    // The pane inner area starts at row 2, col 2 (1-indexed, after border)
    // Send SGR mouse events: click at start of text area, drag across
    const startCol = 3; // inside pane
    const startRow = 3; // a few rows down (prompt + echo output)

    // mouseDown
    session.sendKeys(`\x1b[<0;${startCol};${startRow}M`);
    // mouseDrag across several columns
    session.sendKeys(`\x1b[<32;${startCol + 10};${startRow}M`);
    // mouseUp
    session.sendKeys(`\x1b[<0;${startCol + 10};${startRow}m`);

    await new Promise(r => setTimeout(r, 200));
    const after = session.screenshot();

    // The selection should cause inverted colors — check that the ANSI
    // output changed (contains background color sequences that weren't there before)
    // With selection, we swap fg/bg, so we should see 48;2 (bg) sequences
    // for colors that were previously only in fg
    expect(after.ansi).toContain("48;2;");

    // Click to clear selection
    session.sendKeys(`\x1b[<0;${startCol};${startRow}M`);
    session.sendKeys(`\x1b[<0;${startCol};${startRow}m`);
    await new Promise(r => setTimeout(r, 200));
  }, 20000);
});
