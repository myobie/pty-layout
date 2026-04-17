import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Session } from "@myobie/pty/testing";
import { spawnDaemon, listSessions } from "@myobie/pty/client";

const mainScript = path.resolve(import.meta.dirname, "../src/main.ts");

/** Hard cap on concurrent test sessions. If exceeded we still clean up,
 *  but fail loudly — it means a previous test leaked sessions. */
const MAX_TEST_SESSIONS = 50;

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

/** Kill every running session in the test PTY_SESSION_DIR. Non-optional:
 *  we never leave test daemons running. Tries SIGTERM first, waits up to
 *  5s for graceful exit, then escalates to SIGKILL. Polls until the dir
 *  is empty or the timeout is hit. Scoped to the test dir only because
 *  vitest.config.ts sets PTY_SESSION_DIR — listSessions() never sees
 *  the user's real sessions. */
async function killAllTestSessions(): Promise<void> {
  const runningCount = async () =>
    (await listSessions()).filter(s => s.status === "running" && s.pid).length;

  // Phase 1: SIGTERM
  let sessions = await listSessions();
  for (const s of sessions) {
    if (s.status === "running" && s.pid) {
      try { process.kill(s.pid, "SIGTERM"); } catch {}
    }
  }
  // Wait up to 5s for graceful shutdown
  const softDeadline = Date.now() + 5000;
  while (Date.now() < softDeadline) {
    if (await runningCount() === 0) return;
    await new Promise(r => setTimeout(r, 200));
  }

  // Phase 2: SIGKILL anything still alive
  sessions = await listSessions();
  for (const s of sessions) {
    if (s.status === "running" && s.pid) {
      try { process.kill(s.pid, "SIGKILL"); } catch {}
    }
  }
  // Wait up to 2s for SIGKILL to land
  const hardDeadline = Date.now() + 2000;
  while (Date.now() < hardDeadline) {
    if (await runningCount() === 0) return;
    await new Promise(r => setTimeout(r, 200));
  }

  // If we get here, something is genuinely stuck
  const stuck = await runningCount();
  throw new Error(
    `Test cleanup failed: ${stuck} session(s) survived SIGKILL in test PTY_SESSION_DIR. ` +
    `This is a bug — a child process is refusing to die.`,
  );
}

beforeEach(async () => {
  // Canary: if we're already over the cap, something leaked. Clean up
  // aggressively and fail this test so the leak gets noticed.
  const running = (await listSessions()).filter(s => s.status === "running");
  if (running.length >= MAX_TEST_SESSIONS) {
    const count = running.length;
    await killAllTestSessions();
    throw new Error(
      `Leak canary tripped: ${count} running sessions in test PTY_SESSION_DIR (>= ${MAX_TEST_SESSIONS}). ` +
      `Previous tests did not clean up. Sessions have been killed.`,
    );
  }
});

afterEach(async () => {
  if (session) {
    try { session.sendKeys("\x1dq"); } catch {} // ^] q to quit
    await new Promise((r) => setTimeout(r, 300));
    await session.close();
    await new Promise((r) => setTimeout(r, 500));
  }
});

// Belt-and-suspenders: even if a test throws, the file-level afterAll
// runs. Every session in the test PTY_SESSION_DIR dies when this file
// completes, pass or fail.
afterAll(async () => {
  await killAllTestSessions();
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

  it("typing while scrolled back snaps view to the live prompt", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise((r) => setTimeout(r, 500));

    // Produce enough output to fill the scrollback
    session.type("for i in $(seq 1 80); do echo SCROLL-LINE-$i; done\r");
    await session.waitForText("SCROLL-LINE-80", 10000);
    await new Promise((r) => setTimeout(r, 500));

    // Scroll up via mouse wheel over the pane area
    const scrollRow = 10;
    const scrollCol = 10;
    for (let i = 0; i < 20; i++) {
      // SGR wheel-up at (col, row)
      session.sendKeys(`\x1b[<64;${scrollCol};${scrollRow}M`);
    }
    await new Promise((r) => setTimeout(r, 300));

    // Type a distinctive marker — user should now see it (view snapped to bottom)
    session.type("echo POST-SCROLL-TYPING\r");
    await session.waitForText("POST-SCROLL-TYPING", 10000);
  }, 30000);
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
  it("^]l cycles grid -> stacked -> single -> grid by default (zoom excluded)", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("grid", 15000);

    // `l` is sticky — first press enters prefix AND cycles; subsequent
    // bare `l` presses continue cycling while prefix stays active.
    prefixKey("l");
    await session.waitForText("stacked", 5000);

    session.sendKeys("l");
    await session.waitForText("single", 5000);

    session.sendKeys("l");
    await session.waitForText("grid", 5000);

    // Cancel prefix when done
    session.sendKeys("\x1b");
  }, 20000);

  it("--layouts=+zoom adds zoom to the cycle", async () => {
    startApp(["--layouts=+zoom", "bash", "bash"]);
    await session.waitForText("grid", 15000);

    prefixKey("l");
    await session.waitForText("stacked", 5000);

    session.sendKeys("l");
    await session.waitForText("single", 5000);

    session.sendKeys("l");
    await session.waitForText("zoom", 5000);

    session.sendKeys("l");
    await session.waitForText("grid", 5000);

    session.sendKeys("\x1b");
  }, 20000);
});

