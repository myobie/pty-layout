import { describe, it, expect } from "vitest";
import {
  parseFilterEnv,
  filtersToListArgs,
  filtersToRunTagArgs,
  stripPaneIdPrefix,
  toPaneId,
  translateKeyToken,
  splitDoubleDash,
  extractFlag,
  extractBoolFlag,
  planShim,
  planSplitOrNewWindow,
  planSendKeys,
  planDisplayMessage,
  planListPanes,
  planKillPane,
  formatOutput,
  formatListPanesOutput,
  type PlanContext,
} from "../src/tmux-shim.ts";

// Deterministic context used across tests
function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    env: { PTY_LAYOUT_FILTER_TAG: "team=alpha" },
    sessionId: () => "id00001",
    ...overrides,
  };
}

// ---------- parseFilterEnv ----------

describe("parseFilterEnv", () => {
  it("returns [] for undefined", () => {
    expect(parseFilterEnv(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseFilterEnv("")).toEqual([]);
  });

  it("returns [] for whitespace-only", () => {
    expect(parseFilterEnv("   ")).toEqual([]);
  });

  it("parses single key=value", () => {
    expect(parseFilterEnv("team=alpha")).toEqual([{ key: "team", value: "alpha" }]);
  });

  it("parses multiple filters separated by comma+space", () => {
    expect(parseFilterEnv("team=alpha, env=dev")).toEqual([
      { key: "team", value: "alpha" },
      { key: "env", value: "dev" },
    ]);
  });

  it("parses filters with just comma (no space)", () => {
    expect(parseFilterEnv("team=alpha,env=dev")).toEqual([
      { key: "team", value: "alpha" },
      { key: "env", value: "dev" },
    ]);
  });

  it("parses bare keys (no value)", () => {
    expect(parseFilterEnv("team, env=dev")).toEqual([
      { key: "team" },
      { key: "env", value: "dev" },
    ]);
  });
});

// ---------- Argv helpers ----------

describe("splitDoubleDash", () => {
  it("returns cmd null when no --", () => {
    const r = splitDoubleDash(["-h", "-P"]);
    expect(r.flags).toEqual(["-h", "-P"]);
    expect(r.cmd).toBeNull();
  });

  it("splits at first --", () => {
    const r = splitDoubleDash(["-h", "--", "bash", "-c", "echo hi"]);
    expect(r.flags).toEqual(["-h"]);
    expect(r.cmd).toEqual(["bash", "-c", "echo hi"]);
  });

  it("empty flags when -- is first", () => {
    const r = splitDoubleDash(["--", "bash"]);
    expect(r.flags).toEqual([]);
    expect(r.cmd).toEqual(["bash"]);
  });
});

describe("extractFlag", () => {
  it("finds `-t value`", () => {
    const r = extractFlag(["-t", "%abc", "foo"], "-t");
    expect(r.value).toBe("%abc");
    expect(r.rest).toEqual(["foo"]);
  });

  it("finds attached form `-tvalue`", () => {
    const r = extractFlag(["-t%abc", "foo"], "-t");
    expect(r.value).toBe("%abc");
    expect(r.rest).toEqual(["foo"]);
  });

  it("returns null value when flag absent", () => {
    const r = extractFlag(["foo"], "-t");
    expect(r.value).toBeNull();
    expect(r.rest).toEqual(["foo"]);
  });

  it("only consumes the first occurrence", () => {
    const r = extractFlag(["-t", "a", "-t", "b"], "-t");
    expect(r.value).toBe("a");
    expect(r.rest).toEqual(["-t", "b"]);
  });
});

describe("extractBoolFlag", () => {
  it("strips the flag", () => {
    const r = extractBoolFlag(["-P", "foo"], "-P");
    expect(r.present).toBe(true);
    expect(r.rest).toEqual(["foo"]);
  });

  it("absent → present=false, rest unchanged", () => {
    const r = extractBoolFlag(["foo"], "-P");
    expect(r.present).toBe(false);
    expect(r.rest).toEqual(["foo"]);
  });
});

// ---------- pane id ----------

describe("pane id conversions", () => {
  it("roundtrips %name → name → %name", () => {
    expect(stripPaneIdPrefix(toPaneId("abc123"))).toBe("abc123");
  });

  it("stripPaneIdPrefix leaves bare names alone", () => {
    expect(stripPaneIdPrefix("abc123")).toBe("abc123");
  });

  it("strips leading % from %<id> form", () => {
    expect(stripPaneIdPrefix("%a%b")).toBe("a%b");
  });

  it("extracts pane id from session:window.%pane form", () => {
    expect(stripPaneIdPrefix("main:0.%abc123")).toBe("abc123");
  });

  it("returns session name from session:window form", () => {
    expect(stripPaneIdPrefix("main:0")).toBe("main");
  });

  it("returns session name from session:window.pane form with numeric pane", () => {
    expect(stripPaneIdPrefix("main:0.0")).toBe("main");
  });
});

// ---------- key translation ----------

describe("translateKeyToken", () => {
  it("maps Enter to key:return", () => {
    expect(translateKeyToken("Enter")).toBe("key:return");
  });

  it("maps Return to key:return", () => {
    expect(translateKeyToken("Return")).toBe("key:return");
  });

  it("case-insensitive", () => {
    expect(translateKeyToken("ENTER")).toBe("key:return");
    expect(translateKeyToken("enter")).toBe("key:return");
  });

  it("maps Tab, Escape, Space, BSpace", () => {
    expect(translateKeyToken("Tab")).toBe("key:tab");
    expect(translateKeyToken("Escape")).toBe("key:escape");
    expect(translateKeyToken("Esc")).toBe("key:escape");
    expect(translateKeyToken("Space")).toBe("key:space");
    expect(translateKeyToken("BSpace")).toBe("key:backspace");
    expect(translateKeyToken("Backspace")).toBe("key:backspace");
  });

  it("maps arrows", () => {
    expect(translateKeyToken("Up")).toBe("key:up");
    expect(translateKeyToken("Down")).toBe("key:down");
    expect(translateKeyToken("Left")).toBe("key:left");
    expect(translateKeyToken("Right")).toBe("key:right");
  });

  it("maps Home, End, PPage, NPage, DC/Delete", () => {
    expect(translateKeyToken("Home")).toBe("key:home");
    expect(translateKeyToken("End")).toBe("key:end");
    expect(translateKeyToken("PPage")).toBe("key:pageup");
    expect(translateKeyToken("PageUp")).toBe("key:pageup");
    expect(translateKeyToken("NPage")).toBe("key:pagedown");
    expect(translateKeyToken("PageDown")).toBe("key:pagedown");
    expect(translateKeyToken("DC")).toBe("key:delete");
    expect(translateKeyToken("Delete")).toBe("key:delete");
  });

  it("maps BTab to shift+tab", () => {
    expect(translateKeyToken("BTab")).toBe("key:shift+tab");
  });

  it("maps C-c, M-x, S-Tab with modifiers", () => {
    expect(translateKeyToken("C-c")).toBe("key:ctrl+c");
    expect(translateKeyToken("M-x")).toBe("key:alt+x");
    expect(translateKeyToken("S-Tab")).toBe("key:shift+tab");
  });

  it("maps multiple modifiers (C-M-a)", () => {
    expect(translateKeyToken("C-M-a")).toBe("key:ctrl+alt+a");
  });

  it("returns literal text for unknown tokens (no crash)", () => {
    expect(translateKeyToken("hello")).toBe("hello");
    expect(translateKeyToken("echo sent")).toBe("echo sent");
  });

  it("returns literal for empty string", () => {
    expect(translateKeyToken("")).toBe("");
  });

  it("returns literal for tokens with = signs (not a key)", () => {
    expect(translateKeyToken("KEY=VALUE")).toBe("KEY=VALUE");
  });

  it("modified unknown tokens fall back to literal", () => {
    expect(translateKeyToken("C-NotAKey")).toBe("C-NotAKey");
  });
});

// ---------- filtersToListArgs / filtersToRunTagArgs ----------

describe("filter → argv helpers", () => {
  it("filtersToListArgs emits --filter-tag per value filter", () => {
    expect(
      filtersToListArgs([
        { key: "team", value: "alpha" },
        { key: "env", value: "dev" },
      ]),
    ).toEqual(["--filter-tag", "team=alpha", "--filter-tag", "env=dev"]);
  });

  it("filtersToListArgs skips bare-key filters", () => {
    expect(filtersToListArgs([{ key: "team" }, { key: "env", value: "dev" }])).toEqual([
      "--filter-tag",
      "env=dev",
    ]);
  });

  it("filtersToRunTagArgs emits --tag per value filter", () => {
    expect(filtersToRunTagArgs([{ key: "team", value: "alpha" }])).toEqual([
      "--tag",
      "team=alpha",
    ]);
  });

  it("filtersToRunTagArgs empty input → empty output", () => {
    expect(filtersToRunTagArgs([])).toEqual([]);
  });
});

// ---------- formatOutput ----------

describe("formatOutput", () => {
  it("returns pane id when format is null", () => {
    expect(formatOutput(null, { paneId: "%abc" })).toBe("%abc");
  });

  it("substitutes #{pane_id}", () => {
    expect(formatOutput("#{pane_id}", { paneId: "%abc" })).toBe("%abc");
  });

  it("substitutes multiple tokens", () => {
    expect(
      formatOutput("#{pane_id} in #{session_name}", {
        paneId: "%abc",
        sessionName: "abc",
      }),
    ).toBe("%abc in abc");
  });

  it("substitutes tmux short forms #D #S #W", () => {
    expect(formatOutput("#D", { paneId: "%abc" })).toBe("%abc");
    expect(formatOutput("#S", { sessionName: "abc" })).toBe("abc");
    expect(formatOutput("#W", { windowName: "win" })).toBe("win");
  });

  it("returns 0 for window_index and pane_index (one-pane-per-session)", () => {
    expect(formatOutput("#{window_index}", { paneId: "%abc" })).toBe("0");
    expect(formatOutput("#{pane_index}", { paneId: "%abc" })).toBe("0");
    expect(formatOutput("#I", { paneId: "%abc" })).toBe("0");
    expect(formatOutput("#P", { paneId: "%abc" })).toBe("0");
  });

  it("handles session:window.pane format for Claude Code agent-teams parse", () => {
    expect(
      formatOutput("#{session_name}:#{window_index}.#{pane_index}", {
        paneId: "%abc",
        sessionName: "abc",
      }),
    ).toBe("abc:0.0");
  });

  it("empty string for missing fields", () => {
    expect(formatOutput("#{pane_pid}", { paneId: "%abc" })).toBe("");
  });
});

// ---------- split-window / new-window ----------

describe("planSplitOrNewWindow", () => {
  it("spawns pty run with --tag, --name, and env-wraps the command", () => {
    const plan = planSplitOrNewWindow(["--", "bash", "-c", "echo hi"], ctx());
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.ptyArgv).toEqual([
      "run",
      "-d",
      "--name",
      "id00001",
      "--tag",
      "team=alpha",
      "--",
      "/usr/bin/env",
      "TMUX_PANE=%id00001",
      "bash",
      "-c",
      "echo hi",
    ]);
  });

  it("sets TMUX_PANE on the teammate so Claude Code's probe works", () => {
    const plan = planSplitOrNewWindow(["--", "claude"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    // /usr/bin/env TMUX_PANE=%<new-id> comes RIGHT after the -- separator
    const dashDashIdx = plan.ptyArgv.indexOf("--");
    expect(plan.ptyArgv[dashDashIdx + 1]).toBe("/usr/bin/env");
    expect(plan.ptyArgv[dashDashIdx + 2]).toBe("TMUX_PANE=%id00001");
  });

  it("ignores -h (horizontal split flag)", () => {
    const plan = planSplitOrNewWindow(["-h", "--", "bash"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toContain("run");
    expect(plan.ptyArgv).toContain("bash");
    expect(plan.ptyArgv).not.toContain("-h");
  });

  it("ignores tmux -v, -d, -t flags (tmux's -d, not pty's -d)", () => {
    const plan = planSplitOrNewWindow(
      ["-v", "-d", "-t", "%existing", "--", "bash"],
      ctx(),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    // -t target was stripped (no dangling %existing anywhere)
    expect(plan.ptyArgv).not.toContain("%existing");
    // -v was stripped
    expect(plan.ptyArgv).not.toContain("-v");
    // The only `-d` in output should be pty's detached flag at index 1
    const dashDCount = plan.ptyArgv.filter((a) => a === "-d").length;
    expect(dashDCount).toBe(1);
    expect(plan.ptyArgv[0]).toBe("run");
    expect(plan.ptyArgv[1]).toBe("-d");
  });

  it("forwards -c <cwd> to pty run --cwd", () => {
    const plan = planSplitOrNewWindow(["-c", "/tmp/proj", "--", "bash"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toContain("--cwd");
    expect(plan.ptyArgv[plan.ptyArgv.indexOf("--cwd") + 1]).toBe("/tmp/proj");
  });

  it("prints pane id after spawn when -P given (default format)", () => {
    const plan = planSplitOrNewWindow(["-P", "--", "bash"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.postPrint).toBe("%id00001\n");
  });

  it("prints custom format when -P -F given", () => {
    const plan = planSplitOrNewWindow(
      ["-P", "-F", "#{pane_id}=#{session_name}", "--", "bash"],
      ctx(),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.postPrint).toBe("%id00001=id00001\n");
  });

  it("no postPrint when -P not given", () => {
    const plan = planSplitOrNewWindow(["--", "bash"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.postPrint).toBeUndefined();
  });

  it("defaults to user's zsh with ZDOTDIR when no command given", () => {
    const plan = planSplitOrNewWindow(
      [],
      ctx({
        env: {
          PTY_LAYOUT_FILTER_TAG: "team=alpha",
          SHELL: "/bin/zsh",
          PTY_LAYOUT_SHIM_DIR: "/shim",
        },
      }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    // Trailing command should be: env TMUX_PANE=... env ZDOTDIR=... /bin/zsh
    const dashIdx = plan.ptyArgv.indexOf("--");
    const trailing = plan.ptyArgv.slice(dashIdx + 1);
    expect(trailing).toEqual([
      "/usr/bin/env",
      "TMUX_PANE=%id00001",
      "/usr/bin/env",
      "ZDOTDIR=/shim/shell-init",
      "/bin/zsh",
    ]);
  });

  it("uses the user's bash (Homebrew path) when SHELL=/opt/homebrew/bin/bash", () => {
    const plan = planSplitOrNewWindow(
      [],
      ctx({
        env: {
          PTY_LAYOUT_FILTER_TAG: "team=alpha",
          SHELL: "/opt/homebrew/bin/bash",
          PTY_LAYOUT_SHIM_DIR: "/shim",
        },
      }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    const dashIdx = plan.ptyArgv.indexOf("--");
    const trailing = plan.ptyArgv.slice(dashIdx + 1);
    expect(trailing).toEqual([
      "/usr/bin/env",
      "TMUX_PANE=%id00001",
      "/opt/homebrew/bin/bash",
      "--rcfile",
      "/shim/shell-init/bashrc",
      "-i",
    ]);
  });

  it("spawns fish directly (no --rcfile/ZDOTDIR wrapper)", () => {
    const plan = planSplitOrNewWindow(
      [],
      ctx({
        env: {
          PTY_LAYOUT_FILTER_TAG: "team=alpha",
          SHELL: "/opt/homebrew/bin/fish",
          PTY_LAYOUT_SHIM_DIR: "/shim",
        },
      }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    const dashIdx = plan.ptyArgv.indexOf("--");
    const trailing = plan.ptyArgv.slice(dashIdx + 1);
    // env TMUX_PANE=... fish — no rcfile or ZDOTDIR
    expect(trailing).toEqual([
      "/usr/bin/env",
      "TMUX_PANE=%id00001",
      "/opt/homebrew/bin/fish",
    ]);
  });

  it("spawns unknown shells directly (no wrapper)", () => {
    const plan = planSplitOrNewWindow(
      [],
      ctx({
        env: {
          PTY_LAYOUT_FILTER_TAG: "team=alpha",
          SHELL: "/usr/local/bin/nushell",
          PTY_LAYOUT_SHIM_DIR: "/shim",
        },
      }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    const dashIdx = plan.ptyArgv.indexOf("--");
    const trailing = plan.ptyArgv.slice(dashIdx + 1);
    expect(trailing).toEqual([
      "/usr/bin/env",
      "TMUX_PANE=%id00001",
      "/usr/local/bin/nushell",
    ]);
  });

  it("bare -- (no cmd) also spawns default shell", () => {
    const plan = planSplitOrNewWindow(
      ["-h", "--"],
      ctx({
        env: {
          PTY_LAYOUT_FILTER_TAG: "team=alpha",
          SHELL: "/bin/zsh",
          PTY_LAYOUT_SHIM_DIR: "/shim",
        },
      }),
    );
    expect(plan.kind).toBe("spawn");
  });

  it("errors when PTY_LAYOUT_FILTER_TAG is missing", () => {
    const plan = planSplitOrNewWindow(["--", "bash"], ctx({ env: {} }));
    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") return;
    expect(plan.message).toMatch(/PTY_LAYOUT_FILTER_TAG/);
  });

  it("errors when filter has only bare-key tags (unusable for spawn)", () => {
    const plan = planSplitOrNewWindow(
      ["--", "bash"],
      ctx({ env: { PTY_LAYOUT_FILTER_TAG: "team" } }),
    );
    expect(plan.kind).toBe("error");
  });

  it("emits multiple --tag when filter has multiple key=value", () => {
    const plan = planSplitOrNewWindow(
      ["--", "bash"],
      ctx({ env: { PTY_LAYOUT_FILTER_TAG: "team=alpha, env=dev" } }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    const tagPairs: string[][] = [];
    for (let i = 0; i < plan.ptyArgv.length; i++) {
      if (plan.ptyArgv[i] === "--tag") tagPairs.push([plan.ptyArgv[i]!, plan.ptyArgv[i + 1]!]);
    }
    expect(tagPairs).toEqual([
      ["--tag", "team=alpha"],
      ["--tag", "env=dev"],
    ]);
  });

  it("handles long commands without truncation (avoiding the send-keys 255-byte bug)", () => {
    const bigCmd = "echo " + "x".repeat(500);
    const plan = planSplitOrNewWindow(["--", "bash", "-c", bigCmd], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toContain(bigCmd);
    expect(plan.ptyArgv[plan.ptyArgv.length - 1]).toBe(bigCmd);
  });
});

// ---------- send-keys ----------

describe("planSendKeys", () => {
  it("translates keys to pty send --seq sequence", () => {
    const plan = planSendKeys(["-t", "%abc", "echo sent", "Enter"], ctx());
    expect(plan.kind).toBe("spawn");
    if (plan.kind !== "spawn") return;
    expect(plan.ptyArgv).toEqual([
      "send",
      "abc",
      "--seq",
      "echo sent",
      "--seq",
      "key:return",
    ]);
  });

  it("strips %-prefix from target", () => {
    const plan = planSendKeys(["-t", "%xyz", "x", "Enter"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv[1]).toBe("xyz");
  });

  it("accepts bare session name as target", () => {
    const plan = planSendKeys(["-t", "xyz", "x", "Enter"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv[1]).toBe("xyz");
  });

  it("-l (literal) disables key translation", () => {
    const plan = planSendKeys(["-l", "-t", "%abc", "Enter"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    // "Enter" stays as literal text, not translated to key:return
    expect(plan.ptyArgv).toEqual(["send", "abc", "--seq", "Enter"]);
  });

  it("errors without -t", () => {
    const plan = planSendKeys(["hi", "Enter"], ctx());
    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") return;
    expect(plan.message).toMatch(/requires `-t/);
  });

  it("errors with no keys", () => {
    const plan = planSendKeys(["-t", "%abc"], ctx());
    expect(plan.kind).toBe("error");
  });

  it("errors on -X (execute tmux command)", () => {
    const plan = planSendKeys(["-t", "%abc", "-X", "copy-mode"], ctx());
    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") return;
    expect(plan.message).toMatch(/-X/);
  });

  it("handles multiple literal tokens plus a key", () => {
    const plan = planSendKeys(
      ["-t", "%abc", "first", "second", "Enter"],
      ctx(),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toEqual([
      "send",
      "abc",
      "--seq",
      "first",
      "--seq",
      "second",
      "--seq",
      "key:return",
    ]);
  });

  it("ignores -R (reset) and -H (hex)", () => {
    const plan = planSendKeys(["-R", "-H", "-t", "%abc", "Enter"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toContain("send");
  });

  it("handles C- / M- modifiers", () => {
    const plan = planSendKeys(["-t", "%abc", "C-c"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toContain("key:ctrl+c");
  });
});

// ---------- display-message ----------

describe("planDisplayMessage", () => {
  it("prints pane id for current session when -p", () => {
    const plan = planDisplayMessage(
      ["-p", "#{pane_id}"],
      ctx({ env: { PTY_SESSION: "mysess" } }),
    );
    expect(plan.kind).toBe("print");
    if (plan.kind !== "print") return;
    expect(plan.stdout).toBe("%mysess\n");
  });

  it("prefers TMUX_PANE over deriving from PTY_SESSION", () => {
    const plan = planDisplayMessage(
      ["-p", "#{pane_id}"],
      ctx({ env: { PTY_SESSION: "derived", TMUX_PANE: "%explicit" } }),
    );
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("%explicit\n");
  });

  it("handles no format (just prints pane id)", () => {
    const plan = planDisplayMessage(["-p"], ctx({ env: { PTY_SESSION: "s1" } }));
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("%s1\n");
  });

  it("empty string if PTY_SESSION unset", () => {
    const plan = planDisplayMessage(["-p"], ctx({ env: {} }));
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("\n");
  });

  it("handles Claude Code's session:window.pane probe", () => {
    const plan = planDisplayMessage(
      ["-p", "#{session_name}:#{window_index}.#{pane_index}"],
      ctx({ env: { PTY_SESSION: "teammate1" } }),
    );
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("teammate1:0.0\n");
  });

  it("handles the combined session_name:window_index probe", () => {
    const plan = planDisplayMessage(
      ["-p", "#{session_name}:#{window_index}"],
      ctx({ env: { PTY_SESSION: "teammate1" } }),
    );
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("teammate1:0\n");
  });

  it("unknown #{...} tokens are emptied, not passed through literally", () => {
    const plan = planDisplayMessage(
      ["-p", "[#{pane_current_path}]"],
      ctx({ env: { PTY_SESSION: "s1" } }),
    );
    if (plan.kind !== "print") throw new Error("expected print");
    expect(plan.stdout).toBe("[]\n");
    expect(plan.stdout).not.toContain("#{");
  });
});

// ---------- list-panes ----------

describe("planListPanes", () => {
  it("spawns pty list --json with --filter-tag flags", () => {
    const plan = planListPanes([], ctx({ env: { PTY_LAYOUT_FILTER_TAG: "team=alpha" } }));
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toEqual(["list", "--json", "--filter-tag", "team=alpha"]);
    expect(plan.transformStdout).toBe("list-panes");
  });

  it("stores -F format for later formatting", () => {
    const plan = planListPanes(
      ["-F", "#{pane_id}: #{pane_current_command}"],
      ctx({ env: { PTY_LAYOUT_FILTER_TAG: "team=alpha" } }),
    );
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.listPanesFormat).toBe("#{pane_id}: #{pane_current_command}");
  });

  it("errors without filter", () => {
    const plan = planListPanes([], ctx({ env: {} }));
    expect(plan.kind).toBe("error");
  });
});

// ---------- formatListPanesOutput ----------

describe("formatListPanesOutput", () => {
  const mockJson = JSON.stringify([
    { name: "a1", status: "running", pid: 123, command: "bash", cwd: "/home/me" },
    { name: "b2", status: "running", pid: 456, command: "vim", cwd: "/tmp" },
    { name: "c3", status: "exited", pid: null, command: "old" },
  ]);

  it("skips exited sessions", () => {
    const out = formatListPanesOutput(mockJson, "");
    expect(out).not.toContain("c3");
    expect(out).toContain("a1");
    expect(out).toContain("b2");
  });

  it("uses default format when no format given", () => {
    const out = formatListPanesOutput(mockJson, "");
    expect(out).toContain("%a1: bash [/home/me]");
    expect(out).toContain("%b2: vim [/tmp]");
  });

  it("substitutes #{pane_id}", () => {
    const out = formatListPanesOutput(mockJson, "#{pane_id}");
    expect(out.split("\n").filter(Boolean)).toEqual(["%a1", "%b2"]);
  });

  it("substitutes #{pane_pid} #{pane_current_command} #{pane_current_path}", () => {
    const out = formatListPanesOutput(
      mockJson,
      "#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}",
    );
    expect(out).toContain("%a1|123|bash|/home/me");
    expect(out).toContain("%b2|456|vim|/tmp");
  });

  it("returns 0 for window_index and pane_index", () => {
    const out = formatListPanesOutput(
      mockJson,
      "#{session_name}:#{window_index}.#{pane_index}",
    );
    expect(out).toContain("a1:0.0");
    expect(out).toContain("b2:0.0");
  });

  it("handles malformed JSON gracefully (empty string)", () => {
    expect(formatListPanesOutput("not json", "")).toBe("");
  });

  it("empty array → empty output", () => {
    expect(formatListPanesOutput("[]", "")).toBe("");
  });

  it("output ends with newline when non-empty", () => {
    const out = formatListPanesOutput(mockJson, "");
    expect(out.endsWith("\n")).toBe(true);
  });
});

// ---------- kill-pane ----------

describe("planKillPane", () => {
  it("spawns pty kill with stripped id", () => {
    const plan = planKillPane(["-t", "%abc"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toEqual(["kill", "abc"]);
  });

  it("accepts bare session name", () => {
    const plan = planKillPane(["-t", "abc"], ctx());
    if (plan.kind !== "spawn") throw new Error("expected spawn");
    expect(plan.ptyArgv).toEqual(["kill", "abc"]);
  });

  it("errors without -t", () => {
    const plan = planKillPane([], ctx());
    expect(plan.kind).toBe("error");
  });
});

// ---------- planShim dispatcher ----------

describe("planShim dispatcher", () => {
  it("routes split-window", () => {
    const plan = planShim(["split-window", "--", "bash"], ctx());
    expect(plan.kind).toBe("spawn");
  });

  it("routes splitw alias", () => {
    const plan = planShim(["splitw", "--", "bash"], ctx());
    expect(plan.kind).toBe("spawn");
  });

  it("routes new-window + neww", () => {
    expect(planShim(["new-window", "--", "bash"], ctx()).kind).toBe("spawn");
    expect(planShim(["neww", "--", "bash"], ctx()).kind).toBe("spawn");
  });

  it("routes send-keys + send", () => {
    expect(planShim(["send-keys", "-t", "%a", "Enter"], ctx()).kind).toBe("spawn");
    expect(planShim(["send", "-t", "%a", "Enter"], ctx()).kind).toBe("spawn");
  });

  it("routes display-message + display + displaym", () => {
    expect(planShim(["display-message", "-p"], ctx()).kind).toBe("print");
    expect(planShim(["display", "-p"], ctx()).kind).toBe("print");
    expect(planShim(["displaym", "-p"], ctx()).kind).toBe("print");
  });

  it("routes list-panes + lsp", () => {
    expect(planShim(["list-panes"], ctx()).kind).toBe("spawn");
    expect(planShim(["lsp"], ctx()).kind).toBe("spawn");
  });

  it("routes kill-pane + killp", () => {
    expect(planShim(["kill-pane", "-t", "%a"], ctx()).kind).toBe("spawn");
    expect(planShim(["killp", "-t", "%a"], ctx()).kind).toBe("spawn");
  });

  it("has-session succeeds silently", () => {
    const plan = planShim(["has-session"], ctx());
    expect(plan.kind).toBe("print");
    if (plan.kind !== "print") return;
    expect(plan.exitCode).toBe(0);
  });

  it("no-op subcommands (select-pane, set, setw) succeed silently", () => {
    expect(planShim(["select-pane", "-t", "%a"], ctx()).kind).toBe("print");
    expect(planShim(["set-option", "-g", "foo", "bar"], ctx()).kind).toBe("print");
    expect(planShim(["setw", "-g", "x", "y"], ctx()).kind).toBe("print");
    expect(planShim(["rename-window", "foo"], ctx()).kind).toBe("print");
  });

  it("layout/resize/capture no-ops also succeed silently", () => {
    expect(planShim(["select-layout", "even-horizontal"], ctx()).kind).toBe("print");
    expect(planShim(["resize-pane", "-D", "5"], ctx()).kind).toBe("print");
    expect(planShim(["capture-pane", "-p"], ctx()).kind).toBe("print");
    expect(planShim(["pipe-pane", "-o"], ctx()).kind).toBe("print");
  });

  it("new-session no-ops silently", () => {
    const plan = planShim(["new-session", "-d", "-s", "main"], ctx());
    expect(plan.kind).toBe("print");
    if (plan.kind !== "print") return;
    expect(plan.exitCode).toBe(0);
  });

  it("-V / --version returns a parseable tmux version string", () => {
    for (const arg of ["-V", "--version"]) {
      const plan = planShim([arg], ctx());
      expect(plan.kind).toBe("print");
      if (plan.kind !== "print") continue;
      expect(plan.stdout).toMatch(/^tmux \d+\.\d+/);
    }
  });

  it("strips -L <socket> prefix before dispatch", () => {
    const plan = planShim(["-L", "mysocket", "has-session"], ctx());
    expect(plan.kind).toBe("print");
  });

  it("strips -S <socket-path> prefix before dispatch", () => {
    const plan = planShim(["-S", "/tmp/tmux.sock", "has-session"], ctx());
    expect(plan.kind).toBe("print");
  });

  it("strips -f <config> prefix before dispatch", () => {
    const plan = planShim(["-f", "/etc/tmux.conf", "has-session"], ctx());
    expect(plan.kind).toBe("print");
  });

  it("strips -u / -2 cosmetic flags", () => {
    expect(planShim(["-u", "has-session"], ctx()).kind).toBe("print");
    expect(planShim(["-2", "has-session"], ctx()).kind).toBe("print");
  });

  it("routes list-windows to list-panes plan", () => {
    const plan = planShim(["list-windows"], ctx());
    expect(plan.kind).toBe("spawn");
  });

  it("kill-session, kill-window, kill-server no-op silently", () => {
    expect(planShim(["kill-session"], ctx()).kind).toBe("print");
    expect(planShim(["kill-window"], ctx()).kind).toBe("print");
    expect(planShim(["kill-server"], ctx()).kind).toBe("print");
  });

  it("list-sessions / ls return empty output (not error)", () => {
    for (const sub of ["list-sessions", "ls", "list-clients", "list-buffers", "show-buffer"]) {
      const plan = planShim([sub], ctx());
      expect(plan.kind).toBe("print");
      if (plan.kind !== "print") continue;
      expect(plan.stdout).toBe("");
      expect(plan.exitCode).toBe(0);
    }
  });

  it("copy-mode, paste-buffer, set-window-option, set-environment no-op silently", () => {
    expect(planShim(["copy-mode"], ctx()).kind).toBe("print");
    expect(planShim(["paste-buffer"], ctx()).kind).toBe("print");
    expect(planShim(["set-window-option", "mode-keys", "vi"], ctx()).kind).toBe("print");
    expect(planShim(["set-environment", "-g", "FOO", "bar"], ctx()).kind).toBe("print");
  });

  it("errors on unknown subcommand", () => {
    const plan = planShim(["bind-key", "x", "y"], ctx());
    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") return;
    expect(plan.message).toMatch(/not implemented/);
  });

  it("errors on empty argv", () => {
    const plan = planShim([], ctx());
    expect(plan.kind).toBe("error");
  });
});
