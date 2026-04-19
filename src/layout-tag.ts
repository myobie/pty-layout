import { type TagFilter } from "./tag-subscription.ts";
import { randomBytes } from "node:crypto";

/** Regex matching the layout-tag key shape. Must stay in sync with
 *  pty's `pruneOrphanLayoutTags` pattern — if pty-layout crashes,
 *  `pty gc` uses this same shape to prune orphan tags. */
export const LAYOUT_TAG_KEY_RE = /^:l(\d+)-[a-z0-9]+$/;

/** Random 8-char lowercase alphanumeric suffix. Matches the pattern
 *  the picker uses for new session names. */
function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars[bytes[i]! % chars.length];
  }
  return out;
}

/** Build the per-layout reserved tag key `:l<pid>-<rand>`. */
export function newLayoutTagKey(pid: number = process.pid): string {
  return `:l${pid}-${randomSuffix()}`;
}

/** Render the layout identity for the status bar. Auto-tag mode: short
 *  [suffix] so the user can tell instances apart without seeing the
 *  internal PID/prefix. Explicit --tag mode: [key=value] (or key-only). */
export function formatLayoutBadge(filters: TagFilter[], autoKey: string | null): string {
  if (autoKey) {
    const m = autoKey.match(/-([a-z0-9]+)$/);
    return `[${m ? m[1] : autoKey}]`;
  }
  if (filters.length === 0) return "";
  const s = filters
    .map(f => f.value !== undefined ? `${f.key}=${f.value}` : f.key)
    .join(",");
  return `[${s}]`;
}
