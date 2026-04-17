import { type TagFilter, parseTagFilter } from "./tag-subscription.ts";
import { randomBytes } from "node:crypto";

/** Pure, side-effect-free logic for the `tmux` shim. The runner in
 *  `shim/tmux-main.ts` converts a ShimPlan into process.stdout/stderr
 *  writes and child_process spawns.
 *
 *  Supported tmux surface (scoped to what Claude Code's agent-teams uses):
 *  - split-window / new-window: spawn a new pty session with the layout's tags
 *  - send-keys: translate keys to `pty send --seq`
 *  - display-message -p: print pane id
 *  - list-panes: list matching sessions
 *  - kill-pane: kill a session by id
 *
 *  Pane id format: pty session name prefixed with `%`.
 *  That matches tmux's pane id shape (`%N`) well enough for tools that
 *  parse `-P` output, and our `-t %xxx` parsing just strips the prefix.
 */

export const PANE_ID_PREFIX = "%";

export function randomSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars[bytes[i]! % chars.length];
  }
  return out;
}

export interface ShimEnv {
  PTY_LAYOUT_FILTER_TAG?: string;
  PTY_SESSION?: string;
  /** Set by buildShimEnv on picker-spawned shells, and by the shim's
   *  own split-window wrapper for teammates. Claude Code reads this
   *  directly before falling back to `tmux display-message`. */
  TMUX_PANE?: string;
  /** User's login shell (e.g. /bin/zsh). Used when Claude Code calls
   *  `split-window` with no command — real tmux spawns the user's shell
   *  by default, and we must do the same. */
  SHELL?: string;
  /** Absolute path to the shim directory. Used to construct shell init
   *  arguments when spawning a teammate's default shell. */
  PTY_LAYOUT_SHIM_DIR?: string;
}

/** Translation result. Runner executes `spawn` (if set) then prints. */
export type ShimPlan =
  | { kind: "error"; message: string; exitCode: number }
  | { kind: "print"; stdout?: string; stderr?: string; exitCode: number }
  | {
      kind: "spawn";
      /** argv to pass to `pty`. Runner resolves the `pty` binary. */
      ptyArgv: string[];
      /** Text printed to stdout AFTER the spawn succeeds. */
      postPrint?: string;
      /** If set, runner captures pty's stdout and transforms it before
       *  forwarding. Used for `list-panes` reformatting. */
      transformStdout?: "list-panes";
      /** Stored format string for list-panes (runner consumes). */
      listPanesFormat?: string;
    };

// ---------- Tag filter serialization ----------

/** Parse the PTY_LAYOUT_FILTER_TAG env var back into filters.
 *  Format produced by `formatTagFilters`: "k=v, k2=v2" (comma-space separator). */
export function parseFilterEnv(raw: string | undefined): TagFilter[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseTagFilter(s));
}

/** Convert filters to `--filter-tag key=value` argv fragments (for pty list). */
export function filtersToListArgs(filters: TagFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (f.value === undefined) continue;
    out.push("--filter-tag", `${f.key}=${f.value}`);
  }
  return out;
}

/** Convert filters to `--tag key=value` argv fragments (for pty run). */
export function filtersToRunTagArgs(filters: TagFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (f.value === undefined) continue;
    out.push("--tag", `${f.key}=${f.value}`);
  }
  return out;
}

// ---------- Pane id conversion ----------

/** Extract a pty session name from any tmux `-t` target form:
 *  - `%abc` → `abc` (canonical pane id)
 *  - `abc` → `abc` (bare)
 *  - `session:window.pane` where pane starts with `%` → pane part without `%`
 *  - `session:window.pane` where pane is numeric → the session part (our
 *    session_name IS the pty session name, indices are always "0")
 *  - `session:window` → session part
 *  - `session` → session part
 *
 *  This mirrors how real tmux accepts many target forms. Since our model
 *  maps each pty session to a tmux "session" where the only pane is
 *  identified uniquely by the session name, all of these forms resolve
 *  to the same underlying pty session name.
 */
