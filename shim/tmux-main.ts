import { spawnSync } from "node:child_process";
import { planShim, formatListPanesOutput, randomSessionId, type ShimPlan } from "../src/tmux-shim.ts";

function resolvePtyBin(): string {
  return process.env.PTY_BIN || "pty";
}

function runPlan(plan: ShimPlan): number {
  if (plan.kind === "error") {
    process.stderr.write(plan.message + "\n");
    return plan.exitCode;
  }
  if (plan.kind === "print") {
    if (plan.stdout) process.stdout.write(plan.stdout);
    if (plan.stderr) process.stderr.write(plan.stderr);
    return plan.exitCode;
  }

  // plan.kind === "spawn"
  // Always capture pty's stdout — the shim controls what reaches the
  // caller. pty CLI messages like "Session ... created." must not
  // pollute the tmux-compatible output surface.
  const bin = resolvePtyBin();
  const result = spawnSync(bin, plan.ptyArgv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    process.stderr.write(`tmux shim: failed to exec pty: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    // Forward pty's stderr so the caller sees the real error
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status ?? 1;
  }

  if (plan.transformStdout === "list-panes") {
    const out = formatListPanesOutput(result.stdout ?? "", plan.listPanesFormat ?? "");
    process.stdout.write(out);
  }

  if (plan.postPrint) {
    process.stdout.write(plan.postPrint);
  }

  return 0;
}

const plan = planShim(process.argv.slice(2), {
  env: {
    PTY_LAYOUT_FILTER_TAG: process.env.PTY_LAYOUT_FILTER_TAG,
    PTY_SESSION: process.env.PTY_SESSION,
    TMUX_PANE: process.env.TMUX_PANE,
    SHELL: process.env.SHELL,
    PTY_LAYOUT_SHIM_DIR: process.env.PTY_LAYOUT_SHIM_DIR,
  },
  sessionId: randomSessionId,
});

process.exit(runPlan(plan));
