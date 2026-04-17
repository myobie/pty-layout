import * as path from "node:path";
import { type TagFilter, formatTagFilters } from "./tag-subscription.ts";

/** Env vars that bash uses internally and that can confuse a child bash
 *  when inherited verbatim (wrong BASHOPTS, stale BASH_ARGV, etc.). */
const BASH_INTERNAL_VARS = new Set([
  "BASHOPTS", "BASH_ARGV", "BASH_ARGV0", "BASH_ARGC",
  "BASH_COMMAND", "BASH_EXECUTION_STRING", "BASH_LINENO",
  "BASH_REMATCH", "BASH_SOURCE", "BASH_SUBSHELL", "SHELLOPTS",
  "COMP_WORDBREAKS",
]);

/** Build the env dict for a picker-spawned shell when `--tmux` mode is on.
 *
 *  Returns a `Record<string, string>` (no undefined values) suitable for
 *  passing directly to `spawnDaemon({ env })` or `createPty({ env })`,
 *  both of which take the dict verbatim (no inheritance).
 *
 *  - `TMUX` — non-empty value so tmux-aware tools detect an active
 *    session. Real tmux sets this to a socket path + session + id tuple.
 *  - `TMUX_PANE=%<sessionName>` — unique-per-pane identifier. This is
 *    load-bearing: Claude Code's agent-teams probe reads `$TMUX_PANE`
 *    *directly* from the shell env before falling back to
 *    `tmux display-message`. Without it the probe fails with "Could not
 *    determine current tmux pane/window".
 *  - `PTY_LAYOUT_FILTER_TAG` carries the layout's tag filter so the shim
 *    can spawn sessions that the layout will auto-pick-up.
 *  - `PATH` has `shimDir` prepended so `tmux` invocations land on our shim.
 *  - `BASH_FUNC_tmux%%` defines a bash exported function pointing at the
 *    shim via absolute path — this survives profile PATH rewrites (macOS
 *    path_helper, Homebrew shellenv, etc.) because bash functions take
 *    priority over PATH lookups.
 *  - `PTY_LAYOUT_SHIM_DIR` stores the absolute shim dir for manual use.
 */
export function buildShimEnv(
  filterTags: TagFilter[],
  shimDir: string,
  baseEnv: NodeJS.ProcessEnv,
  sessionName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string" && !BASH_INTERNAL_VARS.has(k)) out[k] = v;
  }
  // Shaped like a real tmux TMUX env var (<socket>,<pid>,<id>) so tools
  // that try to parse it don't choke. Content is cosmetic — Claude Code
  // only checks that it's non-empty.
  out.TMUX = `pty-layout,${process.pid},0`;
  out.TMUX_PANE = `%${sessionName}`;
  out.PTY_LAYOUT_FILTER_TAG = filterTags.length > 0 ? formatTagFilters(filterTags) : "";
  out.PTY_LAYOUT_SHIM_DIR = shimDir;
  const prevPath = typeof baseEnv.PATH === "string" ? baseEnv.PATH : "";
  out.PATH = prevPath.length > 0 ? `${shimDir}:${prevPath}` : shimDir;

  // Bash exported function — takes priority over PATH, survives init-file
  // PATH rewrites. The %%-suffixed env var is how bash imports functions.
  const absShim = path.resolve(shimDir, "tmux");
  out["BASH_FUNC_tmux%%"] = `() {  "${absShim}" "$@"\n}`;

  return out;
}
