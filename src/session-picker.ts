import { listSessions } from "@myobie/pty/tui";
import { spawn } from "node:child_process";
import { type TagFilter, matchesTags } from "./tag-subscription.ts";
import { fuzzyMatch } from "./fuzzy.ts";

export interface PickerItem {
  type: "create-local" | "create-remote" | "local" | "remote";
  label: string;
  detail?: string;
  sessionName?: string;
  sessionDisplayName?: string;
  relayUrl?: string;
  hostLabel?: string; // "local" or the relay host label
  /** For scoring: name, cwd, command as separate fields */
  name?: string;
  cwd?: string;
  command?: string;
  running?: boolean;
}

export interface PickerGroup {
  title: string;
  items: PickerItem[];
}

export interface PickerState {
  allGroups: PickerGroup[];     // unfiltered (sessions only, no create items)
  relayHosts: RelayHost[];      // stored for host filtering
  localSessions: SessionData[]; // stored for rebuilding
  tagFilters: TagFilter[];      // stored for rebuilding
  groups: PickerGroup[];        // filtered + create items added back
  flatItems: PickerItem[];      // flattened filtered items
  selectedIndex: number;
  filter: string;
  loading: boolean;
}

interface SessionData {
  name: string;
  displayName?: string;
  status: string;
  command?: string;
  cwd?: string;
  tags?: Record<string, string>;
}

/** Format a session label: prefer displayName, fall back to name.
 *  Show name in parens when both are set and differ. */
export function formatSessionLabel(name: string, displayName?: string): string {
  if (!displayName || displayName === name) return name;
  return `${displayName} (${name})`;
}

/** Build a pty-relay connect URL for a specific remote session.
 *  The base URL may have a fragment (secret) — session name must be
 *  inserted BEFORE the fragment, not appended after. Mirrors pty's
 *  interactive list logic so behavior stays consistent. */
export function buildRemoteConnectUrl(baseUrl: string, sessionName: string): string {
  const hashIdx = baseUrl.indexOf("#");
  if (hashIdx === -1) return `${baseUrl}/${sessionName}`;
  const before = baseUrl.slice(0, hashIdx);
  const after = baseUrl.slice(hashIdx); // includes the '#'
  return `${before}/${sessionName}${after}`;
}

interface RelayHost {
  label: string;
  url: string;
  sessions: SessionData[];
  spawn_enabled: boolean;
  error: string | null;
}

export function createPickerState(): PickerState {
  return {
    allGroups: [],
    relayHosts: [],
    localSessions: [],
    tagFilters: [],
    groups: [],
    flatItems: [],
    selectedIndex: 0,
    filter: "",
    loading: true,
  };
}

/** Generate a random 8-char lowercase alphanumeric session id, matching
 *  pty's interactive "Create new session" format. */