describe("stacked layout", () => {
  it("shows all pane titles and expands the focused pane", async () => {
    startApp(["bash", "bash", "bash"]);
    await session.waitForText("1/3", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Switch to stacked: grid -> stacked (default cycle, zoom excluded)
    prefixKey("l");
    await session.waitForText("stacked", 5000);

    // All three pane titles should be visible as collapsed strips or
    // the focused box title. Position keys 1, 2, 3 should all appear.
    await new Promise(r => setTimeout(r, 300));
    const ss = session.screenshot();
    expect(ss.text).toContain("1:");
    expect(ss.text).toContain("2:");
    expect(ss.text).toContain("3:");
  }, 25000);

  it("switching focus changes which pane is expanded", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Type identifiable text into pane 1 so we can confirm it's expanded
    session.type("echo PANE1-CONTENT\r");
    await session.waitForText("PANE1-CONTENT", 5000);

    // Focus pane 2, type there
    prefixKey("2");
    await session.waitForText("2/2", 5000);
    session.type("echo PANE2-CONTENT\r");
    await session.waitForText("PANE2-CONTENT", 5000);

    // Switch to stacked mode (default cycle: grid -> stacked). `l` is
    // sticky so we cancel prefix with Esc afterwards.
    prefixKey("l");
    await session.waitForText("stacked", 5000);
    session.sendKeys("\x1b");
    await new Promise(r => setTimeout(r, 300));

    // Pane 2 is focused: its content must be visible
    let ss = session.screenshot();
    expect(ss.text).toContain("PANE2-CONTENT");

    // Focus pane 1: its content becomes visible
    prefixKey("1");
    await session.waitForText("1/2", 5000);
    await new Promise(r => setTimeout(r, 300));
    ss = session.screenshot();
    expect(ss.text).toContain("PANE1-CONTENT");
  }, 30000);
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

    // Cycle to single: grid -> stacked -> single (default cycle).
    // `l` is sticky — second press is bare `l` (prefix still active).
    prefixKey("l");
    await session.waitForText("stacked", 5000);
    session.sendKeys("l");
    await session.waitForText("single", 5000);
    session.sendKeys("\x1b"); // cancel prefix

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

describe("move pane", () => {
  it("^] m 3 moves the focused pane to position 3", async () => {
    startApp(["bash", "bash", "bash"]);
    await session.waitForText("1/3", 15000);
    await new Promise((r) => setTimeout(r, 300));

    // Type unique text in pane 1 to identify it later
    session.type("echo FIRST-PANE\r");
    await session.waitForText("FIRST-PANE", 5000);

    // Move pane 1 (currently at position 1) to position 3
    prefixKey("m");
    await new Promise((r) => setTimeout(r, 100));
    session.sendKeys("3");
    await new Promise((r) => setTimeout(r, 300));

    const ss = session.screenshot();
    // Pane 3 should now be titled with FIRST-PANE's content (our moved pane)
    // and the focused pane indicator should be at 3/3
    expect(ss.text).toContain("3/3");
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

  it("^] from empty state shows the prefix help overlay", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);

    // Close picker → empty state
    session.sendKeys("\x1b");
    await session.waitForText("^] n to open session picker", 5000);

    // Ctrl+] alone should show the help overlay
    session.sendKeys("\x1d");
    await session.waitForText("prev pane", 5000);
  }, 20000);

  it("^\\ from empty state quits the app", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);

    // Close picker → empty state with no panes
    session.sendKeys("\x1b");
    await session.waitForText("^] n to open session picker", 5000);

    // Ctrl+\ should quit (nothing to detach from)
    session.sendKeys("\x1c");
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

describe("tmux shim mode", () => {
  const uniqueTag = () => `tmux-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  afterEach(async () => {
    // Kill all daemon sessions in the test PTY_SESSION_DIR left by the shim
    await killAllTestSessions();
    await new Promise(r => setTimeout(r, 300));
  });

  /** Open picker, select "+ New session", wait for pane to appear in tag mode. */
  async function spawnShellViaPickerAndWait(tag: string) {
    startApp(["--tmux", "--tag", `team=${tag}`]);
    await session.waitForText("Watching for sessions tagged", 15000);
    prefixKey("n");
    await session.waitForText("Sessions", 5000);
    session.sendKeys("\r");
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 1000));
  }

  it("--tmux sets TMUX, PTY_LAYOUT_FILTER_TAG, and bash tmux function", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    session.type("echo TMUX_VAL=$TMUX\r");
    await session.waitForText("TMUX_VAL=pty-layout", 5000);

    session.type("echo FILTER_TAG=$PTY_LAYOUT_FILTER_TAG\r");
    await session.waitForText(`FILTER_TAG=team=${tag}`, 5000);

    // bash function should override PATH
    session.type("type tmux\r");
    await session.waitForText("function", 5000);

    session.type("declare -f tmux\r");
    await session.waitForText("/shim/tmux", 5000);
  }, 40000);

  it("without --tmux, TMUX is not set to pty-layout", async () => {
    const tag = uniqueTag();
    startApp(["--tag", `team=${tag}`]);
    await session.waitForText("Watching for sessions tagged", 15000);

    prefixKey("n");
    await session.waitForText("Sessions", 5000);
    session.sendKeys("\r");
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    session.type("echo TMUX_CHECK=${TMUX:-unset}\r");
    await session.waitForText("TMUX_CHECK=unset", 5000);
  }, 30000);

  it("tmux split-window spawns a new pane visible in the layout", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    session.type("tmux split-window -- bash -c 'echo SHIM_SPLIT_OK; sleep 10'\r");
    // The new session gets the same tag → TagSubscription picks it up → pane 2 appears
    await session.waitFor(
      (ss) => ss.text.includes("SHIM_SPLIT_OK") || ss.text.match(/\d\/2/) !== null,
      15000,
      "second pane or SHIM_SPLIT_OK",
    );
  }, 40000);

  it("tmux split-window -P prints the pane id and send-keys delivers to it", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    // -P prints %<session-id> to stdout
    session.type("PANE_ID=$(tmux split-window -P -- bash -c 'sleep 10') && echo GOT_ID=$PANE_ID\r");
    await session.waitForText("GOT_ID=%", 15000);

    // Wait for pane 2 to appear
    await session.waitFor(
      (ss) => ss.text.match(/\d\/2/) !== null,
      10000,
      "2-pane status",
    );
    await new Promise(r => setTimeout(r, 1000));

    // Send keys to the second pane
    session.type("tmux send-keys -t $PANE_ID 'echo REMOTE_MSG' Enter\r");
    await session.waitForText("REMOTE_MSG", 10000);
  }, 50000);

  it("tmux list-panes lists running sessions with matching tags", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    session.type("tmux split-window -- bash -c 'echo PANE2_UP; sleep 10'\r");
    await session.waitFor(
      (ss) => ss.text.includes("PANE2_UP") || ss.text.match(/\d\/2/) !== null,
      15000,
      "second pane visible",
    );
    await new Promise(r => setTimeout(r, 1000));

    // Focus pane 1 where we can type the list command
    prefixKey("1");
    await new Promise(r => setTimeout(r, 300));
    session.type("tmux list-panes\r");
    await session.waitFor(
      (ss) => {
        const matches = ss.text.match(/%[a-z0-9]{8}/g);
        return matches !== null && matches.length >= 2;
      },
      10000,
      "at least 2 pane ids in list-panes output",
    );
  }, 50000);

  it("tmux kill-pane removes a session from the layout", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    session.type("PANE_ID=$(tmux split-window -P -- bash -c 'sleep 10') && echo KILL_TARGET=$PANE_ID\r");
    await session.waitForText("KILL_TARGET=%", 15000);
    await session.waitFor(
      (ss) => ss.text.match(/\d\/2/) !== null,
      10000,
      "2-pane status",
    );
    await new Promise(r => setTimeout(r, 1000));

    session.type("tmux kill-pane -t $PANE_ID\r");
    await session.waitForText("1/1", 15000);
  }, 50000);

  it("tmux display-message and has-session work", async () => {
    const tag = uniqueTag();
    await spawnShellViaPickerAndWait(tag);

    // display-message -p prints the pane id
    session.type("tmux display-message -p '#{pane_id}'\r");
    await session.waitFor(
      (ss) => ss.text.match(/%[a-z0-9]/) !== null,
      5000,
      "pane id from display-message",
    );

    // has-session returns 0
    session.type("tmux has-session && echo HAS_OK\r");
    await session.waitForText("HAS_OK", 5000);
  }, 30000);
});
