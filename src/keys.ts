export interface Action {
  type:
    | "cycleLayout"
    | "focusIndex"
    | "focusPrev"
    | "focusNext"
    | "newShell"
    | "newPty"
    | "closePane"
    | "detach"
    | "mouseDown"
    | "scrollUp"
    | "scrollDown";
  index?: number;
  row?: number;
  col?: number;
}

// Keys that stay in prefix mode after executing (for repeated navigation)
const STICKY_KEYS = new Set([",", "."]);

const COMMAND_MAP: Record<string, Action> = {
  l: { type: "cycleLayout" },
  n: { type: "newShell" },
  p: { type: "newPty" },
  w: { type: "closePane" },
  ",": { type: "focusPrev" },
  ".": { type: "focusNext" },
  "1": { type: "focusIndex", index: 0 },
  "2": { type: "focusIndex", index: 1 },
  "3": { type: "focusIndex", index: 2 },
  "4": { type: "focusIndex", index: 3 },
  "5": { type: "focusIndex", index: 4 },
  "6": { type: "focusIndex", index: 5 },
  "7": { type: "focusIndex", index: 6 },
  "8": { type: "focusIndex", index: 7 },
  "9": { type: "focusIndex", index: 8 },
};

/**
 * Parse an SGR extended mouse sequence: ESC [ < button ; col ; row M/m
 */
function parseSgrMouse(
  str: string,
  start: number,
): { button: number; col: number; row: number; press: boolean; length: number } | null {
  if (str[start] !== "\x1b" || str[start + 1] !== "[" || str[start + 2] !== "<")
    return null;
  let j = start + 3;

  let button = 0;
  const btnStart = j;
  while (j < str.length && str[j]! >= "0" && str[j]! <= "9") {
    button = button * 10 + (str.charCodeAt(j) - 0x30);
    j++;
  }
  if (j === btnStart || j >= str.length || str[j] !== ";") return null;
  j++;

  let col = 0;
  const colStart = j;
  while (j < str.length && str[j]! >= "0" && str[j]! <= "9") {
    col = col * 10 + (str.charCodeAt(j) - 0x30);
    j++;
  }
  if (j === colStart || j >= str.length || str[j] !== ";") return null;
  j++;

  let row = 0;
  const rowStart = j;
  while (j < str.length && str[j]! >= "0" && str[j]! <= "9") {
    row = row * 10 + (str.charCodeAt(j) - 0x30);
    j++;
  }
  if (j === rowStart || j >= str.length) return null;

  if (str[j] !== "M" && str[j] !== "m") return null;
  const press = str[j] === "M";
  j++;

  return { button, col, row, press, length: j - start };
}

// Ctrl+] prefix state
let prefixPending = false;

export function isPrefixPending(): boolean {
  return prefixPending;
}

/**
 * Process raw input bytes. Detects commands via:
 *   1. Ctrl+] prefix key (next keypress is a command)
 *   2. Ctrl+\ for detach
 * Sticky keys (,/.) stay in prefix mode for repeated navigation.
 * All non-command bytes are forwarded to the writer function verbatim,
 * preserving escape sequences, UTF-8, and paste.
 */
export function processInput(
  data: Buffer,
  write: (s: string) => void,
): Action[] {
  const actions: Action[] = [];
  const str = data.toString("utf8");
  let i = 0;
  let forwardStart = 0;

  function flush(end: number) {
    if (end > forwardStart) {
      write(str.slice(forwardStart, end));
    }
  }

  while (i < str.length) {
    // --- SGR mouse events: handle regardless of prefix state ---
    if (
      str[i] === "\x1b" &&
      i + 2 < str.length &&
      str[i + 1] === "[" &&
      str[i + 2] === "<"
    ) {
      const mouse = parseSgrMouse(str, i);
      if (mouse) {
        flush(i);
        if (prefixPending) prefixPending = false;

        const isScroll = !!(mouse.button & 64);
        const baseButton = mouse.button & 3;

        if (isScroll) {
          actions.push({
            type: baseButton === 0 ? "scrollUp" : "scrollDown",
            row: mouse.row,
            col: mouse.col,
          });
        } else if (mouse.press && baseButton === 0) {
          actions.push({ type: "mouseDown", row: mouse.row, col: mouse.col });
        }

        i += mouse.length;
        forwardStart = i;
        continue;
      }
    }

    // --- Prefix mode: consume keys as commands ---
    if (prefixPending) {
      const code = str.charCodeAt(i);

      // Ctrl+] again: cancel prefix
      if (code === 0x1d) {
        prefixPending = false;
        flush(i);
        i++;
        forwardStart = i;
        continue;
      }

      // Escape: cancel prefix
      if (code === 0x1b) {
        prefixPending = false;
        if (i + 1 >= str.length) {
          // Bare Escape: consume it
          flush(i);
          i++;
          forwardStart = i;
        }
        // ESC + more bytes: don't consume, let the sequence forward
        continue;
      }

      // Try command map
      const key = str[i]!;
      const action = COMMAND_MAP[key] ?? COMMAND_MAP[key.toLowerCase()];
      flush(i);
      i++;
      forwardStart = i;
      if (action) {
        actions.push(action);
        if (!STICKY_KEYS.has(key) && !STICKY_KEYS.has(key.toLowerCase())) {
          prefixPending = false;
        }
      } else {
        // Unrecognized key: consume and exit prefix
        prefixPending = false;
      }
      continue;
    }

    // --- Normal mode ---

    // Ctrl+] (0x1d) = enter prefix mode
    if (str.charCodeAt(i) === 0x1d) {
      flush(i);
      i++;
      forwardStart = i;
      prefixPending = true;
      continue;
    }

    // Ctrl+\ (0x1c) = detach
    if (str.charCodeAt(i) === 0x1c) {
      flush(i);
      actions.push({ type: "detach" });
      i++;
      forwardStart = i;
      continue;
    }

    i++;
  }

  flush(str.length);
  return actions;
}
