import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Session } from "@myobie/pty/testing";
import { spawnDaemon, listSessions, setDisplayName } from "@myobie/pty/client";

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
  // Kill any daemon sessions left behind. The new always-tag
  // architecture spawns daemons for every pane (local panes don't
  // exist any more), so every test leaks 1-2+ sessions unless we
  // actively clean them up. Scoped to PTY_SESSION_DIR so we can't
  // touch the user's real sessions.
  await killAllTestSessions();
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
    // Wait for both panes to attach (subscription fires async now)
    await session.waitForText("1/2", 15000);
    const ss = session.screenshot();
    expect(ss.ansi).toContain("38;2;80;200;120");
    expect(ss.ansi).toContain("38;2;100;100;100");
  }, 20000);
});

describe("palette color preservation", () => {
  it("SGR 34 round-trips as palette blue, not VGA truecolor", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise((r) => setTimeout(r, 500));

    // Emit palette blue. Wait directly on the SGR 34 byte sequence
    // appearing in the screen ANSI — this only happens after printf
    // actually executes (waiting on text like "BLUE" or any string in
    // the typed command would match the readline echo before the
    // command runs). If pty-layout preserves the index through the
    // cell pipeline, the outer terminal sees SGR 34 and picks its own
    // theme blue. If it flattens to the VGA RGB, we'd see
    // "38;2;0;0;204" — overriding the theme.
    session.type("printf '\\033[34mBLUETEXT\\033[0m\\n'\r");
    const ss = await session.waitFor(
      (s) => s.ansi.includes("\x1b[34m"),
      10000,
      "SGR 34 reaches the outer terminal",
    );
    expect(ss.ansi).not.toMatch(/38;2;0;0;204/);
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

  it("strips bracketed-paste markers when the pane program doesn't speak them", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise((r) => setTimeout(r, 500));

    // Run a primitive line reader that doesn't go through readline.
    // bash's `read` builtin reads raw bytes — perfect repro of the
    // user's gets()-using CLI.
    session.type("read -r LINE && printf 'GOT=[%s]\\n' \"$LINE\"\r");
    await new Promise((r) => setTimeout(r, 300));

    // Simulate an outer-terminal bracketed paste of "hello world".
    session.sendKeys("\x1b[200~hello world\x1b[201~");
    session.sendKeys("\r");

    // With the fix, `read` captures plain "hello world".
    // Without the fix, it captures the literal markers too and we'd see
    // ESC chars or the literal "[200~" / "[201~" in the output.
    await session.waitFor(
      (s) => s.text.includes("GOT=[hello world]"),
      10000,
      "read captures the paste content with markers stripped",
    );
    const ss = session.screenshot();
    expect(ss.text).toContain("GOT=[hello world]");
    expect(ss.text).not.toMatch(/200~|201~/);
  }, 25000);

  it("translates kitty CSI u Ctrl+W to legacy 0x17 for bash readline", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise((r) => setTimeout(r, 500));

    // Type a marker the prompt will display, then send Ctrl+W as a
    // kitty CSI u sequence (codepoint 119 = 'w', modifier 5 = ctrl).
    // Bash readline doesn't have kitty keyboard enabled, so it would
    // see the literal ESC sequence as gibberish without translation.
    // With translation it gets 0x17 and rubs out the previous word.
    session.type("uniqueXYZQQQ");
    await session.waitForText("uniqueXYZQQQ", 10000);
    session.sendKeys("\x1b[119;5u");
    await new Promise((r) => setTimeout(r, 300));

    // After ^W readline rubs out the whole word; the marker should be
    // gone from the prompt line. The literal "119" only appears on
    // screen if the CSI u bytes leaked through untranslated.
    const ss = session.screenshot();
    expect(ss.text).not.toContain("uniqueXYZQQQ");
    expect(ss.text).not.toContain("119");
  }, 25000);
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

  it("auto-tag close: ^]w removes layout tag but session keeps running", async () => {
    // The defining property of auto-tag mode: closing a pane doesn't
    // kill the session, just untags it. We can prove this by running
    // another pty-layout (with --tag pointing at the same random key)
    // and confirming the session shows up there — but a simpler check
    // is: after ^]w, listSessions still shows the session as running.
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);

    // Grab the session names from pty list before close
    const beforeCount = (await listSessions()).filter(s => s.status === "running").length;

    prefixKey("w");
    await session.waitForText("1/1", 10000);

    // Session count unchanged — close = untag, not kill.
    // Wait a bit for updateTags to fire.
    await new Promise(r => setTimeout(r, 500));
    const afterCount = (await listSessions()).filter(s => s.status === "running").length;
    expect(afterCount).toBe(beforeCount);
  }, 30000);

  it("^]\\ removes the focused pane in auto-tag mode (same as ^]w)", async () => {
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    session.sendKeys("\x1c");
    await session.waitForText("1/1", 10000);
  }, 20000);
});

