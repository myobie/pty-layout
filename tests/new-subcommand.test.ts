import { describe, it, expect } from "vitest";
import { parseNewSubcommand, parseFilterTagEnv } from "../src/new-subcommand.ts";

describe("parseNewSubcommand", () => {
  it("parses bare command after `--`", () => {
    expect(parseNewSubcommand(["--", "bash"])).toEqual({
      name: null, cwd: null, command: "bash", args: [],
    });
  });

  it("parses command + args after `--`", () => {
    expect(parseNewSubcommand(["--", "bash", "-c", "echo hi"])).toEqual({
      name: null, cwd: null, command: "bash", args: ["-c", "echo hi"],
    });
  });

  it("no args at all: command is null (caller picks default)", () => {
    expect(parseNewSubcommand([])).toEqual({
      name: null, cwd: null, command: null, args: [],
    });
  });

  it("bare command without `--` is tolerated", () => {
    // e.g. `pty-layout new htop`
    expect(parseNewSubcommand(["htop"])).toEqual({
      name: null, cwd: null, command: "htop", args: [],
    });
  });

  it("--name before `--` sets the session name", () => {
    expect(parseNewSubcommand(["--name", "task1", "--", "bash"])).toEqual({
      name: "task1", cwd: null, command: "bash", args: [],
    });
  });

  it("--cwd before `--` sets cwd", () => {
    expect(parseNewSubcommand(["--cwd", "/tmp", "--", "bash"])).toEqual({
      name: null, cwd: "/tmp", command: "bash", args: [],
    });
  });

  it("multiple flags compose", () => {
    expect(parseNewSubcommand(["--name", "x", "--cwd", "/a", "--", "cmd", "a", "b"])).toEqual({
      name: "x", cwd: "/a", command: "cmd", args: ["a", "b"],
    });
  });

  it("flags after `--` are treated as command args (not parsed)", () => {
    expect(parseNewSubcommand(["--", "bash", "-c", "--name=notaflag"])).toEqual({
      name: null, cwd: null, command: "bash", args: ["-c", "--name=notaflag"],
    });
  });

  it("throws on unknown flag before `--`", () => {
    expect(() => parseNewSubcommand(["--bogus", "--", "bash"])).toThrow(/unknown flag/);
  });

  it("flag without value throws (no silent treat-as-command)", () => {
    expect(() => parseNewSubcommand(["--name"])).toThrow(/unknown flag/);
    expect(() => parseNewSubcommand(["--cwd"])).toThrow(/unknown flag/);
  });
});

describe("parseFilterTagEnv", () => {
  it("empty string → empty map", () => {
    expect(parseFilterTagEnv("")).toEqual({});
  });

  it("single key=value", () => {
    expect(parseFilterTagEnv("team=alpha")).toEqual({ team: "alpha" });
  });

  it("multiple comma-separated (with spaces)", () => {
    expect(parseFilterTagEnv("team=alpha, env=dev")).toEqual({ team: "alpha", env: "dev" });
  });

  it("multiple without spaces", () => {
    expect(parseFilterTagEnv("team=alpha,env=dev")).toEqual({ team: "alpha", env: "dev" });
  });

  it("key-only tokens are skipped (no value to write)", () => {
    expect(parseFilterTagEnv("team, env=dev")).toEqual({ env: "dev" });
  });

  it("values can contain = signs", () => {
    expect(parseFilterTagEnv("url=http://x?y=1")).toEqual({ url: "http://x?y=1" });
  });

  it("handles the reserved layout key format", () => {
    expect(parseFilterTagEnv(":l12345-abcdef=1")).toEqual({ ":l12345-abcdef": "1" });
  });

  it("whitespace-only input yields empty map", () => {
    expect(parseFilterTagEnv("   ")).toEqual({});
    expect(parseFilterTagEnv(" , ")).toEqual({});
  });
});
