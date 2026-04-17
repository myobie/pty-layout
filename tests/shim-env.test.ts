import { describe, it, expect } from "vitest";
import { buildShimEnv } from "../src/shim-env.ts";

describe("buildShimEnv", () => {
  const SHIM = "/opt/pty-layout/shim";
  const NAME = "abc12345";

  it("TMUX is non-empty (tmux-shaped)", () => {
    const env = buildShimEnv([], SHIM, { PATH: "/usr/bin" }, NAME);
    // Claude Code only checks it's non-empty. Real tmux uses
    // <socket>,<pid>,<id> triples; we mimic that shape so any
    // parser that assumes tmux format doesn't explode.
    expect(env.TMUX).toBeTruthy();
    expect(env.TMUX.startsWith("pty-layout,")).toBe(true);
  });

  it("sets TMUX_PANE to %<sessionName>", () => {
    const env = buildShimEnv([], SHIM, {}, NAME);
    expect(env.TMUX_PANE).toBe(`%${NAME}`);
  });

  it("prepends shim dir to PATH (does not replace)", () => {
    const env = buildShimEnv([], SHIM, { PATH: "/usr/bin:/bin" }, NAME);
    expect(env.PATH).toBe(`${SHIM}:/usr/bin:/bin`);
  });

  it("uses shim dir as PATH when no existing PATH", () => {
    const env = buildShimEnv([], SHIM, {}, NAME);
    expect(env.PATH).toBe(SHIM);
  });

  it("uses shim dir as PATH when existing PATH is empty string", () => {
    const env = buildShimEnv([], SHIM, { PATH: "" }, NAME);
    expect(env.PATH).toBe(SHIM);
  });

  it("sets PTY_LAYOUT_SHIM_DIR to the shim dir", () => {
    const env = buildShimEnv([], SHIM, {}, NAME);
    expect(env.PTY_LAYOUT_SHIM_DIR).toBe(SHIM);
  });

  it("serializes single key=value filter", () => {
    const env = buildShimEnv([{ key: "team", value: "alpha" }], SHIM, {}, NAME);
    expect(env.PTY_LAYOUT_FILTER_TAG).toBe("team=alpha");
  });

  it("serializes multiple filters", () => {
    const env = buildShimEnv(
      [
        { key: "team", value: "alpha" },
        { key: "env", value: "dev" },
      ],
      SHIM,
      {},
      NAME,
    );
    expect(env.PTY_LAYOUT_FILTER_TAG).toBe("team=alpha, env=dev");
  });

  it("serializes key-only filters (bare keys)", () => {
    const env = buildShimEnv([{ key: "team" }], SHIM, {}, NAME);
    expect(env.PTY_LAYOUT_FILTER_TAG).toBe("team");
  });

  it("PTY_LAYOUT_FILTER_TAG is empty string when no filters", () => {
    const env = buildShimEnv([], SHIM, {}, NAME);
    expect(env.PTY_LAYOUT_FILTER_TAG).toBe("");
  });

  it("preserves other env vars from baseEnv", () => {
    const env = buildShimEnv([], SHIM, { HOME: "/home/me", USER: "me", FOO: "bar" }, NAME);
    expect(env.HOME).toBe("/home/me");
    expect(env.USER).toBe("me");
    expect(env.FOO).toBe("bar");
  });

  it("strips undefined env values", () => {
    const env = buildShimEnv([], SHIM, { HOME: "/home/me", MISSING: undefined }, NAME);
    expect(env.HOME).toBe("/home/me");
    expect("MISSING" in env).toBe(false);
  });

  it("strips bash-internal vars (BASHOPTS, SHELLOPTS, etc.)", () => {
    const env = buildShimEnv([], SHIM, {
      BASHOPTS: "some:opts",
      SHELLOPTS: "braceexpand:emacs",
      BASH_ARGV: "foo",
      BASH_SOURCE: "bar",
      HOME: "/home/me",
    }, NAME);
    expect("BASHOPTS" in env).toBe(false);
    expect("SHELLOPTS" in env).toBe(false);
    expect("BASH_ARGV" in env).toBe(false);
    expect("BASH_SOURCE" in env).toBe(false);
    expect(env.HOME).toBe("/home/me");
  });

  it("overrides base TMUX if somehow already set", () => {
    const env = buildShimEnv([], SHIM, { TMUX: "should-be-overridden" }, NAME);
    expect(env.TMUX.startsWith("pty-layout,")).toBe(true);
  });

  it("overrides base TMUX_PANE if somehow already set", () => {
    const env = buildShimEnv([], SHIM, { TMUX_PANE: "%stale" }, NAME);
    expect(env.TMUX_PANE).toBe(`%${NAME}`);
  });

  it("overrides base PTY_LAYOUT_FILTER_TAG from base env", () => {
    const env = buildShimEnv(
      [{ key: "team", value: "alpha" }],
      SHIM,
      { PTY_LAYOUT_FILTER_TAG: "stale=value" },
      NAME,
    );
    expect(env.PTY_LAYOUT_FILTER_TAG).toBe("team=alpha");
  });

  it("output contains only string values (assignable to Record<string,string>)", () => {
    const env = buildShimEnv([{ key: "k", value: "v" }], SHIM, { PATH: "/usr/bin", X: undefined }, NAME);
    for (const [key, val] of Object.entries(env)) {
      expect(typeof val).toBe("string");
      expect(val === null).toBe(false);
      void key;
    }
  });

  describe("BASH_FUNC_tmux%%", () => {
    it("is set with an exported bash function body", () => {
      const env = buildShimEnv([], SHIM, {}, NAME);
      const funcBody = env["BASH_FUNC_tmux%%"];
      expect(funcBody).toBeDefined();
      expect(funcBody).toMatch(/^\(\) \{/);
      expect(funcBody).toMatch(/\}$/);
    });

    it("points at the absolute shim path", () => {
      const env = buildShimEnv([], SHIM, {}, NAME);
      const funcBody = env["BASH_FUNC_tmux%%"]!;
      expect(funcBody).toContain(`"${SHIM}/tmux"`);
    });

    it("passes through all arguments via $@", () => {
      const env = buildShimEnv([], SHIM, {}, NAME);
      const funcBody = env["BASH_FUNC_tmux%%"]!;
      expect(funcBody).toContain('"$@"');
    });

    it("function body contains a newline before closing brace", () => {
      const env = buildShimEnv([], SHIM, {}, NAME);
      const funcBody = env["BASH_FUNC_tmux%%"]!;
      expect(funcBody).toContain("\n}");
    });
  });
});