describe("auto-tag mode", () => {
  it("status bar shows a [badge] for the layout", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    const ss = session.screenshot();
    // Badge: [abcxyz12] — 8 lowercase alphanumeric chars in brackets
    expect(ss.text).toMatch(/\[[a-z0-9]{8}\]/);
  }, 20000);

  it("picker can pick an untagged existing session and pull it in", async () => {
    // Spawn an UNTAGGED daemon session externally. Picker should list
    // it (all sessions, not filtered by layout's random tag), pick
    // applies the tag, pane appears.
    const name = `pull-test-${Date.now()}`;
    await spawnDaemon({ name, command: "bash", args: [], displayCommand: "bash" });
    await new Promise(r => setTimeout(r, 500));

    startApp();
    await session.waitForText("Sessions", 15000);
    session.type(name);
    await new Promise(r => setTimeout(r, 300));
    session.sendKeys("\r");
    await session.waitForText("1/1", 10000);

    // The session name should be in the pane title
    const ss = session.screenshot();
    expect(ss.text).toContain(name);
  }, 25000);

  it("empty layout on startup auto-opens the picker", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);
  }, 20000);
});

describe("pty-layout new (subcommand)", () => {
  it("errors when $PTY_LAYOUT_FILTER_TAG is unset", async () => {
    // Run the subcommand directly in an isolated PTY (not inside a
    // pty-layout shell). $PTY_LAYOUT_FILTER_TAG is not set, so it
    // should error with a clear message.
    session = Session.spawn(
      "node",
      ["--experimental-strip-types", "--no-warnings", mainScript, "new", "--", "bash"],
      {
        rows: 10,
        cols: 80,
        // Explicitly blank PTY_LAYOUT_FILTER_TAG — Session.spawn merges
        // opts.env on top of process.env, and if the test runner itself
        // is inside a pty-layout shell (dev environment), the var leaks
        // through. The subcommand treats empty-string as "not set."
        env: {
          TERM: "xterm-256color",
          HOME: process.env.HOME!,
          PTY_LAYOUT_FILTER_TAG: "",
        },
      },
    );
    await session.waitForText("PTY_LAYOUT_FILTER_TAG is not set", 10000);
  }, 15000);

  it("errors on unknown flag", async () => {
    session = Session.spawn(
      "node",
      ["--experimental-strip-types", "--no-warnings", mainScript, "new", "--bogus"],
      { rows: 10, cols: 80, env: { TERM: "xterm-256color" } },
    );
    await session.waitForText("unknown flag", 10000);
  }, 15000);

  it("spawns a session with the layout's tag — appears as a pane", async () => {
    // Full end-to-end: start a layout, pick "+ New session" to get a
    // shell with $PTY_LAYOUT_FILTER_TAG set, then run `pty-layout new`
    // from that shell. The new session should appear in the layout.
    startApp();
    await session.waitForText("Sessions", 15000);
    session.sendKeys("\r"); // pick "+ New session"
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Node binary path so we can invoke main.ts from within the pane
    const nodeBin = process.execPath;
    const cmd = `${nodeBin} --experimental-strip-types --no-warnings ${mainScript} new -- bash -c 'echo FROM-NEW; sleep 30'`;
    session.type(cmd + "\r");

    // Focus moves to the newly-spawned session (it's picker-ish:
    // subscription event-driven adds that weren't flagged for focus
    // DON'T steal focus — but `new` isn't in focusOnAddNames either).
    // We just check the pane count jumps to 2.
    await session.waitForText("1/2", 15000);

    // And the spawned command's output shows somewhere
    await session.waitForText("FROM-NEW", 10000);
  }, 40000);
});

