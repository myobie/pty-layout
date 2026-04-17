/** Per-pane scroll tracking state. */
export interface ScrollState {
  /** Lines back from the current viewport baseY. 0 = following live. */
  offset: number;
  /** The baseY value from the last time we updated this state. */
  lastBaseY: number;
}

/** Adjust offset so the same absolute lines stay in view when baseY advances.
 *
 *  - If offset is 0 (following live), stays 0 and just tracks the new baseY.
 *  - If offset > 0 (scrolled back) and baseY grew by N, offset grows by N so
 *    the lines we're viewing keep their absolute position.
 *  - If baseY didn't change or went backwards (shouldn't normally happen),
 *    leave offset alone.
 */
export function adjustScrollOffset(state: ScrollState, currentBaseY: number): ScrollState {
  if (state.offset === 0) {
    return { offset: 0, lastBaseY: currentBaseY };
  }
  const delta = currentBaseY - state.lastBaseY;
  if (delta > 0) {
    return { offset: state.offset + delta, lastBaseY: currentBaseY };
  }
  return { offset: state.offset, lastBaseY: currentBaseY };
}

/** Compute the cursor's effective screen row given the pane's current
 *  scroll offset. The cursor is always in the live viewport; when the
 *  user scrolls back (offset > 0), the cursor moves DOWN on screen by
 *  that amount. If it ends up below `innerHeight`, it's off-screen.
 *
 *  Returns the effective 0-indexed row within the pane's inner area,
 *  or `null` if the cursor is scrolled off-screen and shouldn't be
 *  drawn. */
export function effectiveCursorRow(
  cursorRow: number,
  scrollOffset: number,
  innerHeight: number,
): number | null {
  const effective = cursorRow + scrollOffset;
  if (effective < 0 || effective >= innerHeight) return null;
  return effective;
}
