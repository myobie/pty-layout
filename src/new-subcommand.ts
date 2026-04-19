/** Argv + env parsing for `pty-layout new`. Pure — no I/O, no spawn.
 *  Exported for unit testing; the runner in main.ts wraps this with
 *  spawnDaemon and stdio. */

export interface NewSubcommandArgs {
  name: string | null;
  cwd: string | null;
  command: string | null;
  args: string[];
}

/** Parse `pty-layout new [--name N] [--cwd C] [-- cmd args...]`.
 *  Throws on unknown flags. */
export function parseNewSubcommand(argv: string[]): NewSubcommandArgs {
  let name: string | null = null;
  let cwd: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--name" && i + 1 < argv.length) {
      name = argv[i + 1]!;
      i += 2;
      continue;
    }
    if (a === "--cwd" && i + 1 < argv.length) {
      cwd = argv[i + 1]!;
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(
        `pty-layout new: unknown flag "${a}". ` +
        `Usage: pty-layout new [--name N] [--cwd C] [-- cmd args...]`,
      );
    }
    // Bare positional before `--` — treat as start of command
    break;
  }
  const rest = argv.slice(i);
  const command = rest[0] ?? null;
  const args = rest.slice(1);
  return { name, cwd, command, args };
}

/** Parse the `PTY_LAYOUT_FILTER_TAG` env format (`"k=v, k2=v2"`) into a
 *  tags map suitable for `spawnDaemon({ tags })`. Key-only tokens are
 *  skipped — they have no concrete value to apply. */
export function parseFilterTagEnv(filterEnv: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tok of filterEnv.split(",").map(s => s.trim()).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    tags[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return tags;
}
