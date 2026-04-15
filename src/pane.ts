import { createPty, attachPty, spawnDaemon, type PtyHandle } from "@myobie/pty/tui";

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
): Promise<Pane> {
  const basename = command.split("/").pop() ?? command;
  const name = `layout-${basename}-${Date.now()}`;
  const displayCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;

  await spawnDaemon({ name, command, args, displayCommand, tags });
  const handle = await attachPty(name, { cols: 80, rows: 24 });

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
  const handle = await attachPty(name, { cols: 80, rows: 24 });
  return {
    id: nextId++,
    handle,
    title: `@${name}`,
    source: { type: "session", name },
  };
}

/**
 * Spawn a local child process (dies when layout exits).
 * Used for the pty interactive UI and CLI-arg commands.
 */
export function createLocalPane(command: string, args: string[]): Pane {
  const handle = createPty(command, args, { cols: 80, rows: 24, scrollback: 1000 });
  const basename = command.split("/").pop() ?? command;
  return {
    id: nextId++,
    handle,
    title: args.length > 0 ? `${basename} ${args.join(" ")}` : basename,
    source: { type: "local", command, args },
  };
}

export function closePane(pane: Pane): void {
  pane.handle.kill();
}

export function defaultShell(): string {
  return process.env.SHELL || "/bin/sh";
}