export function stripPaneIdPrefix(target: string): string {
  if (target.startsWith(PANE_ID_PREFIX)) return target.slice(PANE_ID_PREFIX.length);
  // session:window.pane form
  const colonIdx = target.indexOf(":");
  if (colonIdx !== -1) {
    const session = target.slice(0, colonIdx);
    const after = target.slice(colonIdx + 1);
    const dotIdx = after.indexOf(".");
    const paneRef = dotIdx !== -1 ? after.slice(dotIdx + 1) : "";
    // If pane ref is a %<id>, it's the authoritative pane identifier
    if (paneRef.startsWith(PANE_ID_PREFIX)) return paneRef.slice(1);
    // Otherwise the session name IS our pty session name
    return session;
  }
  return target;
}

export function toPaneId(sessionName: string): string {
  return `${PANE_ID_PREFIX}${sessionName}`;
}

// ---------- Key translation (tmux -> pty `--seq`) ----------

/** Map tmux key tokens to pty's `key:` names.
 *  Case-insensitive; returns null if the token isn't a known named key. */
const TMUX_KEY_MAP: Record<string, string> = {
  enter: "return",
  return: "return",
  tab: "tab",
  escape: "escape",
  esc: "escape",
  space: "space",
  bspace: "backspace",
  backspace: "backspace",
  btab: "shift+tab",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  ppage: "pageup",
  pageup: "pageup",
  npage: "pagedown",
  pagedown: "pagedown",
  dc: "delete",
  delete: "delete",
};

/** Translate a single tmux send-keys token into a `--seq` value.
 *  - `Enter`, `Up`, etc → `key:return`, `key:up`
 *  - `C-c`, `M-x`, `S-F1`, `C-M-a` → `key:ctrl+c` etc
 *  - anything else → literal text (sent verbatim via --seq)
 */
export function translateKeyToken(token: string): string {
  const modMatch = token.match(/^((?:[CMS]-)+)(.+)$/);
  if (modMatch) {
    const modPrefix = modMatch[1]!;
    const rest = modMatch[2]!;
    const mods: string[] = [];
    const modTokens = modPrefix.match(/[CMS]-/g) ?? [];
    for (const m of modTokens) {
      if (m === "C-") mods.push("ctrl");
      else if (m === "M-") mods.push("alt");
      else if (m === "S-") mods.push("shift");
    }
    const lower = rest.toLowerCase();
    const base = TMUX_KEY_MAP[lower];
    if (base) {
      // If the mapped key already encodes shift (e.g. btab = shift+tab),
      // fold our extra modifiers with a simple prefix — pty's resolveKey
      // handles duplicate modifier names by deduping via a Set.
      return `key:${[...mods, base].join("+")}`;
    }
    // Bare letter with modifiers: `C-c`, `M-x`
    if (rest.length === 1) {
      return `key:${[...mods, rest.toLowerCase()].join("+")}`;
    }
    // Unknown modified token — fall back to literal text (so send-keys
    // still delivers *something* rather than silently dropping).
    return token;
  }

  const lower = token.toLowerCase();
  const mapped = TMUX_KEY_MAP[lower];
  if (mapped) return `key:${mapped}`;

  // Literal text — sent as-is through --seq.
  return token;
}

// ---------- Argv helpers ----------

/** Split argv at `--`. Returns [before, after] where `after` is the
 *  trailing command if present, else `null`. */
export function splitDoubleDash(argv: string[]): { flags: string[]; cmd: string[] | null } {
  const i = argv.indexOf("--");
  if (i === -1) return { flags: argv.slice(), cmd: null };
  return { flags: argv.slice(0, i), cmd: argv.slice(i + 1) };
}

/** Extract a flag with a value: `-t value` or `-tvalue`. Returns `{value, rest}`.
 *  If the flag isn't present, returns `{value: null, rest: argv}`. */
export function extractFlag(argv: string[], short: string): { value: string | null; rest: string[] } {
  const out: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (value === null && a === short && i + 1 < argv.length) {
      value = argv[i + 1]!;
      i++;
      continue;
    }
    if (value === null && a.startsWith(short) && a.length > short.length && short.length === 2) {
      value = a.slice(short.length);
      continue;
    }
    out.push(a);
  }
  return { value, rest: out };
}

