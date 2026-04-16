import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface LaunchInfo {
  args: string[];
  initialPanes: number;
  tagMode: boolean;
}

export interface StatsContext {
  id: string;
  paneCount: () => number;
  totalCells: () => number;
}

const SAMPLE_INTERVAL_MS = 30_000;

function getStatsPath(): string {
  const stateDir = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const dir = path.join(stateDir, "pty-layout");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "stats.jsonl");
}

function append(line: string): void {
  try {
    fs.appendFileSync(getStatsPath(), line + "\n");
  } catch {
    // Don't crash the app over stats logging
  }
}

function snapshot(ctx: StatsContext): Record<string, unknown> {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    ts: new Date().toISOString(),
    id: ctx.id,
    type: "sample",
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    cpuUser: cpu.user,
    cpuSystem: cpu.system,
    panes: ctx.paneCount(),
    cells: ctx.totalCells(),
  };
}

/**
 * Start periodic stats logging for this pty-layout instance.
 * Returns a function to call on shutdown.
 */
export function startStats(launch: LaunchInfo, ctx: StatsContext): () => void {
  const startTime = Date.now();
  const startCpu = process.cpuUsage();

  append(JSON.stringify({
    ts: new Date().toISOString(),
    id: ctx.id,
    type: "launched",
    pid: process.pid,
    args: launch.args,
    initialPanes: launch.initialPanes,
    tagMode: launch.tagMode,
    nodeVersion: process.version,
    platform: process.platform,
  }));

  // Initial sample immediately so we have a baseline
  append(JSON.stringify(snapshot(ctx)));

  const timer = setInterval(() => {
    append(JSON.stringify(snapshot(ctx)));
  }, SAMPLE_INTERVAL_MS);
  // Don't keep the process alive just for stats
  timer.unref();

  return () => {
    clearInterval(timer);
    const cpu = process.cpuUsage(startCpu);
    append(JSON.stringify({
      ts: new Date().toISOString(),
      id: ctx.id,
      type: "exited",
      uptimeMs: Date.now() - startTime,
      cpuUserTotal: cpu.user,
      cpuSystemTotal: cpu.system,
    }));
  };
}

export function newLaunchId(): string {
  return crypto.randomUUID();
}
