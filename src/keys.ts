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

/** Capabilities the focused pane has currently advertised. Drives translation
 *  of input bytes that the outer terminal speaks but the pane wouldn't
 *  understand. Default is permissive (no translation) so existing callers
 *  and tests are unaffected. */
export interface PaneCaps {
  /** True if the pane has \e[?2004h active. False means strip
   *  \e[200~/\e[201~ markers before forwarding (the program reading stdin
   *  doesn't know about bracketed paste). */
  bracketedPaste: boolean;
  /** True if the pane has any kitty keyboard progressive-enhancement flags
   *  active. False means translate CSI u sequences to their legacy bytes
   *  (e.g. Ctrl+W → 0x17) before forwarding, so apps that don't speak the
   *  protocol see what they expect. */
  kittyKeyboardActive: boolean;
}

const PERMISSIVE_CAPS: PaneCaps = { bracketedPaste: true, kittyKeyboardActive: true };

// Keys that stay in prefix mode after executing (for repeated navigation).
// `m` stays active so the next keypress is interpreted as a move target.
const STICKY_KEYS = new Set([",", ".", "m", "l"]);

/** Translate a kitty CSI u key event to its legacy byte form, if a clean
 *  legacy form exists. Returns null when there's no obvious mapping (e.g.
 *  a special key with modifiers we don't have a legacy escape for) — the
 *  caller should forward the original CSI u verbatim in that case. */
function csiUToLegacy(codepoint: number, modifier: number): string | null {
  const mods = modifier - 1;
  const ctrl = !!(mods & 4);
  const alt = !!(mods & 2);
  const cp = codepoint;

  // No mods: just the char (codepoints are unicode scalar values).
  if (mods === 0) {
    if (cp >= 0x20 && cp < 0x10000) return String.fromCharCode(cp);
    return null;
  }

  // Alt only: ESC + char.
  if (alt && !ctrl) {
    if (cp >= 0x20 && cp < 0x10000) return "\x1b" + String.fromCharCode(cp);
    return null;
  }

  // Ctrl + letter: 0x01..0x1a.
  if (ctrl && !alt) {
    if (cp >= 0x61 && cp <= 0x7a) return String.fromCharCode(cp - 0x60);
    if (cp >= 0x41 && cp <= 0x5a) return String.fromCharCode(cp - 0x40);
    return null;
  }

  // Ctrl+Alt+letter: ESC + ctrl byte.
  if (ctrl && alt) {
    if (cp >= 0x61 && cp <= 0x7a) return "\x1b" + String.fromCharCode(cp - 0x60);
    if (cp >= 0x41 && cp <= 0x5a) return "\x1b" + String.fromCharCode(cp - 0x40);
    return null;
  }

  return null;
}

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

// Bytes from a previous processInput() call that looked like the start of
// a sequence we'd want to translate (CSI u or bracketed-paste marker) but
// arrived incomplete. Held across calls so OS-level read fragmentation
// during paste, etc. doesn't leak ESC garbage to the pane.
let pendingTail = "";

const PASTE_MARKERS = ["\x1b[200~", "\x1b[201~"];
const MAX_PENDING_TAIL = 32;

function isIncompletePasteMarker(s: string): boolean {
  if (s[0] !== "\x1b") return false;
  if (s.length < 2 || s[1] !== "[") return false;
  if (s.length >= 6) return false;
  return PASTE_MARKERS.some((m) => m.startsWith(s));
}

function isIncompleteCsiU(s: string): boolean {
  if (s[0] !== "\x1b") return false;
  if (s.length < 2 || s[1] !== "[") return false;
  if (s.length === 2) return true;
  for (let k = 2; k < s.length; k++) {
    const ch = s[k]!;
    if ((ch >= "0" && ch <= "9") || ch === ";" || ch === ":") continue;
    return false;
  }
  return true;
}

export function isPrefixPending(): boolean {
  return prefixPending;
}

export function setPrefixPending(value: boolean): void {
  prefixPending = value;
}

/** Test-only: clear any held bytes and the prefix flag. */
export function _resetKeyState(): void {
  prefixPending = false;
  pendingTail = "";
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
  paneCaps: PaneCaps = PERMISSIVE_CAPS,
): Action[] {
  const actions: Action[] = [];
  const incoming = data.toString("utf8");
  // Prepend any bytes held from a previous incomplete sequence.
  let str = pendingTail + incoming;
  pendingTail = "";
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

    // --- Bracketed paste markers ---
    // When the focused pane hasn't enabled \e[?2004h, strip \e[200~ /
    // \e[201~ before they reach a stdin-reading program that would
    // otherwise see them as garbage characters mixed into pasted content.
    if (
      !paneCaps.bracketedPaste &&
      str[i] === "\x1b" &&
      str[i + 1] === "[" &&
      str[i + 2] === "2" &&
      (str[i + 3] === "0") &&
      (str[i + 4] === "0" || str[i + 4] === "1") &&
      str[i + 5] === "~"
    ) {
      flush(i);
      i += 6;
      forwardStart = i;
      continue;
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
        // Not one of our keybindings. If the focused pane doesn't speak
        // CSI u, translate to a legacy byte form so the rest of the loop
        // (prefix-mode handling, ^]/^\ raw, plain forwarding) processes
        // it as if the user had typed the legacy form. Splice in place
        // and continue without advancing `i` so the new bytes are
        // re-evaluated from the top of the loop.
        if (!paneCaps.kittyKeyboardActive) {
          const legacy = csiUToLegacy(csiU.codepoint, csiU.modifier);
          if (legacy !== null) {
            str = str.slice(0, i) + legacy + str.slice(i + csiU.length);
            continue;
          }
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

  // Cross-call buffering: if the unflushed tail looks like the start of a
  // sequence we'd want to translate (CSI u when the pane has no kitty
  // keyboard, or a bracketed-paste marker when the pane has no bracketed
  // paste), hold it instead of flushing. Bounded by MAX_PENDING_TAIL so
  // we don't sit on bytes forever if the source goes silent.
  if (forwardStart < str.length) {
    let lastEsc = -1;
    for (let k = forwardStart; k < str.length; k++) {
      if (str[k] === "\x1b") lastEsc = k;
    }
    if (lastEsc >= 0 && str.length - lastEsc <= MAX_PENDING_TAIL) {
      const tail = str.slice(lastEsc);
      const wantHold =
        (!paneCaps.bracketedPaste && isIncompletePasteMarker(tail)) ||
        (!paneCaps.kittyKeyboardActive && isIncompleteCsiU(tail));
      if (wantHold) {
        if (lastEsc > forwardStart) write(str.slice(forwardStart, lastEsc));
        pendingTail = tail;
        return actions;
      }
    }
  }

  flush(str.length);
  return actions;
}