/** Remove a bare flag (no value). Returns `{present, rest}`. */
export function extractBoolFlag(argv: string[], short: string): { present: boolean; rest: string[] } {
  const out: string[] = [];
  let present = false;
  for (const a of argv) {
    if (!present && a === short) {
      present = true;
      continue;
    }
    out.push(a);
  }
  return { present, rest: out };
}

// ---------- Subcommand planners ----------

export interface PlanContext {
  env: ShimEnv;
  /** Deterministic session id generator (for tests). Default: randomSessionId. */
  sessionId: () => string;
}

function requireFilter(env: ShimEnv): TagFilter[] | { error: ShimPlan } {
  const filters = parseFilterEnv(env.PTY_LAYOUT_FILTER_TAG);
  const usable = filters.filter((f) => f.value !== undefined);
  if (usable.length === 0) {
    return {
      error: {
        kind: "error",
        message:
          "pty-layout tmux shim: PTY_LAYOUT_FILTER_TAG is empty or has no key=value tags.\n" +
          "Start pty-layout with `--tmux --tag key=value` so the shim knows which tag to spawn sessions with.",
        exitCode: 1,
      },
    };
  }
  return usable;
}

/** Return the basename of a shell path (e.g. `/bin/zsh` → `zsh`). */
function shellBasename(shell: string): string {
  const slash = shell.lastIndexOf("/");
  return slash === -1 ? shell : shell.slice(slash + 1);
}

/** Build the argv that spawns the user's default shell, with PATH-fix
 *  wrappers so `tmux` (via execvp) resolves to our shim even after the
 *  user's rc reorders PATH. Used when `split-window` / `new-window` is
 *  invoked with no command after `--` (real tmux default behavior).
 *
 *  Per-shell strategy:
 *    bash → --rcfile <shim>/shell-init/bashrc  (user's bash binary!)
 *    zsh  → ZDOTDIR=<shim>/shell-init
 *    fish → spawn directly (no inject path; relies on env PATH surviving)
 *    other → spawn directly
 */
export function defaultShellArgv(ctx: PlanContext): string[] {
  const shell = (ctx.env.SHELL && ctx.env.SHELL.length > 0) ? ctx.env.SHELL : "/bin/bash";
  const shimDir = ctx.env.PTY_LAYOUT_SHIM_DIR;
  const base = shellBasename(shell);

  if (shimDir && base === "zsh") {
    return ["/usr/bin/env", `ZDOTDIR=${shimDir}/shell-init`, shell];
  }
  if (shimDir && base === "bash") {
    // Use the user's bash binary (could be Homebrew's bash 5.x). Apple's
    // /bin/bash 3.2.57 fails to load modern bash_completion.
    return [shell, "--rcfile", `${shimDir}/shell-init/bashrc`, "-i"];
  }
  // fish and unknown shells: no wrapper, run the user's shell directly.
  return [shell];
}

export function planSplitOrNewWindow(args: string[], ctx: PlanContext): ShimPlan {
  const split = splitDoubleDash(args);

  let rest = split.flags;
  const cwdExtract = extractFlag(rest, "-c");
  rest = cwdExtract.rest;
  const nameExtract = extractFlag(rest, "-n");
  rest = nameExtract.rest;
  const printExtract = extractBoolFlag(rest, "-P");
  rest = printExtract.rest;
  const formatExtract = extractFlag(rest, "-F");
  rest = formatExtract.rest;
  // Ignore: -h, -v, -d, -t (all positional-in-layout concepts that don't
  // apply to pty-layout's auto-layout of tagged sessions).
  const tFlag = extractFlag(rest, "-t");
  rest = tFlag.rest;
  const ignoredBool = ["-h", "-v", "-d"];
  for (const f of ignoredBool) {
    const r = extractBoolFlag(rest, f);
    rest = r.rest;
  }

  const filtersOrError = requireFilter(ctx.env);
  if ("error" in filtersOrError) return filtersOrError.error;
  const filters = filtersOrError;

  const name = ctx.sessionId();
  const ptyArgv = ["run", "-d", "--name", name];
  if (cwdExtract.value) ptyArgv.push("--cwd", cwdExtract.value);
  for (const f of filters) {
    ptyArgv.push("--tag", `${f.key}=${f.value}`);
  }

  // Real tmux: `split-window` with no command spawns the user's default
  // shell. Agent-teams relies on this — it creates a shell and then
  // send-keys the teammate command into it. If no cmd given, default to
  // the user's shell with our PATH-fix wrappers so the teammate's tmux
  // invocations (via execvp) resolve to our shim.
  //
  // In either case, wrap with `/usr/bin/env TMUX_PANE=%<new-id>` so the
  // teammate's env reports its OWN pane id, not the parent's. Claude
  // Code reads $TMUX_PANE directly before falling back to the shim.
  const cmd = split.cmd && split.cmd.length > 0
    ? split.cmd
    : defaultShellArgv(ctx);

  ptyArgv.push("--", "/usr/bin/env", `TMUX_PANE=${toPaneId(name)}`, ...cmd);

  const paneId = toPaneId(name);
  let postPrint: string | undefined;
  if (printExtract.present) {
    postPrint = formatOutput(formatExtract.value, { paneId, sessionName: name, windowName: nameExtract.value }) + "\n";
  }

  return { kind: "spawn", ptyArgv, postPrint };
}

