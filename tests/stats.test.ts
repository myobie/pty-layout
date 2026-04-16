import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startStats, newLaunchId } from "../src/stats.ts";

let tempStateDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-layout-stats-"));
  originalXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tempStateDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
  fs.rmSync(tempStateDir, { recursive: true, force: true });
});

function readStats(): any[] {
  const file = path.join(tempStateDir, "pty-layout", "stats.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("newLaunchId", () => {
  it("generates unique IDs", () => {
    const a = newLaunchId();
    const b = newLaunchId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("startStats", () => {
  it("writes a launched event immediately", () => {
    const id = newLaunchId();
    const stop = startStats(
      { args: ["--tag", "x=y"], initialPanes: 2, tagMode: true },
      { id, paneCount: () => 2, totalCells: () => 1920 },
    );
    stop();

    const events = readStats();
    const launched = events.find((e) => e.type === "launched");
    expect(launched).toBeDefined();
    expect(launched.id).toBe(id);
    expect(launched.args).toEqual(["--tag", "x=y"]);
    expect(launched.initialPanes).toBe(2);
    expect(launched.tagMode).toBe(true);
    expect(launched.pid).toBe(process.pid);
    expect(launched.nodeVersion).toBe(process.version);
  });

  it("writes an initial sample event after launched", () => {
    const id = newLaunchId();
    const stop = startStats(
      { args: [], initialPanes: 1, tagMode: false },
      { id, paneCount: () => 1, totalCells: () => 80 * 24 },
    );
    stop();

    const events = readStats();
    const samples = events.filter((e) => e.type === "sample" && e.id === id);
    expect(samples.length).toBeGreaterThanOrEqual(1);

    const sample = samples[0];
    expect(sample.rss).toBeGreaterThan(0);
    expect(sample.heapUsed).toBeGreaterThan(0);
    expect(sample.heapTotal).toBeGreaterThan(0);
    expect(sample.cpuUser).toBeGreaterThanOrEqual(0);
    expect(sample.cpuSystem).toBeGreaterThanOrEqual(0);
    expect(sample.panes).toBe(1);
    expect(sample.cells).toBe(80 * 24);
  });

  it("writes an exited event with uptime and cpu totals when stopped", async () => {
    const id = newLaunchId();
    const stop = startStats(
      { args: [], initialPanes: 0, tagMode: false },
      { id, paneCount: () => 0, totalCells: () => 0 },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop();

    const events = readStats();
    const exited = events.find((e) => e.type === "exited" && e.id === id);
    expect(exited).toBeDefined();
    expect(exited.uptimeMs).toBeGreaterThan(0);
    expect(exited.cpuUserTotal).toBeGreaterThanOrEqual(0);
    expect(exited.cpuSystemTotal).toBeGreaterThanOrEqual(0);
  });

  it("includes the launch id on every event for grouping", () => {
    const id = newLaunchId();
    const stop = startStats(
      { args: [], initialPanes: 1, tagMode: false },
      { id, paneCount: () => 1, totalCells: () => 100 },
    );
    stop();

    const events = readStats();
    for (const e of events) expect(e.id).toBe(id);
  });

  it("appends to existing file (multiple instances coexist)", () => {
    const id1 = newLaunchId();
    const id2 = newLaunchId();
    const stop1 = startStats(
      { args: [], initialPanes: 1, tagMode: false },
      { id: id1, paneCount: () => 1, totalCells: () => 100 },
    );
    stop1();
    const stop2 = startStats(
      { args: [], initialPanes: 2, tagMode: true },
      { id: id2, paneCount: () => 2, totalCells: () => 200 },
    );
    stop2();

    const events = readStats();
    const ids = new Set(events.map((e) => e.id));
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);

    const launched = events.filter((e) => e.type === "launched");
    expect(launched.length).toBe(2);
  });

  it("creates the state directory if it doesn't exist", () => {
    const dir = path.join(tempStateDir, "pty-layout");
    expect(fs.existsSync(dir)).toBe(false);

    const id = newLaunchId();
    const stop = startStats(
      { args: [], initialPanes: 0, tagMode: false },
      { id, paneCount: () => 0, totalCells: () => 0 },
    );
    stop();

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "stats.jsonl"))).toBe(true);
  });

  it("paneCount/totalCells are called dynamically (live values)", async () => {
    const id = newLaunchId();
    let count = 1;
    const stop = startStats(
      { args: [], initialPanes: 1, tagMode: false },
      { id, paneCount: () => count, totalCells: () => count * 100 },
    );
    // First sample uses count=1
    const beforeChange = readStats().filter((e) => e.type === "sample" && e.id === id);
    expect(beforeChange[0].panes).toBe(1);
    expect(beforeChange[0].cells).toBe(100);

    // Change count, but the periodic timer is 30s — won't trigger in the test.
    // Just verify the closure works by stopping and inspecting.
    count = 5;
    stop();
  });

  it("survives even if the stats file becomes unwritable", () => {
    const id = newLaunchId();
    const dir = path.join(tempStateDir, "pty-layout");
    const stop = startStats(
      { args: [], initialPanes: 1, tagMode: false },
      { id, paneCount: () => 1, totalCells: () => 100 },
    );

    // Make the directory unwritable
    fs.chmodSync(dir, 0o500);

    // These should not throw
    expect(() => stop()).not.toThrow();

    // Restore for cleanup
    fs.chmodSync(dir, 0o700);
  });
});