describe("explicit --tag mode (read-only)", () => {
  it("^]w is disabled in explicit --tag mode", async () => {
    const tag = `readonly-${Date.now()}`;
    // Pre-create a session tagged with our filter, so the layout has
    // something to show.
    const name = `ro-${Date.now()}`;
    await spawnDaemon({
      name,
      command: "bash",
      args: [],
      displayCommand: "bash",
      tags: { project: tag },
    });
    await new Promise(r => setTimeout(r, 500));

    startApp(["--tag", `project=${tag}`]);
    await session.waitForText("1/1", 15000);

    // ^]w should be a no-op: pane count stays at 1/1
    prefixKey("w");
    await new Promise(r => setTimeout(r, 500));
    const ss = session.screenshot();
    expect(ss.text).toContain("1/1");
  }, 25000);

  it("status bar shows the explicit tag filter in the badge", async () => {
    const tag = `badgetest-${Date.now()}`;
    startApp(["--tag", `project=${tag}`]);
    await session.waitForText("Watching for sessions tagged", 15000);
    const ss = session.screenshot();
    expect(ss.text).toContain(`[project=${tag}]`);
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

  it("activity on a collapsed pane shows on focus switch (no stale cache)", async () => {
    // Regression: the stacked-layout collapsed branch used to clear
    // pane.handle.dirty WITHOUT reading fresh cells, so when the user
    // focused a pane that had activity while collapsed, the render used
    // stale cached cells and showed nothing new until more data arrived.
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Go to stacked. Focus is on pane 1; pane 2 is collapsed.
    prefixKey("l");
    await session.waitForText("stacked", 5000);
    session.sendKeys("\x1b"); // cancel sticky prefix
    await new Promise(r => setTimeout(r, 300));

    // Focus pane 2, type a marker — this is its "baseline"
    prefixKey("2");
    await session.waitForText("2/2", 5000);
    session.type("echo BASELINE-2\r");
    await session.waitForText("BASELINE-2", 5000);
    await new Promise(r => setTimeout(r, 300));

    // Back to pane 1 — pane 2 collapses
    prefixKey("1");
    await session.waitForText("1/2", 5000);
    await new Promise(r => setTimeout(r, 300));

    // Inject activity into pane 2 while it's collapsed. We use
    // `pty send` to avoid depending on pane 1's keyboard echo.
    // The bash in pane 2 will print a new line.
    const sessions2 = (await listSessions())
      .filter(s => s.status === "running")
      .map(s => s.name);
    // Grab the session name for pane 2 by peeking for BASELINE-2
    let pane2Name = "";
    for (const name of sessions2) {
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync(`pty peek ${name}`, {
          encoding: "utf8", timeout: 3000,
        });
        if (out.includes("BASELINE-2")) { pane2Name = name; break; }
      } catch {}
    }
    expect(pane2Name).not.toBe("");

    // Send a distinctive command to pane 2 (bash prints it, then executes)
    const { execSync } = await import("node:child_process");
    execSync(`pty send ${pane2Name} --seq "echo WHILE-COLLAPSED" --seq key:return`, {
      encoding: "utf8", timeout: 3000,
    });
    await new Promise(r => setTimeout(r, 500));

    // Focus pane 2 — the collapsed-period output must appear immediately
    prefixKey("2");
    await session.waitForText("WHILE-COLLAPSED", 5000);
  }, 45000);
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

  it("updates pane title when a tracked session is renamed", async () => {
    const name = `tag-rename-${Date.now()}`;
    const originalDisplay = `orig-${Date.now()}`;
    await spawnDaemon({
      name,
      command: "bash",
      args: [],
      displayCommand: "bash",
      displayName: originalDisplay,
      tags: { project: "tag-rename" },
    });
    await new Promise(r => setTimeout(r, 500));

    startApp(["--tag", "project=tag-rename"]);
    await session.waitForText(originalDisplay, 15000);

    const newDisplay = `renamed-${Date.now()}`;
    await setDisplayName(name, newDisplay);

    await session.waitForText(newDisplay, 5000);
    await session.waitForAbsent(originalDisplay, 5000);
  }, 25000);
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

  it("kitty CSI u Esc inside the picker closes it (doesn't leak through)", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);
    // \e[27u is the kitty CSI u form for plain Esc. Picker should close.
    session.sendKeys("\x1b[27u");
    await session.waitForText("^] n to open session picker", 5000);
  }, 20000);

  // Documents a known edge case: when the picker is open and the outer
  // terminal is encoding keys via kitty CSI u (because a previously
  // focused pane had it on and we proxy the flags up), the picker's
  // ESC + plain `[A`/`[B` arrow key handler doesn't see the standard
  // form and falls through to "bare ESC" which closes the picker. Ideal
  // fix: route picker input through the same translation layer used for
  // pane forwarding, OR push \e[>0u when the picker opens. Skipped until
  // we land that. Repro: kitty-encoded Up arrow as CSI 1;5A or CSI 57352u.
  it.skip("kitty CSI u arrow keys move the picker selection", async () => {
    startApp();
    await session.waitForText("Sessions", 15000);
    // Down arrow as kitty CSI u (codepoint 57353 ≈ U+E029, varies by spec).
    session.sendKeys("\x1b[57353u");
    await new Promise((r) => setTimeout(r, 200));
    // The picker should still be open (selection moved, not closed).
    const ss = session.screenshot();
    expect(ss.text).toContain("Sessions");
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

  it("^]n + New session focuses the newly-created pane", async () => {
    // Regression: subscription-driven adds used to NOT move focus, so
    // new panes opened via the picker landed unfocused. The user's
    // intent — they explicitly asked for a new pane — is to see it
    // right away.
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Put a marker in pane 1 so we can confirm pane 2 becomes focused
    session.type("echo PANE-ONE\r");
    await session.waitForText("PANE-ONE", 5000);

    // Open picker, hit Enter on the default "+ New session" item
    prefixKey("n");
    await session.waitForText("Sessions", 5000);
    session.sendKeys("\r");

    // Focus should be on the NEW pane (pane 2). We wait for "2/2"
    // directly — the transition through "1/2" isn't observable because
    // focus moves atomically with the pane-add.
    await session.waitForText("2/2", 15000);

    // Type something — it should land in the new pane, not pane 1
    await new Promise(r => setTimeout(r, 500));
    session.type("echo NEW-PANE-FOCUSED\r");
    await session.waitForText("NEW-PANE-FOCUSED", 5000);
  }, 25000);

  it("subscription-triggered external session does NOT steal focus", async () => {
    // Counterpart: when a session is tagged into our view from OUTSIDE
    // (e.g. the tmux shim's split-window, or another tool), we should
    // add the pane at the end but keep user focus where it was.
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Grab the layout tag from the status bar badge
    const ss1 = session.screenshot();
    const m = ss1.text.match(/\[([a-z0-9]{8})\]/);
    expect(m).not.toBeNull();
    const suffix = m![1]!;

    // Find the full key by listing sessions and reading their tags
    const sessions = await listSessions();
    const running = sessions.find(s => s.status === "running" && s.metadata?.tags
      && Object.keys(s.metadata.tags).some(k => k.endsWith(`-${suffix}`)));
    expect(running).toBeDefined();
    const tagKey = Object.keys(running!.metadata!.tags!)
      .find(k => k.endsWith(`-${suffix}`))!;

    // Externally spawn a NEW session and apply the layout's tag to it.
    // The subscription should pick it up and add a pane — focus stays on 1.
    const externalName = `ext-${Date.now()}`;
    await spawnDaemon({
      name: externalName,
      command: "bash",
      args: [],
      displayCommand: "bash",
      tags: { [tagKey]: "1" },
    });

    // Wait for 2 panes
    await session.waitForText("1/2", 15000);
    // Focus should STILL be on 1, not auto-moved to 2
    const ss2 = session.screenshot();
    expect(ss2.text).toContain("1/2");
  }, 25000);
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

  it("selection survives pane exit mid-drag without crashing", async () => {
    // Reproduce the crash pattern: start a drag, let the focused pane's
    // session exit during the drag (or before mouseup), then release.
    // The readCells/readWrappedFlags calls in mouseUp see a disposed
    // terminal if the timing is wrong. With the defensive try/catch in
    // the mouseUp handler, the app should stay alive and the status
    // bar should still be rendering.
    startApp(["bash", "bash"]);
    await session.waitForText("1/2", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Focus pane 2 and put something on screen
    prefixKey("2");
    await session.waitForText("2/2", 5000);
    session.type("echo CANARY\r");
    await session.waitForText("CANARY", 5000);

    // Start a drag in pane 2's area (approx — layout is 2 side-by-side
    // at the default 30x100). We use SGR mouse coords; exact pane
    // boundary isn't important, as long as we hit inside a pane.
    const panesStart = 3;
    session.sendKeys(`\x1b[<0;${60};${panesStart}M`);
    session.sendKeys(`\x1b[<32;${70};${panesStart}M`);

    // While the drag is in flight, exit the focused pane's session.
    // That fires session_exit → removePane → handle.kill() → terminal
    // .dispose(). Subsequent readCells would throw on a disposed buffer.
    session.type("exit\r");
    await session.waitForText("1/1", 5000);

    // Now release the mouse. The pane index the selection captured may
    // no longer be valid; without the defensive guard this was crashing.
    session.sendKeys(`\x1b[<0;${70};${panesStart}m`);

    // App still alive — type a command, see its echo.
    await new Promise(r => setTimeout(r, 200));
    session.type("echo STILL-ALIVE\r");
    await session.waitForText("STILL-ALIVE", 5000);
  }, 30000);

  it("selection into an exited pane via mouseup doesn't crash", async () => {
    // Variant: both mousedown and mouseup land on a pane whose session
    // has already exited but is mid-removal.
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    session.type("echo BEFORE-EXIT\r");
    await session.waitForText("BEFORE-EXIT", 5000);

    // Exit the session
    session.type("exit\r");
    // Immediately try a drag-select in the pane area while removal is
    // in progress. There's a small window where the pane is still in
    // panes[] but the handle is exiting.
    const r = 3;
    session.sendKeys(`\x1b[<0;3;${r}M`);
    session.sendKeys(`\x1b[<32;13;${r}M`);
    session.sendKeys(`\x1b[<0;13;${r}m`);

    // No assertion on clipboard behavior — just that we survive.
    // Picker should reopen since pane count dropped to zero.
    await session.waitForText("Sessions", 10000);
  }, 25000);

  it("scrolling does not clear an existing selection", async () => {
    startApp(["bash"]);
    await session.waitForText("1/1", 15000);
    await new Promise(r => setTimeout(r, 500));

    // Produce enough lines so scrollback is non-empty
    session.type("for i in $(seq 1 50); do echo LINE-$i; done\r");
    await session.waitForText("LINE-50", 5000);
    await new Promise(r => setTimeout(r, 300));

    // Start + drag a small selection. Use cells inside the inner area.
    const r = 5;
    session.sendKeys(`\x1b[<0;3;${r}M`);
    session.sendKeys(`\x1b[<32;15;${r}M`);
    session.sendKeys(`\x1b[<0;15;${r}m`);
    await new Promise(r => setTimeout(r, 200));

    // Evidence of selection: inverted ANSI (bg swap) somewhere
    const before = session.screenshot();
    expect(before.ansi).toContain("48;2;");

    // Scroll up via wheel. Previous behavior cleared the selection;
    // new behavior preserves it.
    for (let i = 0; i < 5; i++) {
      session.sendKeys(`\x1b[<64;10;${r}M`);
    }
    await new Promise(r => setTimeout(r, 200));

    // Selection should still be highlighted somewhere on screen
    const after = session.screenshot();
    expect(after.ansi).toContain("48;2;");
  }, 25000);
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
