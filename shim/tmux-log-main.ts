import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname_log = path.dirname(fileURLToPath(import.meta.url));
const logPath = process.env.TMUX_SHIM_LOG ?? "/tmp/pty-layout-tmux-shim.log";

const entry = {
  ts: new Date().toISOString(),
  argv: process.argv.slice(2),
  env: {
    TMUX: process.env.TMUX,
    PTY_SESSION: process.env.PTY_SESSION,
    PTY_LAYOUT_FILTER_TAG: process.env.PTY_LAYOUT_FILTER_TAG,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
  },
  cwd: process.cwd(),
};
try {
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
} catch (err) {
  process.stderr.write(`tmux-log: failed to write ${logPath}: ${(err as Error).message}\n`);
}

const realShim = path.resolve(__dirname_log, "tmux-main.ts");
const result = spawnSync("node", ["--experimental-strip-types", "--no-warnings", realShim, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
