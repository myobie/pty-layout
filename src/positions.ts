/** Keys used by prefix commands — these letters cannot double as position keys. */
export const COMMAND_LETTERS = new Set(["l", "n", "w", "q", "m"]);

/** List of lowercase letters usable as position keys (a..z minus command letters). */
const POSITION_LETTERS: string[] = (() => {
  const out: string[] = [];
  for (let c = "a".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    if (!COMMAND_LETTERS.has(ch)) out.push(ch);
  }
  return out;
})();

/** Maximum number of positions we can address by keyboard (9 digits + usable letters). */
export const MAX_POSITIONS = 9 + POSITION_LETTERS.length;

/** Convert a 0-indexed pane position to its keyboard key label.
 *  Positions 0..8 → "1".."9", positions 9+ → letter skipping command letters.
 *  Returns null for positions beyond MAX_POSITIONS. */
export function indexToPositionKey(index: number): string | null {
  if (index < 0) return null;
  if (index < 9) return String(index + 1);
  const letterIdx = index - 9;
  return POSITION_LETTERS[letterIdx] ?? null;
}

/** Convert a keyboard key to a 0-indexed pane position.
 *  "1".."9" → 0..8, letter → 9+. Returns null if key is not a valid position key. */
export function positionKeyToIndex(key: string): number | null {
  if (key.length !== 1) return null;
  if (key >= "1" && key <= "9") return key.charCodeAt(0) - "1".charCodeAt(0);
  const lower = key.toLowerCase();
  const idx = POSITION_LETTERS.indexOf(lower);
  if (idx === -1) return null;
  return 9 + idx;
}