export function randomSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Score and sort session items by fuzzy match — same logic as pty's filterAndSort. */
function filterAndSort(filter: string, items: PickerItem[]): PickerItem[] {
  if (!filter) return items;
  const matches: { item: PickerItem; score: number }[] = [];
  for (const item of items) {
    // Skip create items during filter
    if (item.type === "create-local" || item.type === "create-remote") continue;

    const name = item.name ?? item.label;
    const cwd = item.cwd ?? "";
    const cmd = item.command ?? "";

    const nameResult = fuzzyMatch(filter, name);
    const cwdResult = fuzzyMatch(filter, cwd);
    const cmdResult = fuzzyMatch(filter, cmd);
    if (!nameResult.match && !cwdResult.match && !cmdResult.match) continue;

    const runningBonus = item.running ? 100000 : 0;
    const score = runningBonus + Math.max(
      nameResult.match ? nameResult.score + 10000 : 0,
      cwdResult.match ? cwdResult.score : 0,
      cmdResult.match ? cmdResult.score : 0,
    );
    matches.push({ item, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.map((m) => m.item);
}

/** Build filtered groups — matches pty's buildFilteredGroups logic. */
function buildFilteredGroups(
  filter: string,
  localSessions: SessionData[],
  relayHosts: RelayHost[],
  tagFilters: TagFilter[],
): { groups: PickerGroup[]; flatItems: PickerItem[] } {
  // Parse "host/session" filter syntax
  let hostFilter = "";
  let sessionFilter = filter;
  if (filter.includes("/")) {
    const slashIdx = filter.indexOf("/");
    hostFilter = filter.slice(0, slashIdx).trim();
    sessionFilter = filter.slice(slashIdx + 1).trim();
  }

  const showCreate = !filter || "new".startsWith(filter.toLowerCase());
  const groups: PickerGroup[] = [];
  const flatItems: PickerItem[] = [];

  // Local group — skip if host filter doesn't match "local"
  if (!hostFilter || fuzzyMatch(hostFilter, "local").match) {
    const localItems: PickerItem[] = [];
    for (const s of localSessions) {
      if (s.status !== "running") continue;
      if (tagFilters.length > 0 && !matchesTags(tagFilters, s.tags)) continue;
      localItems.push({
        type: "local",
        label: formatSessionLabel(s.name, s.displayName),
        detail: [s.cwd, s.command].filter(Boolean).join("  "),
        sessionName: s.name,
        sessionDisplayName: s.displayName,
        hostLabel: "local",
        // name is used for fuzzy search — include both displayName and name
        name: s.displayName ? `${s.displayName} ${s.name}` : s.name,
        cwd: s.cwd,
        command: s.command,
        running: s.status === "running",
      });
    }

    const filtered = sessionFilter ? filterAndSort(sessionFilter, localItems) : localItems;
    const createItem: PickerItem = { type: "create-local", label: "+ New session" };
    const items = showCreate ? [createItem, ...filtered] : filtered;
    if (items.length > 0) {
      groups.push({ title: "Local", items });
      flatItems.push(...items);
    }
  }

  // Remote groups
  for (const host of relayHosts) {
    if (host.error) continue;
    if (hostFilter && !fuzzyMatch(hostFilter, host.label).match) continue;

    const remoteItems: PickerItem[] = [];
    for (const s of host.sessions) {
      if (s.status !== "running") continue;
      if (tagFilters.length > 0 && !matchesTags(tagFilters, s.tags)) continue;
      remoteItems.push({
        type: "remote",
        label: formatSessionLabel(s.name, s.displayName),
        detail: [s.cwd, s.command].filter(Boolean).join("  "),
        sessionName: s.name,
        sessionDisplayName: s.displayName,
        relayUrl: host.url,
        hostLabel: host.label,
        name: s.displayName ? `${s.displayName} ${s.name}` : s.name,
        cwd: s.cwd,
        command: s.command,
        running: s.status === "running",
      });
    }

    const filtered = sessionFilter ? filterAndSort(sessionFilter, remoteItems) : remoteItems;
    const items: PickerItem[] = [...filtered];
    if (host.spawn_enabled && showCreate) {
      items.unshift({ type: "create-remote", label: "+ New session", relayUrl: host.url, hostLabel: host.label });
    }
    if (items.length > 0 || !filter) {
      groups.push({ title: host.label, items });
      flatItems.push(...items);
    }
  }

  return { groups, flatItems };
}

export function filterPicker(state: PickerState, newFilter: string): PickerState {
  const { groups, flatItems } = buildFilteredGroups(
    newFilter, state.localSessions, state.relayHosts, state.tagFilters,
  );
  return {
    ...state,
    filter: newFilter,
    groups,
    flatItems,
    selectedIndex: Math.min(state.selectedIndex, Math.max(0, flatItems.length - 1)),
  };
}

export function moveSelection(state: PickerState, delta: number): PickerState {
  if (state.flatItems.length === 0) return state;
  const newIndex = Math.max(0, Math.min(state.flatItems.length - 1, state.selectedIndex + delta));
  return { ...state, selectedIndex: newIndex };
}

export async function refreshPicker(
  tagFilters: TagFilter[],
  onUpdate: (state: PickerState) => void,
): Promise<void> {
  // Fetch local sessions immediately
  const sessions = await listSessions();
  const localSessions: SessionData[] = sessions.map((s) => ({
    name: s.name,
    displayName: s.metadata?.displayName,
    status: s.status,
    command: s.metadata?.displayCommand,
    cwd: s.metadata?.cwd,
    tags: s.metadata?.tags,
  }));

  const { groups, flatItems } = buildFilteredGroups("", localSessions, [], tagFilters);
  onUpdate({
    allGroups: [],
    localSessions,
    relayHosts: [],
    tagFilters,
    groups,
    flatItems,
    selectedIndex: 0,
    filter: "",
    loading: true,
  });

  // Fetch relay hosts async
  const relayHosts = await fetchRelayHosts();
  const filtered = buildFilteredGroups("", localSessions, relayHosts, tagFilters);
  onUpdate({
    allGroups: [],
    localSessions,
    relayHosts,
    tagFilters,
    groups: filtered.groups,
    flatItems: filtered.flatItems,
    selectedIndex: 0,
    filter: "",
    loading: false,
  });
}

function fetchRelayHosts(): Promise<RelayHost[]> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("pty-relay", ["ls", "--json"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("close", () => {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve([]); }
      });
      proc.on("error", () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}