/** Apply tmux format substitutions we support. Missing fields → empty. */
export function formatOutput(
  format: string | null,
  fields: { paneId?: string; sessionName?: string; windowName?: string | null },
): string {
  if (!format) return fields.paneId ?? "";
  // pty-layout has one-pane-per-session, so window/pane indices are
  // always 0. Returning "0" (not an empty string) is deliberate: tools
  // like Claude Code's Agent tool parse `session:window.pane` and abort
  // if any component is missing.
  //
  // Any token NOT in this table becomes empty string — better than
  // passing through literally, which would make parsers fail when they
  // see `#{pane_current_path}` in a field they expected to be a path.
  const paneId = fields.paneId ?? "";
  const sessionName = fields.sessionName ?? "";
  const windowName = fields.windowName ?? "";
  return format
    // Long forms first (most specific tokens)
    .replace(/#\{pane_id\}/g, paneId)
    .replace(/#\{pane_pid\}/g, "")
    .replace(/#\{pane_index\}/g, "0")
    .replace(/#\{pane_tty\}/g, "")
    .replace(/#\{pane_current_path\}/g, "")
    .replace(/#\{pane_current_command\}/g, "")
    .replace(/#\{pane_width\}/g, "")
    .replace(/#\{pane_height\}/g, "")
    .replace(/#\{window_id\}/g, "@0")
    .replace(/#\{window_index\}/g, "0")
    .replace(/#\{window_name\}/g, windowName)
    .replace(/#\{session_id\}/g, sessionName ? `$${sessionName}` : "")
    .replace(/#\{session_name\}/g, sessionName)
    // Any remaining #{...} token → empty string (avoid literal leakage)
    .replace(/#\{[^}]+\}/g, "")
    // Short forms (single-letter after #)
    .replace(/#D/g, paneId)
    .replace(/#S/g, sessionName)
    .replace(/#W/g, windowName)
    .replace(/#I/g, "0")
    .replace(/#P/g, "0")
    .replace(/#T/g, ""); // pane title
}

export function planSendKeys(args: string[], ctx: PlanContext): ShimPlan {
  let rest = args.slice();
  const tExtract = extractFlag(rest, "-t");
  rest = tExtract.rest;
  const literal = extractBoolFlag(rest, "-l");
  rest = literal.rest;
  // Consume & ignore: -R (reset), -H (hex), -N (repeat-count flag needs value)
  const rExtract = extractBoolFlag(rest, "-R");
  rest = rExtract.rest;
  const hExtract = extractBoolFlag(rest, "-H");
  rest = hExtract.rest;
  const nExtract = extractFlag(rest, "-N");
  rest = nExtract.rest;
  // -X <cmd> is unsupported (invokes tmux commands inside a pane)
  const xExtract = extractFlag(rest, "-X");
  if (xExtract.value !== null) {
    return {
      kind: "error",
      message: `tmux shim: \`send-keys -X ${xExtract.value}\` is not supported (no internal command layer).`,
      exitCode: 1,
    };
  }
  rest = xExtract.rest;

  if (!tExtract.value) {
    return {
      kind: "error",
      message: "tmux shim: send-keys requires `-t <pane-id>`.",
      exitCode: 1,
    };
  }

  if (rest.length === 0) {
    return {
      kind: "error",
      message: "tmux shim: send-keys needs at least one key or text argument.",
      exitCode: 1,
    };
  }

  const sessionName = stripPaneIdPrefix(tExtract.value);
  const seqArgs: string[] = [];
  for (const token of rest) {
    const seq = literal.present ? token : translateKeyToken(token);
    seqArgs.push("--seq", seq);
  }

  const ptyArgv = ["send", sessionName, ...seqArgs];
  return { kind: "spawn", ptyArgv };
}

export function planDisplayMessage(args: string[], ctx: PlanContext): ShimPlan {
  let rest = args.slice();
  const printFlag = extractBoolFlag(rest, "-p");
  rest = printFlag.rest;
  // Ignore -t target, -c client, -F format (use positional if given)
  const tExtract = extractFlag(rest, "-t");
  rest = tExtract.rest;
  const cExtract = extractFlag(rest, "-c");
  rest = cExtract.rest;
  const fExtract = extractFlag(rest, "-F");
  rest = fExtract.rest;

  const format = fExtract.value ?? rest[0] ?? null;
  const sessionName = ctx.env.PTY_SESSION ?? "";
  // Prefer TMUX_PANE (set by buildShimEnv / split-window wrapper) over
  // deriving from PTY_SESSION — they should agree, but TMUX_PANE is the
  // authoritative source Claude Code itself reads.
  const paneId = ctx.env.TMUX_PANE ?? (sessionName ? toPaneId(sessionName) : "");
  const text = formatOutput(format, { paneId, sessionName });

  if (printFlag.present || !format) {
    return { kind: "print", stdout: text + "\n", exitCode: 0 };
  }
  // Without -p, tmux would display in the status line. With no status
  // line of our own, printing to stdout is the most useful fallback.
  return { kind: "print", stdout: text + "\n", exitCode: 0 };
}

export function planListPanes(args: string[], ctx: PlanContext): ShimPlan {
  let rest = args.slice();
  const fExtract = extractFlag(rest, "-F");
  rest = fExtract.rest;
  // Ignore -a, -s, -t: we list every session matching our filter tags.
  const aExtract = extractBoolFlag(rest, "-a");
  rest = aExtract.rest;
  const sExtract = extractBoolFlag(rest, "-s");
  rest = sExtract.rest;
  const tExtract = extractFlag(rest, "-t");
  rest = tExtract.rest;

  const filtersOrError = requireFilter(ctx.env);
  if ("error" in filtersOrError) return filtersOrError.error;
  const filters = filtersOrError;

  const ptyArgv = ["list", "--json", ...filtersToListArgs(filters)];
  return {
    kind: "spawn",
    ptyArgv,
    transformStdout: "list-panes",
    listPanesFormat: fExtract.value ?? "",
  };
}

/** Reformat `pty list --json` output as tmux list-panes would.
 *  Exported for unit testing; the runner calls this on pty's stdout. */
export function formatListPanesOutput(ptyJson: string, format: string): string {
  let sessions: Array<{
    name: string;
    status: string;
    pid?: number | null;
    command?: string | null;
    cwd?: string | null;
    displayName?: string;
  }>;
  try {
    sessions = JSON.parse(ptyJson);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const s of sessions) {
    if (s.status !== "running") continue;
    const paneId = toPaneId(s.name);
    const line = format
      ? format
          .replace(/#\{pane_id\}/g, paneId)
          .replace(/#\{pane_pid\}/g, s.pid != null ? String(s.pid) : "")
          .replace(/#\{pane_index\}/g, "0")
          .replace(/#\{window_index\}/g, "0")
          .replace(/#\{pane_current_command\}/g, s.command ?? "")
          .replace(/#\{pane_current_path\}/g, s.cwd ?? "")
          .replace(/#\{session_name\}/g, s.name)
          .replace(/#\{window_name\}/g, s.displayName ?? s.name)
          .replace(/#D/g, paneId)
          .replace(/#S/g, s.name)
          .replace(/#I/g, "0")
          .replace(/#P/g, "0")
      : `${paneId}: ${s.command ?? ""} [${s.cwd ?? ""}]`;
    lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function planKillPane(args: string[], ctx: PlanContext): ShimPlan {
  let rest = args.slice();
  const tExtract = extractFlag(rest, "-t");
  rest = tExtract.rest;
  const aExtract = extractBoolFlag(rest, "-a");
  rest = aExtract.rest;

  if (!tExtract.value) {
    return {
      kind: "error",
      message: "tmux shim: kill-pane requires `-t <pane-id>`.",
      exitCode: 1,
    };
  }

  const sessionName = stripPaneIdPrefix(tExtract.value);
  return { kind: "spawn", ptyArgv: ["kill", sessionName] };
}

// ---------- Top-level dispatcher ----------

/** Strip global tmux flags that some callers prepend (-L socket name, -S
 *  socket path, -f config, -C command mode). We have no server/socket
 *  concept so these are meaningless — just drop them. */
export function stripGlobalFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "-L" || a === "-S" || a === "-f") && i + 1 < argv.length) {
      i++;
      continue;
    }
    if (a === "-C" || a === "-CC" || a === "-v" || a === "-vv" || a === "-u" || a === "-2") {
      continue;
    }
    if (a === "-V" || a === "--version") {
      out.push("--__version__");
      continue;
    }
    out.push(a);
  }
  return out;
}

export function planShim(argv: string[], ctx: PlanContext): ShimPlan {
  const stripped = stripGlobalFlags(argv);
  if (stripped.length === 0) {
    return {
      kind: "error",
      message: "tmux shim: missing subcommand.",
      exitCode: 1,
    };
  }
  // Version probe — real tmux prints e.g. "tmux 3.6a". Tools parse this
  // to feature-detect, so return a real-looking modern version.
  if (stripped[0] === "--__version__") {
    return { kind: "print", stdout: "tmux 3.6a\n", exitCode: 0 };
  }
  const [sub, ...rest] = stripped;
  switch (sub) {
    case "split-window":
    case "splitw":
    case "new-window":
    case "neww":
      return planSplitOrNewWindow(rest, ctx);
    case "send-keys":
    case "send":
      return planSendKeys(rest, ctx);
    case "display-message":
    case "display":
    case "displaym":
      return planDisplayMessage(rest, ctx);
    case "list-panes":
    case "lsp":
    case "list-windows":
    case "lsw":
      return planListPanes(rest, ctx);
    case "kill-pane":
    case "killp":
      return planKillPane(rest, ctx);
    // Common subcommands tools probe for but don't need to do anything
    // meaningful. Return success so they don't abort.
    case "has-session":
    case "has":
      return { kind: "print", exitCode: 0 };
    case "new-session":
      // Claude Code sometimes calls new-session with -d to ensure a
      // session exists. Treat as no-op — we're always "inside" one.
      return { kind: "print", exitCode: 0 };
    case "set-option":
    case "set":
    case "set-window-option":
    case "setenv":
    case "set-environment":
    case "setw":
    case "select-pane":
    case "selectp":
    case "select-window":
    case "selectw":
    case "rename-window":
    case "renamew":
    case "rename-session":
    case "rename":
    case "set-hook":
    case "select-layout":
    case "selectl":
    case "resize-pane":
    case "resizep":
    case "capture-pane":
    case "capturep":
    case "pipe-pane":
    case "pipep":
    case "copy-mode":
    case "paste-buffer":
    case "pasteb":
    // Cleanup subcommands — we don't have server/session cleanup semantics,
    // but if Claude Code or a tool calls these, the right answer is "OK,
    // done." (Real tmux would kill things; we have nothing to kill.)
    case "kill-session":
    case "kill-server":
    case "kill-window":
    case "killw":
      return { kind: "print", exitCode: 0 };
    case "show-options":
    case "show":
    case "showenv":
    case "show-environment":
    // Listing subcommands that real tmux would populate — returning empty
    // is safer than erroring. Tools that parse the output will see zero
    // matches instead of a failure.
    case "list-sessions":
    case "ls":
    case "list-clients":
    case "lsc":
    case "list-buffers":
    case "lsb":
    case "show-buffer":
    case "showb":
      return { kind: "print", stdout: "", exitCode: 0 };
    default:
      return {
        kind: "error",
        message: `tmux shim: subcommand "${sub}" is not implemented.`,
        exitCode: 1,
      };
  }
}
