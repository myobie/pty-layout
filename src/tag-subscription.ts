import { EventFollower, listSessions, type EventRecord } from "@myobie/pty/client";

export interface TagFilter {
  key: string;
  value?: string; // undefined = key-exists match
}

export interface TagSubscriptionCallbacks {
  onAdd: (sessionName: string) => void;
  onRemove: (sessionName: string) => void;
}

export function parseTagFilter(arg: string): TagFilter {
  const eq = arg.indexOf("=");
  if (eq === -1) return { key: arg };
  return { key: arg.slice(0, eq), value: arg.slice(eq + 1) };
}

export function matchesTags(
  filters: TagFilter[],
  tags: Record<string, string> | undefined,
): boolean {
  if (filters.length === 0) return false;
  if (!tags) return false;
  return filters.every((f) =>
    f.value !== undefined ? tags[f.key] === f.value : f.key in tags,
  );
}

export function formatTagFilters(filters: TagFilter[]): string {
  return filters.map((f) => (f.value !== undefined ? `${f.key}=${f.value}` : f.key)).join(", ");
}

export class TagSubscription {
  private filters: TagFilter[];
  private callbacks: TagSubscriptionCallbacks;
  private tracked = new Set<string>();
  private follower: EventFollower;
  /** Check if a session is hidden (provided by the consumer). */
  isHidden: (sessionName: string) => boolean = () => false;

  constructor(filters: TagFilter[], callbacks: TagSubscriptionCallbacks) {
    this.filters = filters;
    this.callbacks = callbacks;
    this.follower = new EventFollower({
      onEvent: (event: EventRecord) => this.handleEvent(event),
    });
  }

  /** Start watching. Returns names of existing matching sessions. */
  async start(): Promise<string[]> {
    // Start follower FIRST so there's no gap between listing and watching
    this.follower.start();

    const sessions = await listSessions();
    const matching = sessions.filter(
      (s) => s.status === "running" && matchesTags(this.filters, s.metadata?.tags),
    );
    const names: string[] = [];
    for (const s of matching) {
      if (!this.tracked.has(s.name)) {
        this.tracked.add(s.name);
        names.push(s.name);
      }
    }
    return names;
  }

  stop(): void {
    this.follower.stop();
  }

  /** Track a session that was added externally (e.g. via Ctrl+] n). */
  track(sessionName: string): void {
    this.tracked.add(sessionName);
  }

  /** Untrack a session (e.g. when hidden). */
  untrack(sessionName: string): void {
    this.tracked.delete(sessionName);
  }

  private handleEvent(event: EventRecord): void {
    if (event.type === "session_start") {
      const { session, tags } = event;
      if (
        matchesTags(this.filters, tags) &&
        !this.tracked.has(session) &&
        !this.isHidden(session)
      ) {
        this.tracked.add(session);
        this.callbacks.onAdd(session);
      }
    } else if (event.type === "session_exit") {
      if (this.tracked.has(event.session)) {
        this.tracked.delete(event.session);
        this.callbacks.onRemove(event.session);
      }
    }
  }
}
