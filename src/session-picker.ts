import { listSessions } from "@myobie/pty/tui";
import { spawn } from "node:child_process";
import { type TagFilter, matchesTags } from "./tag-subscription.ts";

export interface PickerItem {
  type: "create-local" | "create-remote" | "local" | "remote";
  label: string;
  detail?: string;
  sessionName?: string;
  relayUrl?: string;
}

export interface PickerGroup {
  title: string;
  items: PickerItem[];
}

export interface PickerState {
  allGroups: PickerGroup[];     // unfiltered
  groups: PickerGroup[];        // filtered
  flatItems: PickerItem[];      // flattened filtered items
  selectedIndex: number;
  filter: string;
  loading: boolean;
}

interface RelayHost {
  label: string;
  url: string;
  sessions: { name: string; status: string; command?: string; cwd?: string; tags?: Record<string, string> }[];
  spawn_enabled: boolean;
  error: string | null;
}

export function createPickerState(): PickerState {
  return {
    allGroups: [],
    groups: [],
    flatItems: [],
    selectedIndex: 0,
    filter: "",
    loading: true,
  };
}

export function autoSessionName(existingNames: Set<string>): string {
  const base = `layout-shell-${Date.now()}`;
  if (!existingNames.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

function fuzzyMatch(text: string, pattern: string): boolean {
  if (pattern.length === 0) return true;
  const lower = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  let pi = 0;
  for (let i = 0; i < lower.length && pi < lowerPattern.length; i++) {
    if (lower[i] === lowerPattern[pi]) pi++;
  }
  return pi === lowerPattern.length;
}

function itemMatchesFilter(item: PickerItem, filter: string): boolean {
  if (filter.length === 0) return true;
  if (item.type === "create-local" || item.type === "create-remote") {
    // Only match on "new", not the full label text
    return fuzzyMatch("new", filter);
  }
  return fuzzyMatch(item.label, filter) || fuzzyMatch(item.detail ?? "", filter);
}

function applyFilter(allGroups: PickerGroup[], filter: string): { groups: PickerGroup[]; flatItems: PickerItem[] } {
  const groups: PickerGroup[] = [];
  const flatItems: PickerItem[] = [];

  for (const group of allGroups) {
    const filtered = group.items.filter((item) => itemMatchesFilter(item, filter));
    if (filtered.length > 0) {
      groups.push({ title: group.title, items: filtered });
      flatItems.push(...filtered);
    }
  }

  return { groups, flatItems };
}

export function filterPicker(state: PickerState, newFilter: string): PickerState {
  const { groups, flatItems } = applyFilter(state.allGroups, newFilter);
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

function buildGroups(
  localSessions: { name: string; status: string; command?: string; cwd?: string; tags?: Record<string, string> }[],
  relayHosts: RelayHost[],
  tagFilters: TagFilter[],
): PickerGroup[] {
  const groups: PickerGroup[] = [];

  // Local group
  const localItems: PickerItem[] = [];
  localItems.push({ type: "create-local", label: "+ New session" });
  for (const s of localSessions) {
    if (s.status !== "running") continue;
    if (tagFilters.length > 0 && !matchesTags(tagFilters, s.tags)) continue;
    localItems.push({
      type: "local",
      label: s.name,
      detail: [s.cwd, s.command].filter(Boolean).join("  "),
      sessionName: s.name,
    });
  }
  groups.push({ title: "Local", items: localItems });

  // Remote groups
  for (const host of relayHosts) {
    if (host.error) continue;
    const items: PickerItem[] = [];
    if (host.spawn_enabled) {
      items.push({ type: "create-remote", label: "+ New session", relayUrl: host.url });
    }
    for (const s of host.sessions) {
      if (s.status !== "running") continue;
      if (tagFilters.length > 0 && !matchesTags(tagFilters, s.tags)) continue;
      items.push({
        type: "remote",
        label: s.name,
        detail: [s.cwd, s.command].filter(Boolean).join("  "),
        sessionName: s.name,
        relayUrl: host.url,
      });
    }
    if (items.length > 0) {
      groups.push({ title: host.label, items });
    }
  }

  return groups;
}

export async function refreshPicker(
  tagFilters: TagFilter[],
  onUpdate: (state: PickerState) => void,
): Promise<void> {
  // Fetch local sessions immediately
  const sessions = await listSessions();
  const localSessions = sessions.map((s) => ({
    name: s.name,
    status: s.status,
    command: s.metadata?.displayCommand,
    cwd: s.metadata?.cwd,
    tags: s.metadata?.tags,
  }));

  const localGroups = buildGroups(localSessions, [], tagFilters);
  const { groups, flatItems } = applyFilter(localGroups, "");
  onUpdate({
    allGroups: localGroups,
    groups,
    flatItems,
    selectedIndex: 0,
    filter: "",
    loading: true,
  });

  // Fetch relay hosts async
  const relayHosts = await fetchRelayHosts();
  const allGroups = buildGroups(localSessions, relayHosts, tagFilters);
  const filtered = applyFilter(allGroups, "");
  onUpdate({
    allGroups,
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
