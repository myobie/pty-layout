import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Session } from "@myobie/pty/testing";
import { spawnDaemon } from "@myobie/pty/client";

const mainScript = path.resolve(import.meta.dirname, "../src/main.ts");

let session: Session;

function startApp(
  args: string[] = [],
  opts: { rows?: number; cols?: number; env?: Record<string, string> } = {},
): Session {
  session = Session.spawn(
    "node",
    ["--experimental-strip-types", "--no-warnings", mainScript, ...args],
    {
      rows: opts.rows ?? 30,
      cols: opts.cols ?? 100,
      env: { TERM: "xterm-256color", ...(opts.env ?? {}) },
    },
  );
  return session;
}

afterEach(async () => {
  if (session) {
    try { session.sendKeys("\x1dq"); } catch {} // ^] q to quit
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
  it("starts with session picker when no args given", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain("+ New session");
    expect(ss.text).toContain("Local");
    expect(ss.text).toContain("^]");
    expect(ss.text).toContain("detach");
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
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
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

describe("detach and quit", () => {
  it("Ctrl+\\ detaches the focused pane", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    session.sendKeys("\x1c");
    await session.waitForText("1/1", 5000);
  }, 20000);

  it("Ctrl+\\ on last pane reopens the session picker", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    session.sendKeys("\x1c");
    // Last pane detached — picker should reopen (explicit quit is ^] q)
    await session.waitForText("Sessions", 5000);
  }, 20000);

  it("^]q quits the layout", async () => {
    startApp(["bash"]);
    await session.waitForText("^]", 15000);
    prefixKey("q");
    await session.waitForAbsent("^]", 5000);
  }, 20000);

  it("child exit removes the pane", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    await new Promise((r) => setTimeout(r, 300));
    session.type("exit\r");
    // Focused pane exits, layout drops to 1/1
    await session.waitForText("1/1", 10000);
  }, 20000);

  it("last pane exit reopens session picker (does not quit app)", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise((r) => setTimeout(r, 300));
    session.type("exit\r");
    // Instead of the app quitting, the picker should come back
    await session.waitForText("Sessions", 10000);
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
    expect(ss.text).toContain("sessions");
    expect(ss.text).toContain("close pane");

    session.sendKeys("\x1b");
    await session.waitForAbsent("prev pane", 5000);
  }, 20000);
});

describe("tag subscription mode", () => {
  it("shows empty state when no matching sessions exist", async () => {
    startApp(["--tag", "project=test-empty"]);
    await session.waitForText("Watching for sessions tagged", 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain("project=test-empty");
  }, 20000);

  it("discovers an existing tagged session on startup", async () => {
    const name = `tag-test-${Date.now()}`;
    await spawnDaemon({ name, command: "bash", args: [], displayCommand: "bash", tags: { project: "tag-disco" } });
    await new Promise(r => setTimeout(r, 500)); // wait for socket to be ready

    startApp(["--tag", "project=tag-disco"]);
    await session.waitForText(name, 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain(name);
  }, 20000);

  it("combines --tag with explicit pane specs", async () => {
    startApp(["--tag", "project=tag-combo", "bash"]);
    // Should show the bash pane immediately (from the explicit spec)
    await session.waitForText("1/1", 15000);
    // And be watching for tagged sessions (won't exit when bash exits)
  }, 20000);
});

describe("stats logging", () => {
  it("writes launched and sample events to stats.jsonl", async () => {
    const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "pty-layout-stats-int-"));
    try {
      startApp(["bash"], { env: { XDG_STATE_HOME: tempState } });
      await session.waitForText("1/1", 15000);
      // Give it a moment to write the initial events
      await new Promise((r) => setTimeout(r, 500));

      const statsFile = path.join(tempState, "pty-layout", "stats.jsonl");
      expect(fs.existsSync(statsFile)).toBe(true);

      const events = fs.readFileSync(statsFile, "utf8")
        .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

      const launched = events.find((e) => e.type === "launched");
      expect(launched).toBeDefined();
      expect(launched.pid).toBeGreaterThan(0);
      expect(launched.id).toMatch(/^[0-9a-f-]{36}$/);

      const sample = events.find((e) => e.type === "sample");
      expect(sample).toBeDefined();
      expect(sample.rss).toBeGreaterThan(0);
      expect(sample.panes).toBe(1);
    } finally {
      fs.rmSync(tempState, { recursive: true, force: true });
    }
  }, 20000);
});

describe("session picker", () => {
  it("Esc on startup picker closes it and shows the empty-state hint", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);

    // Esc closes the picker but the app stays alive — explicit quit is ^] q
    session.sendKeys("\x1b");
    await session.waitForText("^] n to open session picker", 5000);

    // ^] q actually quits
    session.sendKeys("\x1dq");
    await session.waitForAbsent("^] n to open", 5000);
  }, 20000);

  it("Enter with empty filter result does not crash", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);

    prefixKey("n");
    await session.waitForText("Sessions", 5000);

    // Type a filter that matches nothing
    session.type("zzznotarealsessionname");
    await new Promise((r) => setTimeout(r, 300));

    // Press Enter — should do nothing (no item to select)
    session.sendKeys("\r");
    await new Promise((r) => setTimeout(r, 300));

    // Picker should still be visible
    const ss = session.screenshot();
    expect(ss.text).toContain("Sessions");

    // Esc closes it
    session.sendKeys("\x1b");
    await session.waitForAbsent("Sessions", 5000);
  }, 20000);

  it("picking an existing daemon session attaches and shows the pane", async () => {
    // Spawn a daemon session directly, then pick it from the picker
    const name = `pick-target-${Date.now()}`;
    await spawnDaemon({ name, command: "bash", args: [], displayCommand: "bash" });
    await new Promise((r) => setTimeout(r, 500));

    startApp();
    await session.waitForText("Sessions", 15000);
    // Filter to just our target and press Enter
    session.type(name);
    await new Promise((r) => setTimeout(r, 300));
    session.sendKeys("\r");

    // Pane should appear with count 1/1 — app should NOT exit
    await session.waitForText("1/1", 10000);
    const ss = session.screenshot();
    expect(ss.text).toContain(name);
  }, 20000);

  it("^]n opens session picker overlay", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);

    prefixKey("n");
    await session.waitForText("Sessions", 5000);

    const ss = session.screenshot();
    expect(ss.text).toContain("Local");
    expect(ss.text).toContain("+ New session");
    expect(ss.text).toContain("select");

    // Esc closes picker
    session.sendKeys("\x1b");
    await session.waitForAbsent("Sessions", 5000);
  }, 20000);
});

describe("text selection", () => {
  it("click-drag highlights text and click clears it", async () => {
    startApp(["bash"]);
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
