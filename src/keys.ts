import { positionKeyToIndex } from "./positions.ts";

export interface Action {
  type:
    | "cycleLayout"
    | "focusIndex"
    | "focusPrev"
    | "focusNext"
    | "newShell"
    | "closePane"
    | "movePane"
    | "detach"
    | "quit"
    | "mouseDown"
    | "mouseDrag"
    | "mouseUp"
    | "scrollUp"
    | "scrollDown";
  index?: number;
  row?: number;
  col?: number;
  /** Mouse modifier: shift held. Used for shift-click to extend a
   *  selection beyond what a single drag can cover. */
  shift?: boolean;
}

// Keys that stay in prefix mode after executing (for repeated navigation).
// `m` stays active so the next keypress is interpreted as a move target.
const STICKY_KEYS = new Set([",", ".", "m", "l"]);

const COMMAND_MAP: Record<string, Action> = {
  l: { type: "cycleLayout" },
  n: { type: "newShell" },
  w: { type: "closePane" },
  q: { type: "quit" },
  m: { type: "movePane" }, // Enters move mode; next position key picks target
  ",": { type: "focusPrev" },
  ".": { type: "focusNext" },
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

/**
 * Parse a CSI u sequence for our keybindings: ESC [ codepoint ; modifier u
 * Only matches Ctrl+] (93;5) and Ctrl+\ (92;5).
 */
function parseCsiU(
  str: string,
  start: number,
): { codepoint: number; modifier: number; length: number } | null {
  if (str[start] !== "\x1b" || str[start + 1] !== "[") return null;
  let j = start + 2;

  let codepoint = 0;
  const cpStart = j;
  while (j < str.length && str[j]! >= "0" && str[j]! <= "9") {
    codepoint = codepoint * 10 + (str.charCodeAt(j) - 0x30);
    j++;
  }
  if (j === cpStart) return null;

  // Skip optional :alternate_codepoints
  while (j < str.length && str[j] === ":") {
    j++;
    while (j < str.length && str[j]! >= "0" && str[j]! <= "9") j++;
  }

  let modifier = 1;
  if (j < str.length && str[j] === ";") {
    j++;
    modifier = 0;
    const modStart = j;
    while (j < str.length && str[j]! >= "0" && str[j]! <= "9") {
      modifier = modifier * 10 + (str.charCodeAt(j) - 0x30);
      j++;
    }
    if (j === modStart) return null;

    // Skip optional :event_type
    if (j < str.length && str[j] === ":") {
      j++;
      while (j < str.length && str[j]! >= "0" && str[j]! <= "9") j++;
    }
  }

  if (j >= str.length || str[j] !== "u") return null;
  j++;

  return { codepoint, modifier, length: j - start };
}

// Ctrl+] prefix state
let prefixPending = false;

export function isPrefixPending(): boolean {
  return prefixPending;
}

export function setPrefixPending(value: boolean): void {
  prefixPending = value;
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
        const isMotion = !!(mouse.button & 32);
        const shift = !!(mouse.button & 4);
        const baseButton = mouse.button & 3;
        // Only include `shift` when true so existing tests that match
        // action objects without it aren't broken.
        const mods = shift ? { shift: true } : {};

        if (isScroll) {
          actions.push({
            type: baseButton === 0 ? "scrollUp" : "scrollDown",
            row: mouse.row,
            col: mouse.col,
            ...mods,
          });
        } else if (isMotion && baseButton === 0 && mouse.press) {
          actions.push({ type: "mouseDrag", row: mouse.row, col: mouse.col, ...mods });
        } else if (!isMotion && baseButton === 0 && mouse.press) {
          actions.push({ type: "mouseDown", row: mouse.row, col: mouse.col, ...mods });
        } else if (!isMotion && baseButton === 0 && !mouse.press) {
          actions.push({ type: "mouseUp", row: mouse.row, col: mouse.col, ...mods });
        }

        i += mouse.length;
        forwardStart = i;
        continue;
      }
    }

    // --- CSI u keybindings (kitty keyboard protocol) ---
    // When the kitty keyboard protocol is active, Ctrl+] and Ctrl+\ are
    // encoded as CSI u sequences instead of raw control characters.
    if (str[i] === "\x1b" && i + 1 < str.length && str[i + 1] === "[") {
      const csiU = parseCsiU(str, i);
      if (csiU) {
        const hasCtrl = !!((csiU.modifier - 1) & 4);
        if (hasCtrl && csiU.codepoint === 0x5d) {
          // Ctrl+] via CSI u
          flush(i);
          i += csiU.length;
          forwardStart = i;
          if (prefixPending) {
            prefixPending = false; // Ctrl+] again cancels prefix
          } else {
            prefixPending = true;
          }
          continue;
        }
        if (hasCtrl && csiU.codepoint === 0x5c) {
          // Ctrl+\ via CSI u
          flush(i);
          actions.push({ type: "detach" });
          i += csiU.length;
          forwardStart = i;
          continue;
        }
      }
    }

    // --- Prefix mode: consume keys as commands ---
    if (prefixPending) {
      // Kitty-encoded Esc (`\x1b[27u` or `\x1b[27;<mod>u`): treat like a
      // bare Esc — cancel prefix and consume the whole sequence. Without
      // this, the Esc sequence leaks through to the focused pane when
      // the pane has kitty keyboard protocol active and pty-layout is
      // proxying the flags to the outer terminal.
      if (str[i] === "\x1b" && i + 1 < str.length && str[i + 1] === "[") {
        const csiU = parseCsiU(str, i);
        if (csiU && csiU.codepoint === 27) {
          prefixPending = false;
          flush(i);
          i += csiU.length;
          forwardStart = i;
          continue;
        }
      }

      const code = str.charCodeAt(i);

      // Ctrl+] again: cancel prefix
      if (code === 0x1d) {
        prefixPending = false;
        flush(i);
        i++;
        forwardStart = i;
        continue;
      }

      // Escape: cancel prefix. Consume a BARE ESC so it never leaks to
      // the pane when the user hits Esc to dismiss the modal. BUT if
      // the ESC is the start of a CSI sequence (ESC[...), leave it
      // intact — those are arrow keys, function keys, or bracketed
      // paste markers that we need to forward unchanged.
      if (code === 0x1b) {
        prefixPending = false;
        const isCsiStart = i + 1 < str.length && str[i + 1] === "[";
        if (!isCsiStart) {
          flush(i);
          i++;
          forwardStart = i;
        }
        continue;
      }

      // Try command map
      const key = str[i]!;
      let action = COMMAND_MAP[key] ?? COMMAND_MAP[key.toLowerCase()];

      // If not a command, maybe it's a position key (digit or letter)
      if (!action) {
        const posIdx = positionKeyToIndex(key);
        if (posIdx !== null) {
          action = { type: "focusIndex", index: posIdx };
        }
      }

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
