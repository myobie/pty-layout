import { createPty, attachPty, spawnDaemon, getSession, type PtyHandle } from "@myobie/pty/tui";

export interface Pane {
  id: number;
  handle: PtyHandle;
  title: string;
  source:
    | { type: "local"; command: string; args: string[] }
    | { type: "session"; name: string };
}

let nextId = 1;

/**
 * Create a new daemon session and attach to it.
 * The session survives if the layout detaches.
 */
export async function createSessionPane(
  command: string,
  args: string[],
  tags?: Record<string, string>,
  env?: Record<string, string>,
): Promise<Pane> {
  const basename = command.split("/").pop() ?? command;
  const name = `layout-${basename}-${Date.now()}`;
  const displayCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;

  await spawnDaemon({ name, command, args, displayCommand, tags, ...(env ? { env } : {}) });
  const handle = await attachPty(name, { cols: 80, rows: 24, scrollback: 10000 });

  return {
    id: nextId++,
    handle,
    title: name,
    source: { type: "session", name },
  };
}

/**
 * Attach to an existing named pty daemon session.
 */
export async function createAttachPane(name: string): Promise<Pane> {
  const handle = await attachPty(name, { cols: 80, rows: 24, scrollback: 10000 });
  // Prefer displayName for the title; fall back to name
  let title = `@${name}`;
  try {
    const info = await getSession(name);
    const displayName = info?.metadata?.displayName;
    if (displayName && displayName !== name) {
      title = `@${displayName} (${name})`;
    }
  } catch {}
  return {
    id: nextId++,
    handle,
    title,
    source: { type: "session", name },
  };
}

/**
 * Spawn a local child process (dies when layout exits).
 * Used for the pty interactive UI and CLI-arg commands.
 */
export function createLocalPane(
  command: string,
  args: string[],
  titleOverride?: string,
  env?: Record<string, string>,
): Pane {
  const handle = createPty(command, args, {
    cols: 80,
    rows: 24,
    scrollback: 10000,
    ...(env ? { env } : {}),
  });
  const basename = command.split("/").pop() ?? command;
  const title = titleOverride ?? (args.length > 0 ? `${basename} ${args.join(" ")}` : basename);
  return {
    id: nextId++,
    handle,
    title,
    source: { type: "local", command, args },
  };
}

export function closePane(pane: Pane): void {
  pane.handle.kill();
}

export function defaultShell(): string {
  return process.env.SHELL || "/bin/sh";
}
